// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createApp } from './app.js';
import { RelayClient } from './relay-client.js';
import { FileRelayCredentialStore } from './relay-credentials.js';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: childProcessMocks.execFile,
}));

interface DeviceToRelayFrame {
  t: 'http-res' | 'ws-msg' | 'ws-close';
  id?: string;
  status?: number;
  headers?: Record<string, string>;
  bodyB64?: string;
  ch?: string;
  data?: string;
}

interface FakeDeviceConnection {
  ws: WebSocket;
  requestUrl: string;
  authorization: string | undefined;
  frames: DeviceToRelayFrame[];
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  childProcessMocks.execFile.mockReset();
  vi.unstubAllEnvs();
});

function waitFor<T>(check: () => T | undefined, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = check();
      if (value !== undefined) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('waitFor timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 模拟中继服务器：只接受 /device/ws 升级并记录设备发来的帧 */
async function startFakeRelay(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    if (handler) handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true });
  const connections: FakeDeviceConnection[] = [];

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.local');
    if (url.pathname !== '/device/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const conn: FakeDeviceConnection = {
        ws,
        requestUrl: req.url ?? '',
        authorization: req.headers.authorization,
        frames: [],
      };
      ws.on('message', raw => conn.frames.push(JSON.parse(raw.toString())));
      connections.push(conn);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>(resolve => {
    for (const conn of connections) conn.ws.terminate();
    wss.close(() => server.close(() => resolve()));
  }));
  return {
    port,
    connections,
    waitForConnection: (n = 1) => waitFor(() => (connections.length >= n ? connections[n - 1] : undefined)),
  };
}

async function startFakeAuthorizationCloud(tokenError?: { status: number; code: string; message: string }) {
  let revokedToken: string | undefined;
  let requestedMode: string | undefined;
  const relay = await startFakeRelay((req, res) => {
    const url = new URL(req.url ?? '/', 'http://cloud.local');
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/api/v1/device-authorizations') {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { mode: string };
        requestedMode = body.mode;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          poll_token: 'poll-token', verification_uri: `http://${req.headers.host}/activate`,
          user_code: body.mode === 'device' ? 'ABCD-EFGH' : undefined,
          browser_url: body.mode === 'browser' ? `http://${req.headers.host}/authorize/device?token=browser` : undefined,
          expires_at: new Date(Date.now() + 60_000).toISOString(), interval: 0.01,
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/device-authorizations/token') {
        if (tokenError) {
          res.writeHead(tokenError.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: tokenError.code, message: tokenError.message } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'issued-device-token', server_url: `http://${req.headers.host}`,
          user: { primary_label: 'alice@example.com' },
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/device/token/revoke') {
        revokedToken = req.headers.authorization;
        res.writeHead(204); res.end(); return;
      }
      res.writeHead(404); res.end();
    });
  });
  return { ...relay, requestedMode: () => requestedMode, revokedToken: () => revokedToken };
}

async function startRejectingRelay() {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { port };
}

/** 存根本地 CLI Bridge 服务：/api/echo 回显请求，/ws 推送欢迎消息并回显 */
async function startLocalStub() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        contentType: req.headers['content-type'] ?? null,
      });
      res.writeHead(req.url?.includes('boom') ? 500 : 200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const localSockets: WebSocket[] = [];
  const localUpgradeUrls: string[] = [];
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws')) {
      socket.destroy();
      return;
    }
    localUpgradeUrls.push(req.url ?? '');
    wss.handleUpgrade(req, socket, head, ws => {
      localSockets.push(ws);
      ws.send(JSON.stringify({ event: 'state:update', data: { marker: 'hello' } }));
      ws.on('message', raw => ws.send(`local-echo:${raw.toString()}`));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>(resolve => {
    for (const ws of localSockets) ws.terminate();
    wss.close(() => server.close(() => resolve()));
  }));
  return { port, localSockets, localUpgradeUrls };
}

async function startLargeResponseStub(sizeBytes: number) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(1024 * 1024, 65);
    let remaining = sizeBytes;
    while (remaining > 0) {
      const size = Math.min(remaining, chunk.length);
      res.write(size === chunk.length ? chunk : chunk.subarray(0, size));
      remaining -= size;
    }
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { port };
}

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-client-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'relay.json');
}

const configPaths = new WeakMap<RelayClient, string>();

function makeClient(localPort: number, configPath = tempConfigPath()): RelayClient {
  const client = new RelayClient(localPort, configPath);
  configPaths.set(client, configPath);
  cleanups.push(() => client.destroy());
  return client;
}

function markConfigAuthorized(configPath: string) {
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(configPath, JSON.stringify({ ...stored, accountLabel: 'test@example.com', authorizationVersion: 1 }));
}

function authorize(client: RelayClient, token = 'tunnel-token') {
  const configPath = configPaths.get(client)!;
  new FileRelayCredentialStore(path.join(path.dirname(configPath), 'relay-credentials.json'))
    .write(client.getConfig().deviceId, token);
  markConfigAuthorized(configPath);
}

describe('RelayClient 配置', () => {
  it('新配置默认连接 octrix.work', () => {
    const client = makeClient(19999);
    expect(client.getConfig().url).toBe('https://octrix.work');
  });

  it('生成稳定的 deviceId 并持久化配置', async () => {
    const configPath = tempConfigPath();
    const first = makeClient(19999, configPath);
    const deviceId = first.getConfig().deviceId;
    expect(deviceId).toBeTruthy();

    first.updateConfig({ url: 'https://relay.example.com' });
    first.destroy();

    const second = makeClient(19999, configPath);
    expect(second.getConfig().deviceId).toBe(deviceId);
    expect(second.getConfig().url).toBe('https://relay.example.com');
    expect(second.getConfig().authorized).toBe(false);
    expect(second.getConfig().enabled).toBe(false);
  });

  it('显式切换云端地址时清除旧服务器凭证并要求重新登录', () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: true, url: 'https://octrix.work', accountLabel: 'alice@example.com', authorizationVersion: 1,
      deviceId: 'switching-mac', deviceName: 'Switching Mac',
    }));
    const credentials = new FileRelayCredentialStore(path.join(path.dirname(configPath), 'relay-credentials.json'));
    credentials.write('switching-mac', 'official-cloud-token');
    vi.stubEnv('OCTRIX_CLOUD_URL', 'https://relay.example.com');

    const client = makeClient(19999, configPath);

    expect(client.getConfig()).toMatchObject({
      url: 'https://relay.example.com', authorized: false, enabled: false,
    });
    expect(credentials.read('switching-mac')).toBeNull();
  });

  it('拒绝通过环境变量配置非 HTTPS 的公网 Relay', () => {
    vi.stubEnv('OCTRIX_CLOUD_URL', 'http://relay.example.com');
    expect(() => makeClient(19999)).toThrow('必须使用 HTTPS');
  });

  it('删除旧配置中的明文共享 token 并要求重新登录', () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: false, url: 'https://relay.example.com', token: 'legacy-secret',
      deviceId: 'legacy-mac', deviceName: 'Legacy Mac',
    }));

    const client = makeClient(19999, configPath);
    expect(client.getConfig()).toMatchObject({ authorized: false, enabled: false });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('legacy-secret');
    const credentialPath = path.join(path.dirname(configPath), 'relay-credentials.json');
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(new FileRelayCredentialStore(credentialPath).read('legacy-mac')).toBeNull();
  });

  it('删除没有账号标记的旧安全存储凭证并要求重新登录', () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: true, url: 'https://relay.example.com',
      deviceId: 'legacy-keychain-mac', deviceName: 'Legacy Mac',
    }));
    const credentialPath = path.join(path.dirname(configPath), 'relay-credentials.json');
    const credentials = new FileRelayCredentialStore(credentialPath);
    credentials.write('legacy-keychain-mac', 'legacy-shared-token');

    const client = makeClient(19999, configPath);
    expect(client.getConfig()).toMatchObject({ authorized: false, enabled: false });
    expect(credentials.read('legacy-keychain-mac')).toBeNull();
  });

  it('保留统一授权中心初版已带账号标记的设备凭证', () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: false, url: 'https://relay.example.com', accountLabel: 'alice@example.com',
      deviceId: 'account-mac', deviceName: 'Account Mac',
    }));
    const credentialPath = path.join(path.dirname(configPath), 'relay-credentials.json');
    const credentials = new FileRelayCredentialStore(credentialPath);
    credentials.write('account-mac', 'account-device-token');

    const client = makeClient(19999, configPath);
    expect(client.getConfig()).toMatchObject({ authorized: true, accountLabel: 'alice@example.com' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).authorizationVersion).toBe(1);
  });

  it('缺少地址或 token 时拒绝启用', () => {
    const client = makeClient(19999);
    expect(() => client.updateConfig({ enabled: true })).toThrow();
    expect(client.getConfig().enabled).toBe(false);
  });
});

describe('RelayClient 连接与隧道', () => {
  async function connectClientToFakeRelay(localPort: number) {
    const relay = await startFakeRelay();
    const client = makeClient(localPort);
    client.updateConfig({ url: `http://127.0.0.1:${relay.port}` });
    authorize(client);
    client.updateConfig({ enabled: true });
    const conn = await relay.waitForConnection();
    return { relay, client, conn };
  }

  it('携带 token 与设备信息连接中继', async () => {
    const local = await startLocalStub();
    const { client, conn } = await connectClientToFakeRelay(local.port);

    expect(conn.authorization).toBe('Bearer tunnel-token');
    const url = new URL(conn.requestUrl, 'http://relay.local');
    expect(url.searchParams.get('deviceId')).toBe(client.getConfig().deviceId);
    expect(url.searchParams.get('deviceName')).toBe(client.getConfig().deviceName);
    await waitFor(() => (client.getStatus().connected ? true : undefined));
  });

  it('握手 401 后清除凭证并停止重连', async () => {
    const relay = await startRejectingRelay();
    const client = makeClient(19999);
    client.updateConfig({ url: `http://127.0.0.1:${relay.port}` });
    authorize(client);
    client.updateConfig({ enabled: true });

    await waitFor(() => (!client.getStatus().authorized ? true : undefined));
    expect(client.getStatus()).toMatchObject({ enabled: false, authorized: false, connected: false });
    expect(client.getStatus().lastError).toContain('授权已失效');
  });

  it('服务端以 1008 撤销后清除凭证并停止重连', async () => {
    const relay = await startFakeRelay();
    const client = makeClient(19999);
    client.updateConfig({ url: `http://127.0.0.1:${relay.port}` });
    authorize(client);
    client.updateConfig({ enabled: true });
    const connection = await relay.waitForConnection();
    await waitFor(() => (client.getStatus().connected ? true : undefined));
    connection.ws.close(1008, 'authorization revoked');

    await waitFor(() => (!client.getStatus().authorized ? true : undefined));
    expect(client.getStatus()).toMatchObject({ enabled: false, authorized: false, connected: false });
    expect(client.getStatus().lastError).toContain('授权已被撤销');
  });

  it('同一配置路径只允许一个本机 relay-client 连接中继', async () => {
    const relay = await startFakeRelay();
    const configPath = tempConfigPath();
    const first = makeClient(19999, configPath);
    first.updateConfig({ url: `http://127.0.0.1:${relay.port}` });
    authorize(first);
    first.updateConfig({ enabled: true });
    await relay.waitForConnection();
    markConfigAuthorized(configPath);

    const second = makeClient(19999, configPath);
    second.updateConfig({ enabled: true });

    await waitFor(() => (second.getStatus().lastError ? true : undefined));
    expect(second.getStatus().lastError).toContain('另一个 Octrix 服务进程');

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(relay.connections).toHaveLength(1);
  });

  it('http 帧转发到本地服务并回传响应', async () => {
    const local = await startLocalStub();
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({
      t: 'http',
      id: 'req-1',
      method: 'POST',
      path: '/api/echo?x=1',
      headers: { 'content-type': 'application/json' },
      bodyB64: Buffer.from(JSON.stringify({ hello: '世界' })).toString('base64'),
    }));

    const frame = await waitFor(() => conn.frames.find(f => f.t === 'http-res' && f.id === 'req-1'));
    expect(frame.status).toBe(200);
    const body = JSON.parse(Buffer.from(frame.bodyB64 ?? '', 'base64').toString());
    expect(body.method).toBe('POST');
    expect(body.url).toBe('/api/echo?x=1');
    expect(body.contentType).toBe('application/json');
    expect(JSON.parse(body.body).hello).toBe('世界');
  });

  it('本地服务错误状态码原样透传', async () => {
    const local = await startLocalStub();
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({ t: 'http', id: 'req-2', method: 'GET', path: '/api/boom', headers: {} }));
    const frame = await waitFor(() => conn.frames.find(f => f.t === 'http-res' && f.id === 'req-2'));
    expect(frame.status).toBe(500);
  });

  it('本地服务不可达时返回 502', async () => {
    // 指向一个没有监听的端口
    const { conn } = await connectClientToFakeRelay(1);

    conn.ws.send(JSON.stringify({ t: 'http', id: 'req-3', method: 'GET', path: '/api/state', headers: {} }));
    const frame = await waitFor(() => conn.frames.find(f => f.t === 'http-res' && f.id === 'req-3'));
    expect(frame.status).toBe(502);
  });

  it('本地服务响应过大时返回 502，避免 relay-client 无上限缓冲', async () => {
    const local = await startLargeResponseStub(33 * 1024 * 1024);
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({ t: 'http', id: 'req-large', method: 'GET', path: '/api/large', headers: {} }));
    const frame = await waitFor(() => conn.frames.find(f => f.t === 'http-res' && f.id === 'req-large'), 8000);
    expect(frame.status).toBe(502);
    const body = JSON.parse(Buffer.from(frame.bodyB64 ?? '', 'base64').toString());
    expect(body.error).toContain('响应超过 32MB 上限');
  });

  it('ws 通道双向转发并正确关闭', async () => {
    const local = await startLocalStub();
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({ t: 'ws-open', ch: 'ch-1' }));

    // 本地 /ws 建立后推送的欢迎消息应通过隧道送回
    const hello = await waitFor(() => conn.frames.find(f => f.t === 'ws-msg' && f.ch === 'ch-1'));
    expect(JSON.parse(hello.data ?? '').event).toBe('state:update');

    // 通道尚未建立完成时发送的消息也不能丢（pending 队列）
    conn.ws.send(JSON.stringify({ t: 'ws-msg', ch: 'ch-1', data: 'ping-through-tunnel' }));
    const echo = await waitFor(() => conn.frames.find(f => f.t === 'ws-msg' && f.data === 'local-echo:ping-through-tunnel'));
    expect(echo.ch).toBe('ch-1');

    // 中继侧关闭通道 → 本地连接关闭
    conn.ws.send(JSON.stringify({ t: 'ws-close', ch: 'ch-1' }));
    await waitFor(() => (local.localSockets[0]?.readyState === WebSocket.CLOSED ? true : undefined));
  });

  it('ws-open path 会透传到本地 WebSocket，缺失时回退 /ws', async () => {
    const local = await startLocalStub();
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({ t: 'ws-open', ch: 'ch-path', path: '/ws?initial=0' }));
    await waitFor(() => (local.localUpgradeUrls.includes('/ws?initial=0') ? true : undefined));

    conn.ws.send(JSON.stringify({ t: 'ws-open', ch: 'ch-default' }));
    await waitFor(() => (local.localUpgradeUrls.includes('/ws') ? true : undefined));
  });

  it('本地 ws 被服务端关闭时向中继发送 ws-close', async () => {
    const local = await startLocalStub();
    const { conn } = await connectClientToFakeRelay(local.port);

    conn.ws.send(JSON.stringify({ t: 'ws-open', ch: 'ch-2' }));
    await waitFor(() => (local.localSockets.length > 0 ? true : undefined));
    local.localSockets[0].close();

    const closeFrame = await waitFor(() => conn.frames.find(f => f.t === 'ws-close' && f.ch === 'ch-2'));
    expect(closeFrame).toBeTruthy();
  });

  it('中继断开后自动重连', async () => {
    const local = await startLocalStub();
    const { relay, conn } = await connectClientToFakeRelay(local.port);

    conn.ws.terminate();
    const second = await relay.waitForConnection(2);
    expect(second.authorization).toBe('Bearer tunnel-token');
  });

  it('禁用后断开且不再重连', async () => {
    const local = await startLocalStub();
    const { relay, client } = await connectClientToFakeRelay(local.port);

    client.updateConfig({ enabled: false });
    await waitFor(() => (client.getStatus().connected ? undefined : true));

    // 等待超过首次重连退避时间，确认没有新连接
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(relay.connections.length).toBe(1);
    expect(client.getStatus().enabled).toBe(false);
  });
});

describe('RelayClient 网站授权', () => {
  it('设备码审批后将凭证写入安全存储、自动上线，并在退出时撤销', async () => {
    const cloud = await startFakeAuthorizationCloud();
    const client = makeClient(19999);
    client.updateConfig({ url: `http://127.0.0.1:${cloud.port}`, deviceName: 'Test Mac' });

    const pending = await client.beginAuthorization('device_code');
    expect(pending.userCode).toBe('ABCD-EFGH');
    expect(cloud.requestedMode()).toBe('device');
    await waitFor(() => client.getStatus().authorizationState === 'authorized' ? true : undefined);
    expect(client.getStatus()).toMatchObject({ authorized: true, accountLabel: 'alice@example.com' });
    expect(JSON.parse(fs.readFileSync(configPaths.get(client)!, 'utf8')).authorizationVersion).toBe(1);
    expect((await cloud.waitForConnection()).authorization).toBe('Bearer issued-device-token');
    expect(JSON.stringify(client.getConfig())).not.toContain('issued-device-token');

    await client.logout();
    expect(client.getStatus()).toMatchObject({ authorized: false, connected: false, authorizationState: 'signed_out' });
    expect(cloud.revokedToken()).toBe('Bearer issued-device-token');
  });

  it('浏览器授权只打开一次，并在设备属于其他账号时返回明确错误', async () => {
    const cloud = await startFakeAuthorizationCloud({
      status: 409,
      code: 'device_owned_by_another_account',
      message: '该设备已绑定其他账号',
    });
    const client = makeClient(19999);
    client.updateConfig({ url: `http://127.0.0.1:${cloud.port}`, deviceName: 'Test Mac' });

    await client.beginAuthorization('browser');
    expect(childProcessMocks.execFile).toHaveBeenCalledOnce();
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open',
      [`http://127.0.0.1:${cloud.port}/authorize/device?token=browser`],
      { windowsHide: true },
      expect.any(Function),
    );
    await waitFor(() => client.getStatus().authorizationState === 'signed_out' ? true : undefined);

    expect(client.getStatus()).toMatchObject({
      authorizationState: 'signed_out',
      authorized: false,
      lastError: '该设备已绑定其他账号',
    });
  });
});

describe('/api/relay 接口', () => {
  function makeApp(relay: RelayClient, octrixCliHome?: string) {
    return createApp({
      store: {} as never,
      hub: { messages: [], port: 9800, isRunning: true } as never,
      pm: {} as never,
      port: 9800,
      relay,
      octrixCliHome,
    });
  }

  it('GET config/status 返回当前配置与状态', async () => {
    const relay = makeClient(19999);
    const app = makeApp(relay);

    const config = await request(app).get('/api/relay/config');
    expect(config.status).toBe(200);
    expect(config.body.deviceId).toBe(relay.getConfig().deviceId);
    expect(config.body.enabled).toBe(false);
    expect(config.body).not.toHaveProperty('token');

    const status = await request(app).get('/api/relay/status');
    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(false);
  });

  it('查询并安装当前版本的 Octrix 命令行工具', async () => {
    const relay = makeClient(19999);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-api-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const app = makeApp(relay, home);

    const missing = await request(app).get('/api/relay/cli/status');
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({
      path: path.join(home, '.local', 'bin', 'octrix'),
      state: 'not_installed',
    });

    const installed = await request(app).post('/api/relay/cli/install');
    expect(installed.status).toBe(200);
    expect(installed.body).toEqual({
      ok: true,
      path: path.join(home, '.local', 'bin', 'octrix'),
      state: 'current',
    });
    expect(fs.statSync(installed.body.path).mode & 0o777).toBe(0o755);
  });

  it('PUT config 校验字段并持久化', async () => {
    const relay = makeClient(19999);
    const app = makeApp(relay);

    const bad = await request(app).put('/api/relay/config').send({ enabled: 'yes' });
    expect(bad.status).toBe(400);

    const incomplete = await request(app).put('/api/relay/config').send({ enabled: true });
    expect(incomplete.status).toBe(400);

    const rejectedToken = await request(app).put('/api/relay/config').send({ token: 'secret-token' });
    expect(rejectedToken.status).toBe(400);

    const ok = await request(app).put('/api/relay/config').send({
      url: 'https://relay.example.com',
      deviceName: '书房的 Mac',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.config.url).toBe('https://relay.example.com');
    expect(ok.body.config.deviceName).toBe('书房的 Mac');
    expect(ok.body.config).not.toHaveProperty('token');
  });
});
