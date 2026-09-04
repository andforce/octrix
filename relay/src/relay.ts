import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { DeviceToRelayFrame, RelayToDeviceFrame } from './protocol.js';
import { RelayAuthError } from './sms-auth.js';

export interface RelayOptions {
  /** 七天迁移窗口内可选的旧共享 token；新部署通过 authorization 校验持久化凭证。 */
  token?: string;
  authorization?: RelayAuthorization;
  /** 将非隧道路由交给 Octrix Cloud（Fastify）处理。 */
  cloudRequestHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /** 仅兼容期允许 x-relay-token 和 ?token=。 */
  allowLegacyTokenTransports?: boolean;
  /** 旧授权兼容的绝对截止时间；到期后无需重启即可停止接受旧凭证。 */
  legacyAuthUntilMs?: number;
  /** 可选短信验证服务：公开 challenge 接口，验证后签发客户端访问 token */
  smsAuth?: RelaySmsAuth;
  /** 隧道 HTTP 请求超时（默认 210s，需覆盖 iOS 端 180s 慢操作窗口） */
  requestTimeoutMs?: number;
  /** 心跳间隔（默认 30s），两个周期无响应即断开 */
  heartbeatIntervalMs?: number;
  /** 客户端请求体上限（默认 64MB） */
  maxBodyBytes?: number;
  /** 单设备并发 HTTP 隧道请求上限（默认 32） */
  maxPendingRequestsPerDevice?: number;
  /** 单个 WebSocket 连接允许积压的发送缓冲（默认 32MB） */
  maxBufferedBytes?: number;
  /** 单设备客户端 WebSocket 隧道数上限（默认 64） */
  maxClientChannelsPerDevice?: number;
}

export interface RelayActor {
  kind: 'legacy' | 'legacy-client' | 'device' | 'client';
  ownerUserId: string | null;
  externalDeviceId: string | null;
  deviceRecordId: string | null;
  tokenId: string | null;
}

export interface RelayAuthorization {
  authenticate(token: string): {
    kind: 'device' | 'client';
    ownerUserId: string;
    deviceId: string;
    externalDeviceId: string;
    tokenId: string;
  } | null;
  updateConnectedDevice?(actor: {
    kind: 'device' | 'client';
    ownerUserId: string;
    externalDeviceId: string;
    tokenId: string;
    deviceId: string;
  }, name: string): void;
  listDevices?(ownerUserId: string, kind?: 'mac' | 'ios'): Array<{
    external_id: string;
    name: string;
    last_seen_at: string | null;
  }>;
  onTokenRevoked?(listener: (tokenId: string, deviceId: string | null) => void): () => void;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  connectedAt: number | null;
  lastSeenAt: number;
}

export interface RelaySmsAuth {
  isReady(): boolean;
  methods(): unknown;
  isAccessToken(token: string): boolean;
  createChallenge(input: { phone: string; deviceName?: string; clientIp: string }): Promise<unknown>;
  verifyChallenge(input: { challengeId: string; code: string }): Promise<unknown>;
}

interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  ws: WebSocket | null;
  connectedAt: number | null;
  lastSeenAt: number;
  ownerUserId: string | null;
  tokenId: string | null;
}

interface PendingRequest {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  deviceId: string;
  tokenId: string | null;
}

interface Channel {
  clientWs: WebSocket;
  deviceId: string;
  tokenId: string | null;
}

/** 转发时丢弃的请求头（逐跳头 + 中继自身的鉴权信息） */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding',
  'content-length', 'authorization', 'x-relay-token', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'expect',
]);

/** 设备应答中允许透传给客户端的响应头 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type', 'cache-control', 'content-disposition', 'etag', 'last-modified',
]);

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function disabledSmsMethods() {
  return {
    sms: false,
    authentication: 'sms_verification',
    sms_config: { country_code: '+86', code_length: 6, resend_seconds: 60 },
  };
}

function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(new RelayAuthError(413, 'request_body_too_large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RelayAuthError(400, 'invalid_json', '请求体必须是 JSON'));
      }
    });
    req.on('error', error => fail(error));
  });
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  const statusText = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Gateway';
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

export class RelayServer {
  readonly server: Server;
  private readonly tokenDigest: Buffer | null;
  private readonly smsAuth?: RelaySmsAuth;
  private readonly authorization?: RelayAuthorization;
  private readonly cloudRequestHandler?: RelayOptions['cloudRequestHandler'];
  private readonly allowLegacyTokenTransports: boolean;
  private readonly legacyAuthUntilMs: number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxPendingRequestsPerDevice: number;
  private readonly maxBufferedBytes: number;
  private readonly maxClientChannelsPerDevice: number;

  private readonly devices = new Map<string, DeviceRecord>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly channels = new Map<string, Channel>();

  private readonly deviceWss: WebSocketServer;
  private readonly clientWss: WebSocketServer;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly removeRevocationListener?: () => void;

  constructor(options: RelayOptions) {
    if (!options.token && !options.authorization) {
      throw new Error('relay token or authorization center must be configured');
    }
    this.tokenDigest = options.token ? sha256(options.token) : null;
    this.smsAuth = options.smsAuth;
    this.authorization = options.authorization;
    this.cloudRequestHandler = options.cloudRequestHandler;
    this.allowLegacyTokenTransports = options.allowLegacyTokenTransports ?? true;
    this.legacyAuthUntilMs = options.legacyAuthUntilMs ?? Number.POSITIVE_INFINITY;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 210_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024 * 1024;
    this.maxPendingRequestsPerDevice = options.maxPendingRequestsPerDevice ?? 32;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024;
    this.maxClientChannelsPerDevice = options.maxClientChannelsPerDevice ?? 64;

    this.deviceWss = new WebSocketServer({
      noServer: true,
      maxPayload: Math.ceil(this.maxBodyBytes * 4 / 3) + 1024 * 1024,
    });
    this.clientWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(error => this.handleUnexpectedError(res, error));
    });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    this.removeRevocationListener = this.authorization?.onTokenRevoked?.((tokenId, deviceId) => {
      this.disconnectRevokedToken(tokenId, deviceId);
    });

    this.heartbeatTimer = setInterval(() => this.sweepHeartbeats(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const address = this.server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeRevocationListener?.();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (!pending.res.headersSent) jsonResponse(pending.res, 502, { error: 'relay shutting down' });
    }
    for (const channel of this.channels.values()) channel.clientWs.terminate();
    this.channels.clear();
    for (const device of this.devices.values()) device.ws?.terminate();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  listDevices(): DeviceInfo[] {
    return [...this.devices.values()].map(d => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      connected: d.ws !== null && d.ws.readyState === WebSocket.OPEN,
      connectedAt: d.connectedAt,
      lastSeenAt: d.lastSeenAt,
    }));
  }

  listDevicesForOwner(ownerUserId: string): DeviceInfo[] {
    const authorizedDevices = this.authorization?.listDevices?.(ownerUserId, 'mac');
    if (authorizedDevices) {
      return authorizedDevices.map(device => {
        const runtime = this.devices.get(device.external_id);
        const persistedLastSeenAt = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
        return {
          deviceId: device.external_id,
          deviceName: device.name,
          connected: runtime?.ownerUserId === ownerUserId
            && runtime.ws !== null
            && runtime.ws.readyState === WebSocket.OPEN,
          connectedAt: runtime?.ownerUserId === ownerUserId ? runtime.connectedAt : null,
          lastSeenAt: runtime?.ownerUserId === ownerUserId
            ? runtime.lastSeenAt
            : (Number.isFinite(persistedLastSeenAt) ? persistedLastSeenAt : 0),
        };
      });
    }
    return [...this.devices.values()]
      .filter(device => device.ownerUserId === ownerUserId)
      .map(device => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        connected: device.ws !== null && device.ws.readyState === WebSocket.OPEN,
        connectedAt: device.connectedAt,
        lastSeenAt: device.lastSeenAt,
      }));
  }

  // MARK: - 鉴权

  private requestToken(req: IncomingMessage): string {
    const header = req.headers.authorization;
    let token = '';
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    }
    if (!token && this.legacyCompatibilityActive()) {
      const alt = req.headers['x-relay-token'];
      if (typeof alt === 'string') token = alt.trim();
    }
    if (!token && req.url && this.legacyCompatibilityActive()) {
      const url = new URL(req.url, 'http://relay.local');
      token = url.searchParams.get('token') ?? '';
    }
    return token;
  }

  private authorize(req: IncomingMessage): RelayActor | null {
    const candidate = this.requestToken(req);
    if (!candidate) return null;
    const actor = this.authorization?.authenticate(candidate);
    if (actor) return { ...actor, deviceRecordId: actor.deviceId };
    if (this.legacyCompatibilityActive() && this.tokenDigest && timingSafeEqual(sha256(candidate), this.tokenDigest)) {
      this.warnLegacyAccess('shared-token', req);
      return { kind: 'legacy', ownerUserId: null, externalDeviceId: null, deviceRecordId: null, tokenId: null };
    }
    if (this.legacyCompatibilityActive() && this.smsAuth?.isAccessToken(candidate)) {
      this.warnLegacyAccess('sms-token', req);
      return { kind: 'legacy-client', ownerUserId: null, externalDeviceId: null, deviceRecordId: null, tokenId: null };
    }
    return null;
  }

  // MARK: - HTTP 入口

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const rawUrl = req.url ?? '/';
    const pathname = new URL(rawUrl, 'http://relay.local').pathname;

    const isRelayPath = pathname === '/api/devices' || pathname.startsWith('/d/');
    if (this.cloudRequestHandler && !isRelayPath) {
      await this.cloudRequestHandler(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      jsonResponse(res, 200, { ok: true, devices: this.listDevices().filter(d => d.connected).length });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/auth/methods') {
      jsonResponse(res, 200, this.smsAuth?.methods() ?? disabledSmsMethods());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/auth/sms/challenges') {
      await this.handleSmsChallenge(req, res);
      return;
    }

    const verifyMatch = pathname.match(/^\/api\/v1\/auth\/sms\/challenges\/([^/]+)\/verify$/);
    if (req.method === 'POST' && verifyMatch) {
      await this.handleSmsVerify(req, res, decodeURIComponent(verifyMatch[1]));
      return;
    }

    const actor = this.authorize(req);
    if (!actor || actor.kind === 'device') {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/devices') {
      jsonResponse(res, 200, {
        devices: actor.ownerUserId ? this.listDevicesForOwner(actor.ownerUserId) : this.listDevices(),
      });
      return;
    }

    const tunnel = this.parseTunnelPath(rawUrl);
    if (tunnel) {
      const device = this.devices.get(tunnel.deviceId);
      if (actor.ownerUserId && device?.ownerUserId !== actor.ownerUserId) {
        jsonResponse(res, 404, { error: 'device not found' });
        return;
      }
      this.forwardHttp(req, res, tunnel.deviceId, tunnel.forwardPath, actor.tokenId);
      return;
    }

    jsonResponse(res, 404, { error: 'not found' });
  }

  private async handleSmsChallenge(req: IncomingMessage, res: ServerResponse) {
    if (!this.smsAuth) {
      req.resume();
      jsonResponse(res, 503, { error: 'sms_not_configured', message: '短信验证尚未配置' });
      return;
    }
    try {
      const payload = await readJsonBody(req, 16 * 1024);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new RelayAuthError(400, 'invalid_request', '请求参数无效');
      }
      const body = payload as { phone?: unknown; device_name?: unknown; deviceName?: unknown };
      if (typeof body.phone !== 'string') {
        throw new RelayAuthError(400, 'invalid_request', '手机号不能为空');
      }
      const rawDeviceName = typeof body.device_name === 'string'
        ? body.device_name
        : typeof body.deviceName === 'string' ? body.deviceName : undefined;
      const result = await this.smsAuth.createChallenge({
        phone: body.phone,
        deviceName: rawDeviceName,
        clientIp: this.clientIp(req),
      });
      jsonResponse(res, 201, result);
    } catch (error) {
      this.handleAuthRouteError(res, error);
    }
  }

  private async handleSmsVerify(req: IncomingMessage, res: ServerResponse, challengeId: string) {
    if (!this.smsAuth) {
      req.resume();
      jsonResponse(res, 503, { error: 'sms_not_configured', message: '短信验证尚未配置' });
      return;
    }
    try {
      const payload = await readJsonBody(req, 16 * 1024);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new RelayAuthError(400, 'invalid_request', '请求参数无效');
      }
      const code = (payload as { code?: unknown }).code;
      if (typeof code !== 'string') {
        throw new RelayAuthError(400, 'invalid_request', '验证码不能为空');
      }
      const result = await this.smsAuth.verifyChallenge({ challengeId, code }) as Record<string, unknown>;
      jsonResponse(res, 200, { ...result, devices: this.listDevices() });
    } catch (error) {
      this.handleAuthRouteError(res, error);
    }
  }

  private clientIp(req: IncomingMessage): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstForwarded = value?.split(',')[0]?.trim();
    return firstForwarded || req.socket.remoteAddress || 'unknown';
  }

  private handleAuthRouteError(res: ServerResponse, error: unknown) {
    if (res.headersSent) return;
    if (error instanceof RelayAuthError) {
      jsonResponse(res, error.statusCode, {
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
      return;
    }
    console.error('[relay] 短信验证接口失败:', error);
    jsonResponse(res, 500, { error: 'internal_error', message: '服务器暂时不可用' });
  }

  private handleUnexpectedError(res: ServerResponse, error: unknown) {
    if (res.headersSent) return;
    console.error('[relay] 请求处理失败:', error);
    jsonResponse(res, 500, { error: 'internal_error' });
  }

  /** /d/:deviceId/<path> → { deviceId, forwardPath(含查询串) } */
  private parseTunnelPath(rawUrl: string): { deviceId: string; forwardPath: string } | null {
    if (!rawUrl.startsWith('/d/')) return null;
    if (/[\r\n]/.test(rawUrl)) return null;
    const rest = rawUrl.slice(3);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const deviceId = decodeURIComponent(rest.slice(0, slash));
    // 去掉转发路径查询串中的中继 token，避免泄漏给本地服务日志
    const forwardUrl = new URL(rest.slice(slash), 'http://device.local');
    forwardUrl.searchParams.delete('token');
    const forwardPath = forwardUrl.pathname + forwardUrl.search;
    if (!deviceId || !forwardPath.startsWith('/')) return null;
    return { deviceId, forwardPath };
  }

  private forwardHttp(req: IncomingMessage, res: ServerResponse, deviceId: string, forwardPath: string, tokenId: string | null) {
    const device = this.devices.get(deviceId);
    if (!device?.ws || device.ws.readyState !== WebSocket.OPEN) {
      jsonResponse(res, 502, { error: `device "${deviceId}" is not connected` });
      return;
    }
    if (this.pendingCountForDevice(deviceId) >= this.maxPendingRequestsPerDevice) {
      jsonResponse(res, 503, { error: `device "${deviceId}" is busy` });
      req.resume();
      return;
    }
    if (device.ws.bufferedAmount > this.maxBufferedBytes) {
      jsonResponse(res, 503, { error: `device "${deviceId}" tunnel is congested` });
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        aborted = true;
        if (!res.headersSent) jsonResponse(res, 413, { error: 'request body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const currentDevice = this.devices.get(deviceId);
      if (!currentDevice?.ws || currentDevice.ws.readyState !== WebSocket.OPEN) {
        jsonResponse(res, 502, { error: `device "${deviceId}" is not connected` });
        return;
      }
      if (this.pendingCountForDevice(deviceId) >= this.maxPendingRequestsPerDevice) {
        jsonResponse(res, 503, { error: `device "${deviceId}" is busy` });
        return;
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (STRIPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('sec-')) continue;
        if (typeof value === 'string') headers[lower] = value;
        else if (Array.isArray(value)) headers[lower] = value.join(', ');
      }

      const id = randomUUID();
      const frame: RelayToDeviceFrame = {
        t: 'http',
        id,
        method: req.method ?? 'GET',
        path: forwardPath,
        headers,
        ...(chunks.length > 0 ? { bodyB64: Buffer.concat(chunks).toString('base64') } : {}),
      };

      const payload = JSON.stringify(frame);
      if (currentDevice.ws.bufferedAmount + Buffer.byteLength(payload) > this.maxBufferedBytes) {
        jsonResponse(res, 503, { error: `device "${deviceId}" tunnel is congested` });
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!res.headersSent) jsonResponse(res, 504, { error: 'device did not respond in time' });
      }, this.requestTimeoutMs);
      this.pending.set(id, { res, timer, deviceId, tokenId });
      res.on('close', () => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
      });

      try {
        currentDevice.ws.send(payload, error => {
          if (!error) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          if (!entry.res.headersSent) jsonResponse(entry.res, 502, { error: 'failed to reach device' });
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        if (!res.headersSent) jsonResponse(res, 502, { error: 'failed to reach device' });
      }
    });

    req.on('error', () => {
      aborted = true;
    });
  }

  // MARK: - WebSocket 升级入口

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://relay.local');
    const auth = this.authorize(req);

    if (!auth) {
      rejectUpgrade(socket, 401, 'unauthorized');
      return;
    }

    if (url.pathname === '/device/ws') {
      if (auth.kind !== 'legacy' && auth.kind !== 'device') {
        rejectUpgrade(socket, 401, 'unauthorized');
        return;
      }
      const deviceId = url.searchParams.get('deviceId')?.trim() ?? '';
      const deviceName = url.searchParams.get('deviceName')?.trim() || deviceId;
      if (!deviceId) {
        rejectUpgrade(socket, 404, 'deviceId required');
        return;
      }
      if (auth.kind === 'device' && auth.externalDeviceId !== deviceId) {
        rejectUpgrade(socket, 401, 'deviceId does not match authorization');
        return;
      }
      this.deviceWss.handleUpgrade(req, socket, head, ws => {
        this.registerDevice(deviceId, deviceName, ws, auth);
      });
      return;
    }

    const tunnel = this.parseTunnelPath(rawUrl);
    if (tunnel && tunnel.forwardPath.split('?')[0] === '/ws') {
      if (auth.kind === 'device') {
        rejectUpgrade(socket, 401, 'unauthorized');
        return;
      }
      const device = this.devices.get(tunnel.deviceId);
      if (!device?.ws || device.ws.readyState !== WebSocket.OPEN) {
        rejectUpgrade(socket, 502, `device "${tunnel.deviceId}" is not connected`);
        return;
      }
      if (auth.ownerUserId && device.ownerUserId !== auth.ownerUserId) {
        rejectUpgrade(socket, 404, 'device not found');
        return;
      }
      this.clientWss.handleUpgrade(req, socket, head, ws => {
        this.registerClientChannel(tunnel.deviceId, ws, tunnel.forwardPath, auth);
      });
      return;
    }

    rejectUpgrade(socket, 404, 'not found');
  }

  // MARK: - 设备连接

  private registerDevice(deviceId: string, deviceName: string, ws: WebSocket, actor: RelayActor) {
    const existing = this.devices.get(deviceId);
    if (existing?.ws && existing.ws !== ws) {
      // 同一设备重连：静默替换旧连接，避免旧连接的 close 回调清理新状态
      existing.ws.removeAllListeners();
      existing.ws.terminate();
      this.dropDeviceTraffic(deviceId, '重复连接被替换');
    }

    const record: DeviceRecord = {
      deviceId,
      deviceName,
      ws,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      ownerUserId: actor.ownerUserId,
      tokenId: actor.tokenId,
    };
    this.devices.set(deviceId, record);
    if (actor.kind === 'device' && actor.ownerUserId && actor.externalDeviceId && actor.deviceRecordId && actor.tokenId) {
      this.authorization?.updateConnectedDevice?.({
        kind: 'device',
        ownerUserId: actor.ownerUserId,
        externalDeviceId: actor.externalDeviceId,
        tokenId: actor.tokenId,
        deviceId: actor.deviceRecordId,
      }, deviceName);
    }

    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      const current = this.devices.get(deviceId);
      if (current?.ws === ws) current.lastSeenAt = Date.now();
    });

    ws.on('message', raw => {
      const current = this.devices.get(deviceId);
      if (current?.ws !== ws) return;
      current.lastSeenAt = Date.now();
      let frame: DeviceToRelayFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleDeviceFrame(deviceId, frame);
    });

    ws.on('close', () => {
      const current = this.devices.get(deviceId);
      if (current?.ws !== ws) return;
      current.ws = null;
      current.connectedAt = null;
      this.dropDeviceTraffic(deviceId, 'device disconnected');
    });

    ws.on('error', () => ws.terminate());
  }

  private handleDeviceFrame(deviceId: string, frame: DeviceToRelayFrame) {
    switch (frame.t) {
      case 'http-res': {
        const entry = this.pending.get(frame.id);
        if (!entry || entry.deviceId !== deviceId) return;
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        if (entry.res.headersSent) return;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(frame.headers ?? {})) {
          if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
        }
        const body = frame.bodyB64 ? Buffer.from(frame.bodyB64, 'base64') : Buffer.alloc(0);
        headers['content-length'] = String(body.length);
        entry.res.writeHead(frame.status, headers);
        entry.res.end(body);
        return;
      }
      case 'ws-msg': {
        const channel = this.channels.get(frame.ch);
        if (!channel || channel.deviceId !== deviceId) return;
        if (channel.clientWs.readyState === WebSocket.OPEN) {
          if (channel.clientWs.bufferedAmount + Buffer.byteLength(frame.data) > this.maxBufferedBytes) {
            this.closeClientChannel(frame.ch, channel, 1013, 'client tunnel congested');
            return;
          }
          channel.clientWs.send(frame.data);
        }
        return;
      }
      case 'ws-close': {
        const channel = this.channels.get(frame.ch);
        if (!channel || channel.deviceId !== deviceId) return;
        this.channels.delete(frame.ch);
        channel.clientWs.close(1000, 'closed by device');
        return;
      }
    }
  }

  /** 设备断开后：挂起请求回 502，虚拟通道全部关闭 */
  private dropDeviceTraffic(deviceId: string, reason: string) {
    for (const [id, entry] of this.pending) {
      if (entry.deviceId !== deviceId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (!entry.res.headersSent) jsonResponse(entry.res, 502, { error: reason });
    }
    for (const [ch, channel] of this.channels) {
      if (channel.deviceId !== deviceId) continue;
      this.channels.delete(ch);
      channel.clientWs.close(1001, reason);
    }
  }

  // MARK: - 客户端虚拟通道

  private registerClientChannel(deviceId: string, clientWs: WebSocket, path: string, actor: RelayActor) {
    const device = this.devices.get(deviceId);
    if (!device?.ws || device.ws.readyState !== WebSocket.OPEN) {
      clientWs.close(1001, 'device disconnected');
      return;
    }
    if (this.channelCountForDevice(deviceId) >= this.maxClientChannelsPerDevice) {
      clientWs.close(1013, 'too many channels');
      return;
    }
    if (device.ws.bufferedAmount > this.maxBufferedBytes) {
      clientWs.close(1013, 'device tunnel congested');
      return;
    }

    const ch = randomUUID();
    this.channels.set(ch, { clientWs, deviceId, tokenId: actor.tokenId });

    (clientWs as WebSocket & { isAlive?: boolean }).isAlive = true;
    clientWs.on('pong', () => {
      (clientWs as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    const sendToDevice = (frame: RelayToDeviceFrame): boolean => {
      const current = this.devices.get(deviceId);
      if (!current?.ws || current.ws.readyState !== WebSocket.OPEN) return false;
      const payload = JSON.stringify(frame);
      if (current.ws.bufferedAmount + Buffer.byteLength(payload) > this.maxBufferedBytes) return false;
      try {
        current.ws.send(payload);
        return true;
      } catch {
        return false;
      }
    };

    if (!sendToDevice({ t: 'ws-open', ch, path })) {
      this.channels.delete(ch);
      clientWs.close(1001, 'device disconnected');
      return;
    }

    clientWs.on('message', raw => {
      if (!this.channels.has(ch)) return;
      if (!sendToDevice({ t: 'ws-msg', ch, data: raw.toString() })) {
        this.channels.delete(ch);
        clientWs.close(1001, 'device disconnected');
      }
    });

    clientWs.on('close', () => {
      if (!this.channels.has(ch)) return;
      this.channels.delete(ch);
      sendToDevice({ t: 'ws-close', ch });
    });

    clientWs.on('error', () => clientWs.terminate());
  }

  // MARK: - 心跳

  private sweepHeartbeats() {
    const sweep = (ws: WebSocket) => {
      const marked = ws as WebSocket & { isAlive?: boolean };
      if (ws.bufferedAmount > this.maxBufferedBytes * 2) {
        ws.terminate();
        return;
      }
      if (marked.isAlive === false) {
        ws.terminate();
        return;
      }
      marked.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    };
    for (const device of this.devices.values()) {
      if (device.ws) sweep(device.ws);
    }
    for (const channel of this.channels.values()) {
      sweep(channel.clientWs);
    }
  }

  private pendingCountForDevice(deviceId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.deviceId === deviceId) count++;
    }
    return count;
  }

  private channelCountForDevice(deviceId: string): number {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (channel.deviceId === deviceId) count++;
    }
    return count;
  }

  private closeClientChannel(ch: string, channel: Channel, code: number, reason: string) {
    this.channels.delete(ch);
    channel.clientWs.close(code, reason);
  }

  private disconnectRevokedToken(tokenId: string, _deviceId: string | null): void {
    for (const [externalDeviceId, device] of this.devices) {
      if (device.tokenId !== tokenId) continue;
      this.dropDeviceTraffic(externalDeviceId, 'authorization revoked');
      device.ws?.close(1008, 'authorization revoked');
      this.devices.delete(externalDeviceId);
    }
    for (const [channelId, channel] of this.channels) {
      if (channel.tokenId !== tokenId) continue;
      this.closeClientChannel(channelId, channel, 1008, 'authorization revoked');
    }
    for (const [requestId, pending] of this.pending) {
      if (pending.tokenId !== tokenId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (!pending.res.headersSent) jsonResponse(pending.res, 401, { error: 'authorization revoked' });
    }
  }

  private legacyCompatibilityActive(): boolean {
    return this.allowLegacyTokenTransports && Date.now() < this.legacyAuthUntilMs;
  }

  private warnLegacyAccess(kind: 'shared-token' | 'sms-token', req: IncomingMessage): void {
    const pathname = new URL(req.url ?? '/', 'http://relay.local').pathname;
    const route = pathname.startsWith('/d/') ? '/d/:deviceId/*' : pathname;
    console.warn(`[octrix-cloud][legacy-auth] 接受迁移期旧授权 kind=${kind} route=${route}`);
  }
}
