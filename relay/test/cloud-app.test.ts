import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { encryptAppleRefreshToken } from '../src/apple-oauth.js';
import { AuthorizationCenter } from '../src/auth-center.js';
import { buildCloudApp } from '../src/cloud-app.js';
import type { CloudSettings } from '../src/cloud-config.js';
import { openCloudDatabase } from '../src/cloud-db.js';
import type { SmsVerificationPort } from '../src/sms.js';

const settings: CloudSettings = {
  publicUrl: 'https://remote.example.com',
  databaseUrl: ':memory:',
  tokenPepper: 'test-pepper-at-least-16-bytes',
  googleOAuthClientId: 'google-client-id',
  googleOAuthClientSecret: 'google-client-secret',
  googleAllowedEmails: 'alice@example.com',
  appleOAuthClientId: 'com.example.octrix.web',
  appleNativeClientId: 'com.example.octrix.mobile',
  appleOAuthTeamId: 'TEAMID1234',
  appleOAuthKeyId: 'KEYID12345',
  appleOAuthPrivateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  smsAllowedPhones: '+8613800138000',
  appReviewSmsPhones: '',
  appReviewSmsCode: '',
  webSessionTtlSeconds: 2_592_000,
  oauthStateTtlSeconds: 600,
  authorizationTtlSeconds: 600,
  authorizationPollSeconds: 2,
  smsCodeTtlSeconds: 300,
  smsResendSeconds: 60,
  smsPhoneHourlyLimit: 5,
  smsPhoneDailyLimit: 10,
  smsIpHourlyLimit: 20,
  smsMaxVerifyAttempts: 5,
  legacyAuthEnabled: false,
  legacyAuthUntil: '',
};

class FakeSms implements SmsVerificationPort {
  readonly sent: string[] = [];

  constructor(private readonly ready = true) {}

  isReady(): boolean {
    return this.ready;
  }

  async send(input: { phone: string }): Promise<void> {
    this.sent.push(input.phone);
  }

  async verify(input: { code: string }): Promise<boolean> {
    return input.code === '123456';
  }
}

describe('Octrix Cloud HTTP API', () => {
  let center: AuthorizationCenter;
  let app: Awaited<ReturnType<typeof buildCloudApp>>;
  let siteDist: string;
  let sms: FakeSms;
  let appleTokenRevoker: Mock<(settings: CloudSettings, token: string, clientId: string) => Promise<void>>;

  beforeEach(async () => {
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), settings);
    sms = new FakeSms();
    appleTokenRevoker = vi.fn<(settings: CloudSettings, token: string, clientId: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    siteDist = mkdtempSync(join(tmpdir(), 'octrix-empty-site-'));
    app = await buildCloudApp({
      center, settings, sms, siteDist,
      googleIdentity: async code => ({
        sub: code === 'blocked' ? 'blocked-subject' : 'alice-subject',
        email: code === 'blocked' ? 'blocked@example.com' : 'alice@example.com',
        email_verified: true,
        name: 'Alice',
      }),
      appleIdentity: async (code, nonce) => ({
        sub: code === 'blocked' ? 'blocked-apple-subject' : 'alice-apple-subject',
        email: code === 'blocked' ? 'blocked@example.com' : 'alice@example.com',
        email_verified: 'true',
        nonce: code === 'wrong-nonce' ? 'different-nonce' : nonce,
      }),
      appleNativeIdentity: async (code, hashedNonce) => ({
        sub: code === 'blocked' ? 'blocked-apple-subject' : 'alice-apple-subject',
        email: code === 'blocked' ? 'blocked@example.com' : 'alice@example.com',
        email_verified: 'true',
        nonce: code === 'wrong-nonce' ? 'different-nonce' : hashedNonce,
      }),
      appleTokenRevoker,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    center.close();
    rmSync(siteDist, { recursive: true, force: true });
  });

  async function loginBySms() {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });
    expect(created.statusCode).toBe(201);
    const challengeId = created.json().challenge_id as string;
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sms/challenges/${challengeId}/verify`,
      payload: { code: '123456' },
    });
    expect(verified.statusCode).toBe(200);
    const cookies = verified.cookies;
    return {
      cookie: cookies.map(item => `${item.name}=${item.value}`).join('; '),
      csrf: cookies.find(item => item.name === 'octrix_csrf')?.value ?? '',
    };
  }

  async function useReviewSmsSettings(overrides: Partial<CloudSettings> = {}) {
    await app.close();
    center.close();
    const reviewSettings = {
      ...settings,
      smsAllowedPhones: '',
      appReviewSmsPhones: '+8613800138000,+8613700137000',
      appReviewSmsCode: '246810',
      ...overrides,
    };
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), reviewSettings);
    sms = new FakeSms(false);
    app = await buildCloudApp({ center, settings: reviewSettings, sms, siteDist });
    return reviewSettings;
  }

  it('公开健康检查和登录方式不泄露敏感配置', async () => {
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready', database: 'ok' });
    const methods = (await app.inject({ url: '/api/v1/auth/methods' })).json();
    expect(methods).toMatchObject({ apple: true, apple_native: true, google: true, sms: true, authentication: 'octrix_account' });
    expect(JSON.stringify(methods)).not.toContain(settings.tokenPepper);
  });

  it('主审核账号使用固定验证码完成网页登录且不发送真实短信', async () => {
    const reviewSettings = await useReviewSmsSettings();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });
    expect(created.statusCode).toBe(201);
    expect(sms.sent).toEqual([]);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sms/challenges/${created.json().challenge_id}/verify`,
      payload: { code: '123456' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('invalid_sms_code');

    reviewSettings.appReviewSmsPhones = '';
    reviewSettings.appReviewSmsCode = '';

    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sms/challenges/${created.json().challenge_id}/verify`,
      payload: { code: '246810' },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().redirect_to).toBe('/dashboard');
    expect(verified.cookies.some(cookie => cookie.name === 'octrix_session')).toBe(true);
  });

  it('审核账号不受真实短信的重发和频率限制', async () => {
    await useReviewSmsSettings({
      smsPhoneHourlyLimit: 1,
      smsPhoneDailyLimit: 1,
      smsIpHourlyLimit: 1,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().retry_after).toBe(0);
    expect(second.json().retry_after).toBe(0);
    expect(sms.sent).toEqual([]);
  });

  it('审核账号新建 challenge 不会重置同一 IP 的验证码错误限制', async () => {
    let now = Date.parse('2026-09-04T00:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await useReviewSmsSettings({ smsMaxVerifyAttempts: 2 });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });
    now += settings.smsCodeTtlSeconds * 1000 - 1_000;
    for (const code of ['111111', '222222']) {
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sms/challenges/${first.json().challenge_id}/verify`,
        payload: { code },
      });
      expect(rejected.statusCode).toBe(400);
    }

    now += 2_000;
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: { phone: '13800138000', next: '/dashboard' },
    });
    expect(second.statusCode).toBe(201);
    const bypassAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sms/challenges/${second.json().challenge_id}/verify`,
      payload: { code: '246810' },
    });

    expect(bypassAttempt.statusCode).toBe(429);
    expect(bypassAttempt.json().error.code).toBe('sms_verify_limited');
  });

  it('备用审核账号可在 iPhone 登录，删除账号后可重新创建并登录', async () => {
    await useReviewSmsSettings();

    async function login(deviceId: string) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sms/challenges',
        payload: {
          phone: '13700137000',
          flow: 'mobile_login',
          device_id: deviceId,
          device_name: 'App Review iPhone',
        },
      });
      expect(created.statusCode).toBe(201);
      const verified = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sms/challenges/${created.json().challenge_id}/verify`,
        payload: { code: '246810' },
      });
      expect(verified.statusCode).toBe(200);
      const exchanged = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/auth/token',
        payload: { code: verified.json().authorization_code },
      });
      expect(exchanged.statusCode).toBe(200);
      return exchanged.json() as { access_token: string; user: { id: string } };
    }

    const first = await login('review-delete-iphone-1');
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(deleted.statusCode).toBe(204);

    const recreated = await login('review-delete-iphone-2');
    expect(recreated.user.id).not.toBe(first.user.id);
    expect(sms.sent).toEqual([]);
  });

  it('Apple form_post 校验 state 与 nonce，允许任意已验证邮箱并保留首次返回的姓名', async () => {
    const started = await app.inject({ url: '/auth/apple/start?next=/dashboard' });
    expect(started.statusCode).toBe(303);
    const location = new URL(started.headers.location!);
    expect(location.origin + location.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('scope')).toBe('name email');
    const state = location.searchParams.get('state')!;
    expect(location.searchParams.get('nonce')).toBe(state);
    expect(started.headers['set-cookie']).toContain('SameSite=None');
    expect(started.headers['set-cookie']).toContain('Secure');
    const oauthCookie = started.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const callback = await app.inject({
      method: 'POST',
      url: '/auth/apple/callback',
      headers: {
        cookie: `${oauthCookie.name}=${oauthCookie.value}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        code: 'allowed',
        state,
        user: JSON.stringify({ name: { firstName: 'Alice', lastName: 'Appleseed' } }),
      }).toString(),
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('/dashboard');
    const sessionCookie = callback.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: sessionCookie } });
    expect(me.json().user).toMatchObject({ name: 'Alice Appleseed' });
    expect(me.json().user.identities).toEqual([
      expect.objectContaining({ provider: 'apple', label: 'alice@example.com' }),
    ]);

    const repeated = await app.inject({
      method: 'POST', url: '/auth/apple/callback',
      headers: { cookie: `${oauthCookie.name}=${oauthCookie.value}` },
      payload: { code: 'allowed', state },
    });
    expect(repeated.statusCode).toBe(410);

    const unlistedStart = await app.inject({ url: '/auth/apple/start' });
    const unlistedLocation = new URL(unlistedStart.headers.location!);
    const unlistedState = unlistedLocation.searchParams.get('state')!;
    const unlistedCookie = unlistedStart.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const unlisted = await app.inject({
      method: 'POST', url: '/auth/apple/callback',
      headers: { cookie: `${unlistedCookie.name}=${unlistedCookie.value}` },
      payload: { code: 'blocked', state: unlistedState },
    });
    expect(unlisted.statusCode).toBe(303);

    const invalidStart = await app.inject({ url: '/auth/apple/start' });
    const invalidLocation = new URL(invalidStart.headers.location!);
    const invalidState = invalidLocation.searchParams.get('state')!;
    const invalidCookie = invalidStart.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const rejected = await app.inject({
      method: 'POST', url: '/auth/apple/callback',
      headers: { cookie: `${invalidCookie.name}=${invalidCookie.value}` },
      payload: { code: 'wrong-nonce', state: invalidState },
    });
    expect(rejected.statusCode).toBe(403);
  });

  it('Apple 身份可以绑定到现有账号而不创建重复用户', async () => {
    const session = await loginBySms();
    const started = await app.inject({
      url: '/auth/apple/start?mode=link&next=/dashboard',
      headers: { cookie: session.cookie },
    });
    const location = new URL(started.headers.location!);
    const state = location.searchParams.get('state')!;
    const oauthCookie = started.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const callback = await app.inject({
      method: 'POST',
      url: '/auth/apple/callback',
      headers: { cookie: `${session.cookie}; ${oauthCookie.name}=${oauthCookie.value}` },
      payload: { code: 'allowed', state },
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.cookies.some(item => item.name === 'octrix_session' && item.value)).toBe(false);

    const account = await app.inject({ url: '/api/v1/account', headers: { cookie: session.cookie } });
    expect(account.json().auth_methods).toEqual({ apple: true, google: true, sms: true });
    expect(account.json().user.identities.map((identity: { provider: string }) => identity.provider).sort())
      .toEqual(['apple', 'sms']);
    expect(center.database.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()).toMatchObject({ count: 1 });
  });

  it('Google state 只能使用一次且白名单生效，Google 账号可以绑定手机号', async () => {
    const started = await app.inject({ url: '/auth/google/start?next=/dashboard' });
    expect(started.statusCode).toBe(303);
    const location = new URL(started.headers.location!);
    const state = location.searchParams.get('state')!;
    const oauthCookie = started.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const callback = await app.inject({
      url: `/auth/google/callback?code=allowed&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${oauthCookie.name}=${oauthCookie.value}` },
    });
    expect(callback.statusCode).toBe(303);
    const session = {
      cookie: callback.cookies.map(item => `${item.name}=${item.value}`).join('; '),
      csrf: callback.cookies.find(item => item.name === 'octrix_csrf')?.value ?? '',
    };
    const repeated = await app.inject({
      url: `/auth/google/callback?code=allowed&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${oauthCookie.name}=${oauthCookie.value}` },
    });
    expect(repeated.statusCode).toBe(410);

    const challenge = await app.inject({
      method: 'POST', url: '/api/v1/auth/sms/challenges',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { phone: '13800138000', flow: 'link' },
    });
    expect(challenge.statusCode).toBe(201);
    const linked = await app.inject({
      method: 'POST', url: `/api/v1/auth/sms/challenges/${challenge.json().challenge_id}/verify`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { code: '123456' },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().user.identities.map((identity: { provider: string }) => identity.provider).sort()).toEqual(['google', 'sms']);

    const blockedStart = await app.inject({ url: '/auth/google/start' });
    const blockedState = new URL(blockedStart.headers.location!).searchParams.get('state')!;
    const blockedCookie = blockedStart.cookies.find(item => item.name === 'octrix_oauth_state')!;
    const blocked = await app.inject({
      url: `/auth/google/callback?code=blocked&state=${encodeURIComponent(blockedState)}`,
      headers: { cookie: `${blockedCookie.name}=${blockedCookie.value}` },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('短信登录建立会话，审批浏览器设备授权并只签发一次令牌', async () => {
    const session = await loginBySms();
    expect(sms.sent).toEqual(['+8613800138000']);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: session.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.identities[0].label).toBe('138****8000');

    const created = await app.inject({
      method: 'POST', url: '/api/v1/device-authorizations',
      payload: { mode: 'browser', device_id: 'mac-http', device_name: 'HTTP Mac' },
    });
    const request = created.json();
    const token = new URL(request.browser_url).searchParams.get('token');
    const withoutCsrf = await app.inject({
      method: 'POST', url: '/api/v1/device-authorizations/decision',
      headers: { cookie: session.cookie }, payload: { token, decision: 'approve' },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const approved = await app.inject({
      method: 'POST', url: '/api/v1/device-authorizations/decision',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { token, decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);

    const issued = await app.inject({
      method: 'POST', url: '/api/v1/device-authorizations/token', payload: { poll_token: request.poll_token },
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().access_token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(center.authenticate(issued.json().access_token)).toMatchObject({ kind: 'device', externalDeviceId: 'mac-http' });

    const repeated = await app.inject({
      method: 'POST', url: '/api/v1/device-authorizations/token', payload: { poll_token: request.poll_token },
    });
    expect(repeated.statusCode).toBe(409);
  });

  it('账号设备管理要求会话与 CSRF，撤销后旧令牌立即失效', async () => {
    const session = await loginBySms();
    const userId = center.database.sqlite.prepare('SELECT id FROM users').get() as { id: string };
    const request = center.createDeviceAuthorization({ mode: 'device', deviceId: 'mac-revoke', deviceName: 'Old Name' });
    center.decideDeviceAuthorization(userId.id, { userCode: request.user_code, decision: 'approve' });
    const issued = center.pollDeviceAuthorization(request.poll_token) as { access_token: string; device: { id: string } };

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/v1/account/devices/${issued.device.id}`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { name: 'Studio Mac' },
    });
    expect(renamed.json().device.name).toBe('Studio Mac');

    const revoked = await app.inject({
      method: 'DELETE', url: `/api/v1/account/devices/${issued.device.id}`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(revoked.statusCode).toBe(204);
    expect(center.authenticate(issued.access_token)).toBeNull();
  });

  it('Mac 退出后 iPhone 客户端可按外部 ID 删除残留设备', async () => {
    const userId = center.resolveIdentity({
      provider: 'google',
      subject: 'mobile-delete-mac-user',
      identifier: 'alice@example.com',
    });
    const macRequest = center.createDeviceAuthorization({
      mode: 'device',
      deviceId: 'retired-mac',
      deviceName: 'Retired Mac',
    });
    center.decideDeviceAuthorization(userId, { userCode: macRequest.user_code, decision: 'approve' });
    const mac = center.pollDeviceAuthorization(macRequest.poll_token) as { access_token: string };

    const denied = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/mac-devices/retired-mac',
      headers: { authorization: `Bearer ${mac.access_token}` },
    });
    expect(denied.statusCode).toBe(403);
    center.revokePresentedToken(mac.access_token);
    expect(center.listDevices(userId, 'mac')).toHaveLength(1);

    const mobileAuthorization = center.createApprovedMobileAuthorization(userId, {
      deviceId: 'delete-mac-iphone',
      deviceName: 'Delete Mac iPhone',
    });
    const mobile = center.exchangeMobileCode(mobileAuthorization.authorizationCode);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/mac-devices/retired-mac',
      headers: { authorization: `Bearer ${mobile.access_token}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(center.authenticate(mac.access_token)).toBeNull();
    expect(center.authenticate(mobile.access_token)).not.toBeNull();
    expect(center.listDevices(userId, 'mac')).toEqual([]);

    const repeated = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/mac-devices/retired-mac',
      headers: { authorization: `Bearer ${mobile.access_token}` },
    });
    expect(repeated.statusCode).toBe(204);
  });

  it('网页删除账号必须校验 CSRF 并清除会话 Cookie', async () => {
    const session = await loginBySms();
    const withoutCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { cookie: session.cookie },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'octrix_session', value: '' }),
      expect.objectContaining({ name: 'octrix_csrf', value: '' }),
    ]));
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode).toBe(401);
    expect(center.database.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()).toMatchObject({ count: 0 });
  });

  it('iPhone 客户端可用 Bearer 令牌删除账号，Mac 令牌无权执行', async () => {
    const userId = center.resolveIdentity({
      provider: 'google',
      subject: 'mobile-delete-user',
      identifier: 'alice@example.com',
    });
    const macRequest = center.createDeviceAuthorization({
      mode: 'device',
      deviceId: 'delete-mac',
      deviceName: 'Delete Mac',
    });
    center.decideDeviceAuthorization(userId, { userCode: macRequest.user_code, decision: 'approve' });
    const mac = center.pollDeviceAuthorization(macRequest.poll_token) as { access_token: string };
    const denied = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${mac.access_token}` },
    });
    expect(denied.statusCode).toBe(403);

    const mobileAuthorization = center.createApprovedMobileAuthorization(userId, {
      deviceId: 'delete-iphone',
      deviceName: 'Delete iPhone',
    });
    const mobile = center.exchangeMobileCode(mobileAuthorization.authorizationCode);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${mobile.access_token}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(center.authenticate(mac.access_token)).toBeNull();
    expect(center.authenticate(mobile.access_token)).toBeNull();
    expect(center.database.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get()).toMatchObject({ count: 0 });
  });

  it('删除 Apple 账号前撤销已加密保存的 Sign in with Apple refresh token', async () => {
    const userId = center.resolveIdentity({
      provider: 'apple',
      subject: 'apple-delete-subject',
      identifier: 'private@example.com',
    });
    center.saveAppleRefreshToken(
      userId,
      'apple-delete-subject',
      encryptAppleRefreshToken('apple-refresh-token', settings.tokenPepper),
      settings.appleNativeClientId,
    );
    const authorization = center.createApprovedMobileAuthorization(userId, {
      deviceId: 'apple-delete-iphone',
      deviceName: 'Apple Delete iPhone',
    });
    const mobile = center.exchangeMobileCode(authorization.authorizationCode);

    appleTokenRevoker.mockRejectedValueOnce(new Error('temporary Apple failure'));
    const failed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${mobile.access_token}` },
    });
    expect(failed.statusCode).toBe(502);
    expect(center.account(userId).id).toBe(userId);

    appleTokenRevoker.mockResolvedValue(undefined);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${mobile.access_token}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(appleTokenRevoker).toHaveBeenLastCalledWith(
      settings,
      'apple-refresh-token',
      settings.appleNativeClientId,
    );
    expect(() => center.account(userId)).toThrow(/account|账号/);
  });

  it('移动端网页授权只允许 octrix 回调，一次性码交换为客户端令牌', async () => {
    const invalid = await app.inject({
      url: '/auth/mobile/start?return_uri=https%3A%2F%2Fevil.example&device_id=iphone-1&device_name=iPhone',
    });
    expect(invalid.statusCode).toBe(400);

    const session = await loginBySms();
    const started = await app.inject({
      url: '/auth/mobile/start?return_uri=octrix%3A%2F%2Fauth&device_id=iphone-1&device_name=Alice%20iPhone',
    });
    expect(started.statusCode).toBe(303);
    const authorizeURL = new URL(started.headers.location!, settings.publicUrl);
    const token = authorizeURL.searchParams.get('token')!;

    const approved = await app.inject({
      method: 'POST', url: '/api/v1/mobile-authorizations/decision',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { token, decision: 'approve' },
    });
    const callback = new URL(approved.json().callback_url);
    expect(callback.protocol).toBe('octrix:');
    const code = callback.searchParams.get('code')!;

    const exchanged = await app.inject({
      method: 'POST', url: '/api/v1/mobile/auth/token', payload: { code },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(center.authenticate(exchanged.json().access_token)).toMatchObject({ kind: 'client', externalDeviceId: 'iphone-1' });
    const repeated = await app.inject({
      method: 'POST', url: '/api/v1/mobile/auth/token', payload: { code },
    });
    expect(repeated.statusCode).toBe(409);
  });

  it('移动端短信验证直接签发一次性授权码且不建立网页登录会话', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sms/challenges',
      payload: {
        phone: '13800138000',
        flow: 'mobile_login',
        device_id: 'iphone-sms',
        device_name: '短信登录 iPhone',
      },
    });
    expect(created.statusCode).toBe(201);

    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sms/challenges/${created.json().challenge_id}/verify`,
      payload: { code: '123456' },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.cookies.some(cookie => cookie.name === 'octrix_session')).toBe(false);
    expect(verified.json()).toMatchObject({ server_url: settings.publicUrl });
    expect(verified.json().authorization_code).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const exchanged = await app.inject({
      method: 'POST',
      url: '/api/v1/mobile/auth/token',
      payload: { code: verified.json().authorization_code },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(center.authenticate(exchanged.json().access_token)).toMatchObject({
      kind: 'client',
      externalDeviceId: 'iphone-sms',
    });
  });

  it('iOS 原生 Apple 登录校验 nonce，允许任意已验证邮箱并签发一次性授权码', async () => {
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/mobile/auth/apple',
      payload: {
        authorization_code: 'allowed',
        nonce: 'native-raw-nonce-1234567890',
        first_name: ' Alice\u0000 ',
        last_name: ' Appleseed ',
        device_id: 'iphone-apple',
        device_name: 'Apple 登录 iPhone',
      },
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.cookies.some(cookie => cookie.name === 'octrix_session')).toBe(false);
    expect(signedIn.json()).toMatchObject({ server_url: settings.publicUrl });

    const exchanged = await app.inject({
      method: 'POST',
      url: '/api/v1/mobile/auth/token',
      payload: { code: signedIn.json().authorization_code },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().user).toMatchObject({ name: 'Alice Appleseed' });
    expect(center.authenticate(exchanged.json().access_token)).toMatchObject({
      kind: 'client',
      externalDeviceId: 'iphone-apple',
    });

    const unlisted = await app.inject({
      method: 'POST',
      url: '/api/v1/mobile/auth/apple',
      payload: {
        authorization_code: 'blocked',
        nonce: 'native-raw-nonce-1234567890',
        device_id: 'iphone-unlisted-email',
        device_name: 'Unlisted Apple Account',
      },
    });
    expect(unlisted.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/mobile/auth/apple',
      payload: {
        authorization_code: 'wrong-nonce',
        nonce: 'native-raw-nonce-1234567890',
        device_id: 'iphone-wrong-nonce',
        device_name: 'Rejected iPhone',
      },
    });
    expect(rejected.statusCode).toBe(403);
  });
});
