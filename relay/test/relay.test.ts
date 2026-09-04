import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayServer, type RelayOptions } from '../src/relay.js';
import type { RelayToDeviceFrame } from '../src/protocol.js';
import { AuthorizationCenter } from '../src/auth-center.js';
import { openCloudDatabase } from '../src/cloud-db.js';
import type { CloudSettings } from '../src/cloud-config.js';
import { SmsAuthService } from '../src/sms-auth.js';
import type { SmsVerificationPort } from '../src/sms.js';

const TOKEN = 'test-token-0123456789abcdef';

interface TestContext {
  relay: RelayServer;
  port: number;
  cleanups: Array<() => void | Promise<void>>;
}

let ctx: TestContext | null = null;

async function startRelay(options: Omit<RelayOptions, 'token'> = {}): Promise<TestContext> {
  const relay = new RelayServer({ token: TOKEN, ...options });
  const port = await relay.listen(0, '127.0.0.1');
  ctx = { relay, port, cleanups: [] };
  return ctx;
}

afterEach(async () => {
  if (!ctx) return;
  for (const cleanup of ctx.cleanups.reverse()) await cleanup();
  await ctx.relay.close();
  ctx = null;
});

function base(port: number) {
  return `http://127.0.0.1:${port}`;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

class FakeSms implements SmsVerificationPort {
  ready = true;
  shouldPass = true;
  sent: Array<{ phone: string; outId: string }> = [];
  verified: Array<{ phone: string; outId: string; code: string }> = [];

  isReady(): boolean {
    return this.ready;
  }

  async send(input: { phone: string; outId: string }): Promise<void> {
    this.sent.push(input);
  }

  async verify(input: { phone: string; outId: string; code: string }): Promise<boolean> {
    this.verified.push(input);
    return this.shouldPass;
  }
}

function makeSmsAuth(sms: FakeSms, now = Date.now) {
  return new SmsAuthService({
    relayToken: TOKEN,
    sms,
    publicUrl: 'https://relay.example.com',
    codeTtlSeconds: 300,
    resendSeconds: 60,
    phoneHourlyLimit: 5,
    phoneDailyLimit: 10,
    ipHourlyLimit: 20,
    maxVerifyAttempts: 5,
    accessTokenTtlSeconds: 3600,
    now,
  });
}

/** 模拟 Mac 端 RelayClient：应答 http 帧，回显 ws 通道消息 */
async function connectFakeDevice(port: number, deviceId = 'dev1', deviceName = 'TestMac') {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/device/ws?deviceId=${deviceId}&deviceName=${encodeURIComponent(deviceName)}`,
    { headers: authHeaders() },
  );
  const received: RelayToDeviceFrame[] = [];
  const openChannels = new Set<string>();

  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as RelayToDeviceFrame;
    received.push(frame);
    switch (frame.t) {
      case 'http': {
        const body = frame.bodyB64 ? Buffer.from(frame.bodyB64, 'base64').toString() : '';
        const payload = JSON.stringify({
          echoedMethod: frame.method,
          echoedPath: frame.path,
          echoedBody: body,
          echoedContentType: frame.headers['content-type'] ?? null,
          sawAuthorization: 'authorization' in frame.headers,
        });
        ws.send(JSON.stringify({
          t: 'http-res',
          id: frame.id,
          status: frame.path.includes('missing') ? 404 : 200,
          headers: { 'content-type': 'application/json', 'x-secret-internal': 'nope' },
          bodyB64: Buffer.from(payload).toString('base64'),
        }));
        break;
      }
      case 'ws-open':
        openChannels.add(frame.ch);
        ws.send(JSON.stringify({
          t: 'ws-msg',
          ch: frame.ch,
          data: JSON.stringify({ event: 'hello', path: frame.path ?? null }),
        }));
        break;
      case 'ws-msg':
        ws.send(JSON.stringify({ t: 'ws-msg', ch: frame.ch, data: `echo:${frame.data}` }));
        break;
      case 'ws-close':
        openChannels.delete(frame.ch);
        break;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ctx?.cleanups.push(() => ws.close());
  return { ws, received, openChannels };
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 3000): Promise<T> {
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

describe('RelayServer 鉴权', () => {
  it('healthz 无需鉴权', async () => {
    const { port } = await startRelay();
    const res = await fetch(`${base(port)}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('缺失或错误 token 的 REST 请求返回 401', async () => {
    const { port } = await startRelay();
    expect((await fetch(`${base(port)}/api/devices`)).status).toBe(401);
    expect((await fetch(`${base(port)}/api/devices`, {
      headers: { authorization: 'Bearer wrong-token' },
    })).status).toBe(401);
    expect((await fetch(`${base(port)}/d/dev1/api/state`)).status).toBe(401);
  });

  it('错误 token 的设备 WS 握手被拒绝', async () => {
    const { port } = await startRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=dev1`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    const error = await new Promise<Error>(resolve => ws.once('error', resolve));
    expect(error.message).toContain('401');
  });

  it('token 也可通过查询参数传递（供浏览器调试）', async () => {
    const { port } = await startRelay();
    const res = await fetch(`${base(port)}/api/devices?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('兼容截止时间到期后立即拒绝旧 token 和查询参数', async () => {
    const { port } = await startRelay({
      allowLegacyTokenTransports: true,
      legacyAuthUntilMs: Date.now() - 1,
    });
    expect((await fetch(`${base(port)}/api/devices`, { headers: authHeaders() })).status).toBe(401);
    expect((await fetch(`${base(port)}/api/devices?token=${TOKEN}`)).status).toBe(401);
  });
});

describe('短信验证码接入', () => {
  it('未配置短信时公开 methods 返回关闭，发送接口返回 503', async () => {
    const { port } = await startRelay();

    const methods = await fetch(`${base(port)}/api/v1/auth/methods`);
    expect(methods.status).toBe(200);
    expect((await methods.json() as { sms: boolean }).sms).toBe(false);

    const challenge = await fetch(`${base(port)}/api/v1/auth/sms/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000' }),
    });
    expect(challenge.status).toBe(503);
  });

  it('短信验证成功后签发客户端 token，并允许访问设备列表', async () => {
    const sms = new FakeSms();
    const { port } = await startRelay({ smsAuth: makeSmsAuth(sms) });
    await connectFakeDevice(port, 'dev1', 'MacBook Pro');

    const created = await fetch(`${base(port)}/api/v1/auth/sms/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '138 0013 8000', device_name: 'Test iPhone' }),
    });
    expect(created.status).toBe(201);
    const challenge = await created.json() as { challenge_id: string };
    expect(sms.sent[0]).toMatchObject({ phone: '+8613800138000', outId: challenge.challenge_id });

    const verified = await fetch(`${base(port)}/api/v1/auth/sms/challenges/${challenge.challenge_id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(verified.status).toBe(200);
    const payload = await verified.json() as { access_token: string; devices: Array<{ deviceId: string }> };
    expect(payload.access_token).toMatch(/^octrix_sms_v1\./);
    expect(payload.devices.some(device => device.deviceId === 'dev1')).toBe(true);
    expect(sms.verified[0]).toMatchObject({ phone: '+8613800138000', outId: challenge.challenge_id, code: '123456' });

    const devices = await fetch(`${base(port)}/api/devices`, {
      headers: { authorization: `Bearer ${payload.access_token}` },
    });
    expect(devices.status).toBe(200);
  });

  it('短信客户端 token 不能注册 Mac 设备通道', async () => {
    const sms = new FakeSms();
    const { port } = await startRelay({ smsAuth: makeSmsAuth(sms) });

    const created = await fetch(`${base(port)}/api/v1/auth/sms/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900139000' }),
    });
    const challenge = await created.json() as { challenge_id: string };
    const verified = await fetch(`${base(port)}/api/v1/auth/sms/challenges/${challenge.challenge_id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    const payload = await verified.json() as { access_token: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=spoof`, {
      headers: { authorization: `Bearer ${payload.access_token}` },
    });
    const error = await new Promise<Error>(resolve => ws.once('error', resolve));
    expect(error.message).toContain('401');
  });
});

describe('HTTP 隧道', () => {
  it('把客户端请求转发给设备并回传响应', async () => {
    const { port } = await startRelay();
    await connectFakeDevice(port);

    const res = await fetch(`${base(port)}/d/dev1/api/state?verbose=1`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-secret-internal')).toBeNull();
    const data = await res.json() as Record<string, unknown>;
    expect(data.echoedMethod).toBe('GET');
    expect(data.echoedPath).toBe('/api/state?verbose=1');
    expect(data.sawAuthorization).toBe(false);
  });

  it('POST 请求体与 content-type 原样送达设备', async () => {
    const { port } = await startRelay();
    await connectFakeDevice(port);

    const res = await fetch(`${base(port)}/d/dev1/api/messages`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ body: '你好，帮我修个 bug', groupId: 'g1' }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.echoedMethod).toBe('POST');
    expect(data.echoedContentType).toBe('application/json');
    expect(JSON.parse(data.echoedBody as string).body).toBe('你好，帮我修个 bug');
  });

  it('设备返回的状态码原样透传', async () => {
    const { port } = await startRelay();
    await connectFakeDevice(port);
    const res = await fetch(`${base(port)}/d/dev1/api/missing`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it('转发路径中的 token 查询参数被剥除', async () => {
    const { port } = await startRelay();
    await connectFakeDevice(port);
    const res = await fetch(`${base(port)}/d/dev1/api/state?token=${TOKEN}&keep=1`);
    const data = await res.json() as Record<string, unknown>;
    expect(data.echoedPath).toBe('/api/state?keep=1');
  });

  it('设备离线时返回 502', async () => {
    const { port } = await startRelay();
    const res = await fetch(`${base(port)}/d/ghost/api/state`, { headers: authHeaders() });
    expect(res.status).toBe(502);
  });

  it('设备超时未应答返回 504', async () => {
    const { port, relay } = await startRelay({ requestTimeoutMs: 200 });
    // 设备连上但从不应答 http 帧
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=mute`, { headers: authHeaders() });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ctx?.cleanups.push(() => ws.close());

    const res = await fetch(`${base(port)}/d/mute/api/state`, { headers: authHeaders() });
    expect(res.status).toBe(504);
    expect(relay.listDevices().find(d => d.deviceId === 'mute')?.connected).toBe(true);
  });

  it('单设备挂起请求过多时快速返回 503，避免无限堆积', async () => {
    const { port } = await startRelay({ requestTimeoutMs: 1000, maxPendingRequestsPerDevice: 1 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=mute`, { headers: authHeaders() });
    const received: RelayToDeviceFrame[] = [];
    ws.on('message', raw => received.push(JSON.parse(raw.toString()) as RelayToDeviceFrame));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ctx?.cleanups.push(() => ws.close());

    const first = fetch(`${base(port)}/d/mute/api/slow`, { headers: authHeaders() });
    await waitFor(() => (received.some(frame => frame.t === 'http') ? true : undefined));

    const second = await fetch(`${base(port)}/d/mute/api/state`, { headers: authHeaders() });
    expect(second.status).toBe(503);
    await expect(first).resolves.toMatchObject({ status: 504 });
  });
});

describe('设备注册', () => {
  it('/api/devices 列出连接状态', async () => {
    const { port } = await startRelay();
    await connectFakeDevice(port, 'dev1', 'MacBook Pro');

    const res = await fetch(`${base(port)}/api/devices`, { headers: authHeaders() });
    const { devices } = await res.json() as { devices: Array<Record<string, unknown>> };
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe('dev1');
    expect(devices[0].deviceName).toBe('MacBook Pro');
    expect(devices[0].connected).toBe(true);
  });

  it('同 deviceId 重连时替换旧连接，且断开后仍在列表中标记离线', async () => {
    const { port } = await startRelay();
    const first = await connectFakeDevice(port, 'dev1');
    const second = await connectFakeDevice(port, 'dev1');

    await waitFor(() => (first.ws.readyState === WebSocket.CLOSED ? true : undefined));

    // 新连接可用
    const res = await fetch(`${base(port)}/d/dev1/api/state`, { headers: authHeaders() });
    expect(res.status).toBe(200);

    second.ws.close();
    await waitFor(() => (second.ws.readyState === WebSocket.CLOSED ? true : undefined));
    const list = await (await fetch(`${base(port)}/api/devices`, { headers: authHeaders() })).json() as { devices: Array<Record<string, unknown>> };
    const dev = list.devices.find(d => d.deviceId === 'dev1');
    await waitFor(() => (dev ? true : undefined));
    expect(dev?.connected).toBe(false);
  });
});

describe('WebSocket 隧道', () => {
  async function connectClientWs(port: number, deviceId = 'dev1') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/d/${deviceId}/ws`, { headers: authHeaders() });
    const messages: string[] = [];
    ws.on('message', raw => messages.push(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ctx?.cleanups.push(() => ws.close());
    return { ws, messages };
  }

  async function connectClientWsPath(port: number, path: string, deviceId = 'dev1') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/d/${deviceId}${path}`, { headers: authHeaders() });
    const messages: string[] = [];
    ws.on('message', raw => messages.push(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ctx?.cleanups.push(() => ws.close());
    return { ws, messages };
  }

  it('通道打开后消息双向转发', async () => {
    const { port } = await startRelay();
    const device = await connectFakeDevice(port);
    const client = await connectClientWs(port);

    // 设备在 ws-open 时主动推了一条 hello（模拟服务端推 state:update）
    await waitFor(() => (client.messages.length > 0 ? true : undefined));
    expect(JSON.parse(client.messages[0]).event).toBe('hello');

    client.ws.send(JSON.stringify({ event: 'terminal:attach' }));
    await waitFor(() => (client.messages.length > 1 ? true : undefined));
    expect(client.messages[1]).toBe(`echo:${JSON.stringify({ event: 'terminal:attach' })}`);
    expect(device.openChannels.size).toBe(1);
  });

  it('把客户端 WS 查询串透传给设备端 ws-open', async () => {
    const { port } = await startRelay();
    const device = await connectFakeDevice(port);
    const client = await connectClientWsPath(port, '/ws?initial=0');

    await waitFor(() => (client.messages.length > 0 ? true : undefined));
    expect(JSON.parse(client.messages[0]).path).toBe('/ws?initial=0');
    expect(device.received.find(frame => frame.t === 'ws-open')).toMatchObject({
      t: 'ws-open',
      path: '/ws?initial=0',
    });
  });

  it('客户端断开时通知设备关闭通道', async () => {
    const { port } = await startRelay();
    const device = await connectFakeDevice(port);
    const client = await connectClientWs(port);

    await waitFor(() => (device.openChannels.size === 1 ? true : undefined));
    client.ws.close();
    await waitFor(() => (device.openChannels.size === 0 ? true : undefined));
  });

  it('设备断开时客户端连接被关闭', async () => {
    const { port } = await startRelay();
    const device = await connectFakeDevice(port);
    const client = await connectClientWs(port);
    await waitFor(() => (device.openChannels.size === 1 ? true : undefined));

    device.ws.close();
    await waitFor(() => (client.ws.readyState === WebSocket.CLOSED ? true : undefined));
  });

  it('单设备客户端 WS 通道过多时关闭新通道', async () => {
    const { port } = await startRelay({ maxClientChannelsPerDevice: 1 });
    const device = await connectFakeDevice(port);
    const first = await connectClientWs(port);
    await waitFor(() => (device.openChannels.size === 1 ? true : undefined));

    const second = await connectClientWs(port);
    await waitFor(() => (second.ws.readyState === WebSocket.CLOSED ? true : undefined));
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('设备离线时客户端 WS 握手被拒绝', async () => {
    const { port } = await startRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/d/ghost/ws`, { headers: authHeaders() });
    const error = await new Promise<Error>(resolve => ws.once('error', resolve));
    expect(error.message).toContain('502');
  });
});

const accountSettings: CloudSettings = {
  publicUrl: 'https://remote.example.com', databaseUrl: ':memory:', tokenPepper: 'relay-auth-test-pepper-12345',
  googleOAuthClientId: '', googleOAuthClientSecret: '', googleAllowedEmails: '', smsAllowedPhones: '',
  appReviewSmsPhones: '', appReviewSmsCode: '',
  appleOAuthClientId: '', appleNativeClientId: '', appleOAuthTeamId: '', appleOAuthKeyId: '', appleOAuthPrivateKey: '',
  webSessionTtlSeconds: 2_592_000, oauthStateTtlSeconds: 600, authorizationTtlSeconds: 600,
  authorizationPollSeconds: 2, smsCodeTtlSeconds: 300, smsResendSeconds: 60,
  smsPhoneHourlyLimit: 5, smsPhoneDailyLimit: 10, smsIpHourlyLimit: 20, smsMaxVerifyAttempts: 5,
  legacyAuthEnabled: false,
  legacyAuthUntil: '',
};

describe('RelayServer 用户隔离授权', () => {
  let relay: RelayServer | null = null;
  let center: AuthorizationCenter | null = null;

  afterEach(async () => {
    await relay?.close();
    center?.close();
    relay = null;
    center = null;
  });

  function user(email: string): string {
    return center!.resolveIdentity({ provider: 'google', subject: email, identifier: email });
  }

  function macToken(userId: string, deviceId: string): { token: string; recordId: string } {
    const request = center!.createDeviceAuthorization({ mode: 'device', deviceId, deviceName: `${emailName(userId)} Mac` });
    center!.decideDeviceAuthorization(userId, { userCode: request.user_code, decision: 'approve' });
    const result = center!.pollDeviceAuthorization(request.poll_token) as { access_token: string; device: { id: string } };
    return { token: result.access_token, recordId: result.device.id };
  }

  function clientToken(userId: string, deviceId: string): string {
    const request = center!.createMobileAuthorization({ returnUri: 'octrix://auth', deviceId, deviceName: `${emailName(userId)} iPhone` });
    const approved = center!.decideMobileAuthorization(userId, request.requestToken, 'approve');
    const code = new URL(approved.callback_url!).searchParams.get('code')!;
    return center!.exchangeMobileCode(code).access_token;
  }

  function emailName(userId: string): string {
    return center!.account(userId).primary_label.split('@')[0];
  }

  it('只列出同一用户的 Mac，并拒绝跨用户 HTTP 与错误 scope', async () => {
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), accountSettings);
    const alice = user('alice@example.com');
    const bob = user('bob@example.com');
    const aliceMac = macToken(alice, 'alice-mac');
    const aliceClient = clientToken(alice, 'alice-phone');
    const bobClient = clientToken(bob, 'bob-phone');
    relay = new RelayServer({ authorization: center, allowLegacyTokenTransports: false });
    const port = await relay.listen(0, '127.0.0.1');

    const macWs = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=alice-mac&deviceName=Alice`, {
      headers: { authorization: `Bearer ${aliceMac.token}` },
    });
    await new Promise<void>((resolve, reject) => { macWs.once('open', resolve); macWs.once('error', reject); });

    const aliceList = await fetch(`http://127.0.0.1:${port}/api/devices`, { headers: { authorization: `Bearer ${aliceClient}` } });
    expect((await aliceList.json() as { devices: Array<{ deviceId: string }> }).devices.map(device => device.deviceId)).toEqual(['alice-mac']);
    const bobList = await fetch(`http://127.0.0.1:${port}/api/devices`, { headers: { authorization: `Bearer ${bobClient}` } });
    expect((await bobList.json() as { devices: unknown[] }).devices).toEqual([]);

    expect((await fetch(`http://127.0.0.1:${port}/d/alice-mac/api/state`, { headers: { authorization: `Bearer ${bobClient}` } })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/devices`, { headers: { authorization: `Bearer ${aliceMac.token}` } })).status).toBe(401);

    const badDeviceWs = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=alice-mac`, {
      headers: { authorization: `Bearer ${aliceClient}` },
    });
    const error = await new Promise<Error>(resolve => badDeviceWs.once('error', resolve));
    expect(error.message).toContain('401');
    macWs.close();
  });

  it('Mac 当前未连接时仍从授权中心列出，并标记为离线', async () => {
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), accountSettings);
    const alice = user('alice@example.com');
    macToken(alice, 'alice-offline-mac');
    const client = clientToken(alice, 'alice-phone');
    relay = new RelayServer({ authorization: center, allowLegacyTokenTransports: false });
    const port = await relay.listen(0, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${client}` },
    });
    expect(await response.json()).toMatchObject({
      devices: [{ deviceId: 'alice-offline-mac', connected: false }],
    });
  });

  it('设备撤销后立即断开活动 WebSocket，并从 iPhone 设备列表移除', async () => {
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), accountSettings);
    const alice = user('alice@example.com');
    const mac = macToken(alice, 'alice-mac');
    const client = clientToken(alice, 'alice-phone');
    relay = new RelayServer({ authorization: center, allowLegacyTokenTransports: false });
    const port = await relay.listen(0, '127.0.0.1');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=alice-mac`, {
      headers: { authorization: `Bearer ${mac.token}` },
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    const beforeRevoke = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${client}` },
    });
    expect((await beforeRevoke.json() as { devices: Array<{ deviceId: string }> }).devices)
      .toMatchObject([{ deviceId: 'alice-mac' }]);

    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    center.revokeDevice(alice, mac.recordId);
    await closed;
    expect(center.authenticate(mac.token)).toBeNull();

    const afterRevoke = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${client}` },
    });
    expect((await afterRevoke.json() as { devices: unknown[] }).devices).toEqual([]);
  });

  it('撤销 iPhone 后立即终止该凭证正在等待的 HTTP 隧道', async () => {
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), accountSettings);
    const alice = user('alice@example.com');
    const mac = macToken(alice, 'alice-mac');
    const client = clientToken(alice, 'alice-phone');
    relay = new RelayServer({ authorization: center, allowLegacyTokenTransports: false });
    const port = await relay.listen(0, '127.0.0.1');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?deviceId=alice-mac`, {
      headers: { authorization: `Bearer ${mac.token}` },
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const forwarded = new Promise<void>(resolve => ws.once('message', () => resolve()));
    const response = fetch(`http://127.0.0.1:${port}/d/alice-mac/api/slow`, {
      headers: { authorization: `Bearer ${client}` },
    });
    await forwarded;
    center.revokePresentedToken(client);
    expect((await response).status).toBe(401);
    ws.close();
  });
});
