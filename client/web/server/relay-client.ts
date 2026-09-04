import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import { defaultRelayCredentialStore, type RelayCredentialStore } from './relay-credentials.js';

/**
 * 中继隧道协议帧（与 relay/src/protocol.ts 保持镜像一致）。
 */
interface HttpRequestFrame {
  t: 'http';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64?: string;
}

interface HttpResponseFrame {
  t: 'http-res';
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64?: string;
}

interface WsOpenFrame { t: 'ws-open'; ch: string; path?: string }
interface WsMessageFrame { t: 'ws-msg'; ch: string; data: string }
interface WsCloseFrame { t: 'ws-close'; ch: string }

type RelayToDeviceFrame = HttpRequestFrame | WsOpenFrame | WsMessageFrame | WsCloseFrame;
type DeviceToRelayFrame = HttpResponseFrame | WsMessageFrame | WsCloseFrame;

export interface RelayConfig {
  enabled: boolean;
  /** 中继服务地址，如 https://relay.example.com（http/ws 前缀也接受） */
  url: string;
  deviceId: string;
  deviceName: string;
  authorized: boolean;
  accountLabel?: string;
}

export interface RelayStatus {
  enabled: boolean;
  url: string;
  deviceId: string;
  deviceName: string;
  authorized: boolean;
  accountLabel?: string;
  authorizationState: 'signed_out' | 'pending' | 'authorized';
  verificationUri?: string;
  userCode?: string;
  authorizationExpiresAt?: string;
  connected: boolean;
  lastError?: string;
  lastConnectedAt?: number;
}

interface StoredRelayConfig {
  enabled: boolean;
  url: string;
  deviceId: string;
  deviceName: string;
  accountLabel?: string;
  authorizationVersion?: 1;
}

interface PendingAuthorization {
  pollToken: string;
  verificationUri: string;
  userCode?: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface RelayAuthorizationStart {
  authorizationState: 'pending';
  verificationUri: string;
  userCode?: string;
  expiresAt: string;
  interval: number;
}

interface RelayClientLockFile {
  pid: number;
  instanceId: string;
  deviceId: string;
  url: string;
  cwd: string;
  acquiredAt: number;
}

/** 本地服务响应中不透传回中继的头（fetch 已解压/分块，这些头不再成立） */
const STRIPPED_LOCAL_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
]);

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_STALE_MS = 70_000;
const LOCAL_HTTP_TIMEOUT_MS = 200_000;
const MAX_LOCAL_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_WS_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_RELAY_SEND_BUFFER_BYTES = 32 * 1024 * 1024;
const OCTRIX_CLOUD_URL = 'https://octrix.work';

function configuredCloudUrl(): string | null {
  const raw = process.env.OCTRIX_CLOUD_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OCTRIX_CLOUD_URL 必须是有效的 HTTPS 地址');
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('OCTRIX_CLOUD_URL 必须使用 HTTPS（仅本机回环调试可使用 HTTP）');
  }
  if (url.username || url.password) throw new Error('OCTRIX_CLOUD_URL 不能包含用户名或密码');
  return url.toString().replace(/\/+$/, '');
}

interface LocalChannel {
  ws: WebSocket;
  /** 本地 /ws 尚在握手时，暂存中继侧到达的消息 */
  pendingToLocal: string[];
  pendingBytes: number;
}

class LocalResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`本地服务响应超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
  }
}

class CloudRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * 设备端中继客户端：从 Mac 主动出站连接中继服务器，
 * 把中继转发来的 HTTP/WS 流量回放到本地 CLI Bridge 服务上，
 * 使 iOS 等远端客户端无需公网直连本机。
 */
export class RelayClient {
  private readonly localPort: number;
  private readonly configPath: string;
  private readonly lockPath: string;
  private readonly credentials: RelayCredentialStore;
  private readonly instanceId = randomUUID();
  private config: StoredRelayConfig;
  private pendingAuthorization: PendingAuthorization | null = null;
  private authorizationTimer: NodeJS.Timeout | null = null;
  private authorizationGeneration = 0;

  private ws: WebSocket | null = null;
  private channels = new Map<string, LocalChannel>();
  private connected = false;
  private lastError: string | undefined;
  private lastConnectedAt: number | undefined;

  /** start/stop 世代号，旧连接的异步回调据此失效 */
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private lockHeld = false;

  onStatusChange?: (status: RelayStatus) => void;

  constructor(localPort: number, configPath?: string, credentials?: RelayCredentialStore) {
    this.localPort = localPort;
    this.configPath = configPath ?? path.join(os.homedir(), '.cli-bridge', 'relay.json');
    this.lockPath = path.join(path.dirname(this.configPath), 'relay-client.lock');
    this.credentials = credentials ?? defaultRelayCredentialStore(configPath);
    this.config = this.loadConfig();
  }

  // MARK: - 配置

  private defaultConfig(): StoredRelayConfig {
    return {
      enabled: false,
      url: configuredCloudUrl() ?? OCTRIX_CLOUD_URL,
      deviceId: randomUUID(),
      deviceName: os.hostname(),
    };
  }

  private loadConfig(): StoredRelayConfig {
    const defaults = this.defaultConfig();
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as Partial<StoredRelayConfig> & { token?: unknown };
      const merged: StoredRelayConfig = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
        url: typeof raw.url === 'string' ? raw.url : defaults.url,
        deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : defaults.deviceId,
        deviceName: typeof raw.deviceName === 'string' && raw.deviceName ? raw.deviceName : defaults.deviceName,
        accountLabel: typeof raw.accountLabel === 'string' ? raw.accountLabel : undefined,
        authorizationVersion: raw.authorizationVersion === 1 ? 1 : undefined,
      };
      let shouldPersist = !raw.deviceId || 'token' in raw;
      let storedCredential = this.credentials.read(merged.deviceId);
      const environmentUrl = configuredCloudUrl();
      const hasInlineLegacyToken = typeof raw.token === 'string' && Boolean(raw.token.trim());
      if (environmentUrl && environmentUrl !== merged.url) {
        // 环境变量代表安装器或管理员明确切换了云端地址；旧服务器的凭证绝不能跨域复用。
        this.credentials.delete(merged.deviceId);
        storedCredential = null;
        merged.url = environmentUrl;
        merged.enabled = false;
        merged.accountLabel = undefined;
        merged.authorizationVersion = undefined;
        shouldPersist = true;
      } else if (hasInlineLegacyToken || (storedCredential && !merged.authorizationVersion && !merged.accountLabel)) {
        this.credentials.delete(merged.deviceId);
        storedCredential = null;
        merged.enabled = false;
        merged.accountLabel = undefined;
        merged.authorizationVersion = undefined;
        shouldPersist = true;
      } else if (storedCredential && !merged.authorizationVersion && merged.accountLabel) {
        // 兼容统一授权中心初版签发、但尚未写入版本标记的账号设备凭证。
        merged.authorizationVersion = 1;
        shouldPersist = true;
      }
      if (!storedCredential && merged.enabled) {
        merged.enabled = false;
        merged.accountLabel = undefined;
        merged.authorizationVersion = undefined;
        shouldPersist = true;
      }
      if (shouldPersist) this.persist(merged);
      return merged;
    } catch {
      return defaults;
    }
  }

  private persist(config: StoredRelayConfig) {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (error) {
      console.error('[relay-client] 配置写入失败:', error);
    }
  }

  getConfig(): RelayConfig {
    const { authorizationVersion: _authorizationVersion, ...config } = this.config;
    return { ...config, authorized: Boolean(this.credentials.read(this.config.deviceId)) };
  }

  getStatus(): RelayStatus {
    return {
      enabled: this.config.enabled,
      url: this.config.url,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      authorized: Boolean(this.credentials.read(this.config.deviceId)),
      accountLabel: this.config.accountLabel,
      authorizationState: this.pendingAuthorization ? 'pending' : this.credentials.read(this.config.deviceId) ? 'authorized' : 'signed_out',
      verificationUri: this.pendingAuthorization?.verificationUri,
      userCode: this.pendingAuthorization?.userCode,
      authorizationExpiresAt: this.pendingAuthorization?.expiresAt,
      connected: this.connected,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
    };
  }

  /** 更新配置并按需重连；deviceId 由本机生成，不可外部修改 */
  updateConfig(patch: Partial<Pick<RelayConfig, 'enabled' | 'url' | 'deviceName'>>): RelayStatus {
    const next: StoredRelayConfig = {
      ...this.config,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.url !== undefined ? { url: patch.url.trim() } : {}),
      ...(patch.deviceName !== undefined && patch.deviceName.trim()
        ? { deviceName: patch.deviceName.trim() }
        : {}),
    };
    if (next.enabled && (!next.url || !this.credentials.read(next.deviceId))) {
      throw new Error('请先登录 Octrix 账号再启用云端连接');
    }
    this.config = next;
    this.persist(next);
    this.lastError = undefined;

    this.stopInternal();
    if (next.enabled) this.start();
    this.notifyStatus();
    return this.getStatus();
  }

  async beginAuthorization(mode: 'browser' | 'device_code'): Promise<RelayAuthorizationStart> {
    this.cancelAuthorization();
    const response = await fetch(`${this.config.url.replace(/\/+$/, '')}/api/v1/device-authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: mode === 'device_code' ? 'device' : 'browser',
        device_id: this.config.deviceId,
        device_name: this.config.deviceName,
      }),
    });
    const payload = await this.readCloudResponse<{
      poll_token: string; verification_uri: string; browser_url?: string;
      user_code?: string; expires_at: string; interval: number;
    }>(response);
    this.pendingAuthorization = {
      pollToken: payload.poll_token,
      verificationUri: payload.verification_uri,
      userCode: payload.user_code,
      expiresAt: payload.expires_at,
      intervalSeconds: payload.interval,
    };
    const generation = ++this.authorizationGeneration;
    if (mode === 'browser' && payload.browser_url) this.openExternal(payload.browser_url);
    this.scheduleAuthorizationPoll(generation, 0);
    this.notifyStatus();
    return {
      authorizationState: 'pending',
      verificationUri: payload.verification_uri,
      userCode: payload.user_code,
      expiresAt: payload.expires_at,
      interval: payload.interval,
    };
  }

  async logout(): Promise<RelayStatus> {
    this.cancelAuthorization();
    const token = this.credentials.read(this.config.deviceId);
    if (token) {
      try {
        await fetch(`${this.config.url.replace(/\/+$/, '')}/api/v1/device/token/revoke`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        // 本地退出必须始终成功；服务端不可达时令牌仍从本机删除。
      }
    }
    this.credentials.delete(this.config.deviceId);
    this.config = { ...this.config, enabled: false, accountLabel: undefined, authorizationVersion: undefined };
    this.persist(this.config);
    this.stopInternal();
    this.lastError = undefined;
    this.notifyStatus();
    return this.getStatus();
  }

  // MARK: - 连接管理

  start() {
    if (!this.config.enabled || !this.config.url || !this.credentials.read(this.config.deviceId)) return;
    this.stopInternal();
    this.generation++;
    this.reconnectAttempts = 0;
    const gen = this.generation;
    if (!this.acquireProcessLock()) {
      this.scheduleStartRetry(gen);
      this.notifyStatus();
      return;
    }
    this.connect(gen);
  }

  stop() {
    this.stopInternal();
    this.notifyStatus();
  }

  private stopInternal() {
    this.generation++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.removeAllListeners();
      // ws 在握手阶段 terminate 会异步触发 error；关闭流程必须自行消费它。
      socket.on('error', () => {});
      socket.terminate();
    }
    this.closeAllChannels();
    this.connected = false;
    this.releaseProcessLock();
  }

  private cancelAuthorization() {
    this.authorizationGeneration++;
    if (this.authorizationTimer) {
      clearTimeout(this.authorizationTimer);
      this.authorizationTimer = null;
    }
    this.pendingAuthorization = null;
  }

  private scheduleAuthorizationPoll(generation: number, delayMs: number) {
    if (generation !== this.authorizationGeneration || !this.pendingAuthorization) return;
    this.authorizationTimer = setTimeout(() => {
      this.authorizationTimer = null;
      void this.pollAuthorization(generation);
    }, delayMs);
    this.authorizationTimer.unref?.();
  }

  private async pollAuthorization(generation: number) {
    const pending = this.pendingAuthorization;
    if (!pending || generation !== this.authorizationGeneration) return;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingAuthorization = null;
      this.lastError = '设备授权请求已过期，请重新登录';
      this.notifyStatus();
      return;
    }
    try {
      const response = await fetch(`${this.config.url.replace(/\/+$/, '')}/api/v1/device-authorizations/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poll_token: pending.pollToken }),
      });
      if (response.status === 202) {
        this.lastError = undefined;
        this.scheduleAuthorizationPoll(generation, pending.intervalSeconds * 1000);
        return;
      }
      const payload = await this.readCloudResponse<{
        access_token: string; server_url: string;
        user?: { primary_label?: string };
      }>(response);
      if (generation !== this.authorizationGeneration) return;
      this.credentials.write(this.config.deviceId, payload.access_token);
      this.config = {
        ...this.config,
        enabled: true,
        url: payload.server_url || this.config.url,
        accountLabel: payload.user?.primary_label,
        authorizationVersion: 1,
      };
      this.persist(this.config);
      this.pendingAuthorization = null;
      this.lastError = undefined;
      this.start();
      this.notifyStatus();
    } catch (error) {
      if (generation !== this.authorizationGeneration) return;
      if (error instanceof CloudRequestError
        && error.statusCode >= 400 && error.statusCode < 500
        && error.statusCode !== 429) {
        this.pendingAuthorization = null;
        this.lastError = error.message;
        this.notifyStatus();
        return;
      }
      this.lastError = error instanceof Error ? error.message : '授权中心暂时不可用';
      this.scheduleAuthorizationPoll(generation, pending.intervalSeconds * 1000);
      this.notifyStatus();
    }
  }

  private async readCloudResponse<T>(response: Response): Promise<T> {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      throw new CloudRequestError(
        payload?.error?.message || `授权中心返回 HTTP ${response.status}`,
        response.status,
        payload?.error?.code,
      );
    }
    return payload as T;
  }

  private openExternal(url: string) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    execFile(command, [url], { windowsHide: true }, error => {
      if (!error) return;
      this.lastError = `无法自动打开浏览器，请手动访问 ${url}`;
      this.notifyStatus();
    });
  }

  private scheduleStartRetry(gen: number) {
    if (gen !== this.generation || !this.config.enabled || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.generation || !this.config.enabled) return;
      if (!this.acquireProcessLock()) {
        this.scheduleStartRetry(gen);
        this.notifyStatus();
        return;
      }
      this.reconnectAttempts = 0;
      this.connect(gen);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private acquireProcessLock(): boolean {
    if (this.lockHeld) return true;
    const payload: RelayClientLockFile = {
      pid: process.pid,
      instanceId: this.instanceId,
      deviceId: this.config.deviceId,
      url: this.config.url,
      cwd: process.cwd(),
      acquiredAt: Date.now(),
    };

    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      this.writeLockFile(payload, 'wx');
      this.lockHeld = true;
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {
        this.lastError = error instanceof Error ? `中继连接锁创建失败：${error.message}` : '中继连接锁创建失败';
        return false;
      }
    }

    const existing = this.readLockFile();
    if (existing && existing.pid === process.pid && existing.instanceId === this.instanceId) {
      this.lockHeld = true;
      return true;
    }
    if (existing && this.isProcessAlive(existing.pid)) {
      this.lastError = `中继已由本机另一个 Octrix 服务进程连接（pid=${existing.pid}）`;
      return false;
    }

    try {
      fs.rmSync(this.lockPath, { force: true });
      this.writeLockFile(payload, 'wx');
      this.lockHeld = true;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? `中继连接锁获取失败：${error.message}` : '中继连接锁获取失败';
      return false;
    }
  }

  private writeLockFile(payload: RelayClientLockFile, flag: 'w' | 'wx') {
    fs.writeFileSync(this.lockPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag,
    });
  }

  private readLockFile(): RelayClientLockFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8')) as Partial<RelayClientLockFile>;
      if (
        typeof raw.pid === 'number'
        && typeof raw.instanceId === 'string'
        && typeof raw.deviceId === 'string'
      ) {
        return {
          pid: raw.pid,
          instanceId: raw.instanceId,
          deviceId: raw.deviceId,
          url: typeof raw.url === 'string' ? raw.url : '',
          cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
          acquiredAt: typeof raw.acquiredAt === 'number' ? raw.acquiredAt : 0,
        };
      }
    } catch { /* stale or malformed lock; caller may replace it */ }
    return null;
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === 'EPERM';
    }
  }

  private releaseProcessLock() {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const existing = this.readLockFile();
    if (existing?.pid === process.pid && existing.instanceId === this.instanceId) {
      try {
        fs.rmSync(this.lockPath, { force: true });
      } catch { /* best effort */ }
    }
  }

  private deviceWsUrl(): string {
    let raw = this.config.url;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
    const url = new URL(raw);
    url.protocol = (url.protocol === 'http:' || url.protocol === 'ws:') ? 'ws:' : 'wss:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/device/ws`;
    url.search = '';
    url.searchParams.set('deviceId', this.config.deviceId);
    url.searchParams.set('deviceName', this.config.deviceName);
    return url.toString();
  }

  private connect(gen: number) {
    if (gen !== this.generation) return;

    const token = this.credentials.read(this.config.deviceId);
    if (!token) {
      this.lastError = 'Octrix 授权已退出，请重新登录';
      this.connected = false;
      this.notifyStatus();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.deviceWsUrl(), {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: 256 * 1024 * 1024,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(gen);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (gen !== this.generation) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastError = undefined;
      this.lastConnectedAt = Date.now();
      this.lastPongAt = Date.now();
      this.startHeartbeat(gen);
      console.log(`[relay-client] 已连接中继 ${this.config.url}（deviceId=${this.config.deviceId}）`);
      this.notifyStatus();
    });

    ws.on('pong', () => {
      if (gen !== this.generation) return;
      this.lastPongAt = Date.now();
    });

    ws.on('message', raw => {
      if (gen !== this.generation) return;
      let frame: RelayToDeviceFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on('unexpected-response', (_req, res) => {
      if (gen !== this.generation) return;
      if (res.statusCode === 401) this.clearRevokedAuthorization('Octrix 授权已失效，请重新登录');
      else this.lastError = `中继握手失败：HTTP ${res.statusCode}`;
      ws.terminate();
    });

    ws.on('error', error => {
      if (gen !== this.generation) return;
      if (!this.lastError) this.lastError = error.message;
    });

    ws.on('close', (code, reasonBuffer) => {
      if (gen !== this.generation) return;
      const reason = reasonBuffer.toString();
      if (code === 1008) this.clearRevokedAuthorization('Octrix 授权已被撤销，请重新登录');
      if (this.config.enabled && code !== 1000 && !this.lastError) {
        this.lastError = reason ? `中继连接关闭：${code} ${reason}` : `中继连接关闭：${code}`;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      this.stopHeartbeat();
      this.closeAllChannels();
      if (wasConnected) {
        const detail = reason ? `（code=${code}, reason=${reason}）` : `（code=${code}）`;
        console.log(`[relay-client] 与中继连接断开${detail}，准备重连`);
      }
      this.notifyStatus();
      this.scheduleReconnect(gen);
    });
  }

  private scheduleReconnect(gen: number) {
    if (gen !== this.generation || !this.config.enabled) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(gen);
    }, delay);
  }

  private clearRevokedAuthorization(message: string) {
    this.cancelAuthorization();
    this.credentials.delete(this.config.deviceId);
    this.config = { ...this.config, enabled: false, accountLabel: undefined, authorizationVersion: undefined };
    this.persist(this.config);
    this.lastError = message;
  }

  private startHeartbeat(gen: number) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.generation || !this.ws) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_STALE_MS) {
        this.lastError = '中继心跳超时';
        this.ws.terminate();
        return;
      }
      try {
        this.ws.ping();
      } catch { /* 连接已坏，交给 close 处理 */ }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private notifyStatus() {
    this.onStatusChange?.(this.getStatus());
  }

  private sendFrame(frame: DeviceToRelayFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(frame);
      if (this.ws.bufferedAmount + Buffer.byteLength(payload) > MAX_RELAY_SEND_BUFFER_BYTES) {
        this.lastError = '中继发送缓冲过大，已主动重连';
        this.ws.terminate();
        return;
      }
      this.ws.send(payload, error => {
        if (!error || !this.ws) return;
        this.lastError = error.message;
        this.ws.terminate();
      });
    }
  }

  // MARK: - 隧道帧处理

  private handleFrame(frame: RelayToDeviceFrame) {
    switch (frame.t) {
      case 'http':
        void this.handleHttpFrame(frame);
        return;
      case 'ws-open':
        this.openLocalChannel(frame.ch, frame.path);
        return;
      case 'ws-msg': {
        const channel = this.channels.get(frame.ch);
        if (!channel) return;
        if (channel.ws.readyState === WebSocket.OPEN) channel.ws.send(frame.data);
        else {
          const bytes = Buffer.byteLength(frame.data);
          if (channel.pendingBytes + bytes > MAX_WS_PENDING_BYTES) {
            this.channels.delete(frame.ch);
            channel.ws.terminate();
            this.sendFrame({ t: 'ws-close', ch: frame.ch });
            return;
          }
          channel.pendingToLocal.push(frame.data);
          channel.pendingBytes += bytes;
        }
        return;
      }
      case 'ws-close': {
        const channel = this.channels.get(frame.ch);
        if (!channel) return;
        this.channels.delete(frame.ch);
        if (channel.ws.readyState === WebSocket.OPEN) channel.ws.close();
        else channel.ws.terminate();
        return;
      }
    }
  }

  private async handleHttpFrame(frame: HttpRequestFrame) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_HTTP_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { ...frame.headers };
      delete headers['content-length'];
      const method = frame.method.toUpperCase();
      const hasBody = frame.bodyB64 !== undefined && method !== 'GET' && method !== 'HEAD';

      const res = await fetch(`http://127.0.0.1:${this.localPort}${frame.path}`, {
        method,
        headers,
        body: hasBody ? Buffer.from(frame.bodyB64 as string, 'base64') : undefined,
        signal: controller.signal,
      });

      const body = await this.readResponseBody(res, MAX_LOCAL_RESPONSE_BYTES);
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        if (!STRIPPED_LOCAL_RESPONSE_HEADERS.has(key.toLowerCase())) resHeaders[key] = value;
      });

      this.sendFrame({
        t: 'http-res',
        id: frame.id,
        status: res.status,
        headers: resHeaders,
        ...(body.length > 0 ? { bodyB64: body.toString('base64') } : {}),
      });
    } catch (error) {
      const message = error instanceof LocalResponseTooLargeError
        ? error.message
        : error instanceof Error && error.name === 'AbortError'
          ? '本地服务请求超时'
          : error instanceof Error ? error.message : String(error);
      this.sendFrame({
        t: 'http-res',
        id: frame.id,
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        bodyB64: Buffer.from(JSON.stringify({ error: `本地服务请求失败: ${message}` })).toString('base64'),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private openLocalChannel(ch: string, requestedPath = '/ws') {
    const localPath = this.localWebSocketPath(requestedPath);
    const local = new WebSocket(`ws://127.0.0.1:${this.localPort}${localPath}`);
    const channel: LocalChannel = { ws: local, pendingToLocal: [], pendingBytes: 0 };
    this.channels.set(ch, channel);

    local.on('open', () => {
      for (const message of channel.pendingToLocal) local.send(message);
      channel.pendingToLocal = [];
      channel.pendingBytes = 0;
    });

    local.on('message', raw => {
      this.sendFrame({ t: 'ws-msg', ch, data: raw.toString() });
    });

    local.on('close', () => {
      if (this.channels.delete(ch)) {
        this.sendFrame({ t: 'ws-close', ch });
      }
    });

    local.on('error', () => local.terminate());
  }

  private localWebSocketPath(requestedPath: string): string {
    try {
      const url = new URL(requestedPath || '/ws', 'http://127.0.0.1');
      if (url.pathname !== '/ws') return '/ws';
      return url.pathname + url.search;
    } catch {
      return '/ws';
    }
  }

  private closeAllChannels() {
    for (const channel of this.channels.values()) {
      channel.ws.removeAllListeners();
      channel.ws.terminate();
    }
    this.channels.clear();
  }

  private async readResponseBody(res: Response, limit: number): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw new LocalResponseTooLargeError(limit);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, total);
  }

  destroy() {
    this.cancelAuthorization();
    this.stopInternal();
  }
}
