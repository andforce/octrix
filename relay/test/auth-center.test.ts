import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationCenter, CloudAuthError } from '../src/auth-center.js';
import { openCloudDatabase } from '../src/cloud-db.js';
import type { CloudSettings } from '../src/cloud-config.js';

const settings: CloudSettings = {
  publicUrl: 'https://remote.example.com',
  databaseUrl: ':memory:',
  tokenPepper: 'test-pepper-at-least-16-bytes',
  googleOAuthClientId: '',
  googleOAuthClientSecret: '',
  googleAllowedEmails: 'alice@example.com,bob@example.com',
  appleOAuthClientId: '',
  appleNativeClientId: '',
  appleOAuthTeamId: '',
  appleOAuthKeyId: '',
  appleOAuthPrivateKey: '',
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

describe('AuthorizationCenter', () => {
  let now = Date.parse('2026-07-15T00:00:00Z');
  let center: AuthorizationCenter;

  beforeEach(() => {
    now = Date.parse('2026-07-15T00:00:00Z');
    center = new AuthorizationCenter(openCloudDatabase(':memory:'), settings, () => now);
  });

  afterEach(() => center.close());

  function user(email: string): string {
    return center.resolveIdentity({ provider: 'google', subject: `google:${email}`, identifier: email });
  }

  function authorizeMac(userId: string, deviceId = 'mac-1') {
    const request = center.createDeviceAuthorization({ mode: 'device', deviceId, deviceName: 'MacBook Pro' });
    expect(request.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    center.decideDeviceAuthorization(userId, { userCode: request.user_code, decision: 'approve' });
    return center.pollDeviceAuthorization(request.poll_token) as { access_token: string; device: { id: string } };
  }

  it('完成 8 位设备码授权且 poll token 只能消费一次', () => {
    const userId = user('alice@example.com');
    const issued = authorizeMac(userId);

    expect(center.authenticate(issued.access_token)).toMatchObject({
      kind: 'device',
      ownerUserId: userId,
      externalDeviceId: 'mac-1',
    });
    expect(() => center.pollDeviceAuthorization(
      center.createDeviceAuthorization({ mode: 'browser', deviceId: 'unused', deviceName: 'Unused' }).poll_token,
    )).not.toThrow();
  });

  it('拒绝、过期和重复消费都不会签发令牌', () => {
    const userId = user('alice@example.com');
    const denied = center.createDeviceAuthorization({ mode: 'device', deviceId: 'mac-denied', deviceName: 'Denied' });
    center.decideDeviceAuthorization(userId, { userCode: denied.user_code, decision: 'deny' });
    expect(() => center.pollDeviceAuthorization(denied.poll_token)).toThrowError(CloudAuthError);

    const approved = center.createDeviceAuthorization({ mode: 'browser', deviceId: 'mac-1', deviceName: 'Mac' });
    center.decideDeviceAuthorization(userId, { browserToken: new URL(approved.browser_url!).searchParams.get('token')!, decision: 'approve' });
    center.pollDeviceAuthorization(approved.poll_token);
    expect(() => center.pollDeviceAuthorization(approved.poll_token)).toThrow(/已经使用/);

    const expired = center.createDeviceAuthorization({ mode: 'device', deviceId: 'mac-old', deviceName: 'Old' });
    now += 601_000;
    expect(() => center.lookupDeviceAuthorization({ userCode: expired.user_code })).toThrow(/过期/);
  });

  it('区分 Mac 与 iPhone scope，并按用户隔离设备', () => {
    const alice = user('alice@example.com');
    const bob = user('bob@example.com');
    const mac = authorizeMac(alice);

    const mobile = center.createMobileAuthorization({
      returnUri: 'octrix://auth',
      deviceId: 'iphone-alice',
      deviceName: 'Alice iPhone',
    });
    const decision = center.decideMobileAuthorization(alice, mobile.requestToken, 'approve');
    const code = new URL(decision.callback_url!).searchParams.get('code')!;
    const client = center.exchangeMobileCode(code);

    expect(center.authenticate(mac.access_token)?.kind).toBe('device');
    expect(center.authenticate(client.access_token)?.kind).toBe('client');
    expect(center.listDevices(alice, 'mac')).toHaveLength(1);
    expect(center.listDevices(alice, 'ios')).toHaveLength(1);
    expect(center.listDevices(bob)).toHaveLength(0);
    expect(() => center.exchangeMobileCode(code)).toThrow(/已经使用/);
  });

  it('撤销设备会同时使令牌失效并通知活动连接', () => {
    const alice = user('alice@example.com');
    const issued = authorizeMac(alice);
    const actor = center.authenticate(issued.access_token)!;
    const revoked: Array<{ tokenId: string; deviceId: string | null }> = [];
    center.onTokenRevoked((tokenId, deviceId) => revoked.push({ tokenId, deviceId }));

    center.revokeDevice(alice, issued.device.id);

    expect(center.authenticate(issued.access_token)).toBeNull();
    expect(revoked).toContainEqual({ tokenId: actor.tokenId, deviceId: issued.device.id });
  });

  it('删除账号会清除全部关联数据、撤销令牌且不影响其他账号', () => {
    const alice = user('alice@example.com');
    const bob = user('bob@example.com');
    const mac = authorizeMac(alice, 'alice-mac');
    const mobileAuthorization = center.createApprovedMobileAuthorization(alice, {
      deviceId: 'alice-iphone',
      deviceName: 'Alice iPhone',
    });
    const mobile = center.exchangeMobileCode(mobileAuthorization.authorizationCode);
    const macActor = center.authenticate(mac.access_token)!;
    const mobileActor = center.authenticate(mobile.access_token)!;
    center.database.sqlite.prepare(`
      INSERT INTO web_sessions (id, session_hash, csrf_hash, user_id, created_at, expires_at)
      VALUES ('alice-session', 'alice-session-hash', 'alice-csrf-hash', ?, ?, ?)
    `).run(alice, now, now + 60_000);
    const revoked: Array<{ tokenId: string; deviceId: string | null }> = [];
    center.onTokenRevoked((tokenId, deviceId) => revoked.push({ tokenId, deviceId }));

    center.deleteAccount(alice);

    expect(center.authenticate(mac.access_token)).toBeNull();
    expect(center.authenticate(mobile.access_token)).toBeNull();
    expect(revoked).toEqual(expect.arrayContaining([
      { tokenId: macActor.tokenId, deviceId: macActor.deviceId },
      { tokenId: mobileActor.tokenId, deviceId: mobileActor.deviceId },
    ]));
    expect(() => center.account(alice)).toThrow(/account|\u8d26号/);
    expect(center.account(bob).primary_label).toBe('bob@example.com');

    for (const [table, column] of [
      ['user_identities', 'user_id'],
      ['web_sessions', 'user_id'],
      ['devices', 'owner_user_id'],
      ['auth_tokens', 'owner_user_id'],
      ['device_authorizations', 'user_id'],
      ['mobile_authorizations', 'user_id'],
      ['oauth_states', 'initiator_user_id'],
      ['sms_challenges', 'requester_user_id'],
      ['auth_events', 'owner_user_id'],
    ] as const) {
      expect(center.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(alice))
        .toMatchObject({ count: 0 });
    }

    expect(authorizeMac(bob, 'alice-mac').access_token).toBeTruthy();
  });

  it('同一设备重新授权会立即撤销旧连接凭证', () => {
    const alice = user('alice@example.com');
    const first = authorizeMac(alice, 'mac-reauth');
    const oldActor = center.authenticate(first.access_token)!;
    const revoked: string[] = [];
    center.onTokenRevoked(tokenId => revoked.push(tokenId));

    const second = authorizeMac(alice, 'mac-reauth');

    expect(center.authenticate(first.access_token)).toBeNull();
    expect(center.authenticate(second.access_token)).not.toBeNull();
    expect(revoked).toContain(oldActor.tokenId);
  });

  it('其他账号不能批准已有归属的设备', () => {
    const alice = user('alice@example.com');
    const bob = user('bob@example.com');
    authorizeMac(alice, 'owned-mac');
    const request = center.createDeviceAuthorization({ mode: 'browser', deviceId: 'owned-mac', deviceName: 'Owned Mac' });
    const browserToken = new URL(request.browser_url!).searchParams.get('token')!;

    expect(() => center.decideDeviceAuthorization(bob, {
      browserToken,
      decision: 'approve',
    })).toThrow(/其他账号/);
    expect(center.lookupDeviceAuthorization({ browserToken })).toMatchObject({ status: 'pending' });
  });

  it('原账号明确撤销设备后允许新账号重新绑定', () => {
    const alice = user('alice@example.com');
    const bob = user('bob@example.com');
    const first = authorizeMac(alice, 'transferred-mac');

    center.revokeDevice(alice, first.device.id);
    expect(center.database.sqlite.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(first.device.id))
      .toMatchObject({ revoked_at: now });
    const transferred = authorizeMac(bob, 'transferred-mac');

    expect(center.authenticate(first.access_token)).toBeNull();
    expect(center.authenticate(transferred.access_token)).toMatchObject({
      ownerUserId: bob,
      externalDeviceId: 'transferred-mac',
    });
    expect(center.listDevices(alice, 'mac')).toHaveLength(0);
    expect(center.listDevices(bob, 'mac').map(device => device.external_id)).toEqual(['transferred-mac']);
  });

  it('同一登录身份绑定到现有账号时合并两边设备', () => {
    const googleUser = user('alice@example.com');
    const smsUser = center.resolveIdentity({ provider: 'sms', subject: '+8613800138000', identifier: '+8613800138000' });
    authorizeMac(smsUser, 'sms-mac');
    center.database.sqlite.prepare(`
      INSERT INTO web_sessions (id, session_hash, csrf_hash, user_id, created_at, expires_at)
      VALUES ('target-session', 'target-hash', 'target-csrf', ?, ?, ?),
             ('source-session', 'source-hash', 'source-csrf', ?, ?, ?)
    `).run(googleUser, now, now + 60_000, smsUser, now, now + 60_000);

    const merged = center.resolveIdentity({
      provider: 'sms',
      subject: '+8613800138000',
      identifier: '+8613800138000',
      targetUserId: googleUser,
    });

    expect(center.account(merged).identities).toHaveLength(2);
    expect(center.listDevices(merged, 'mac').map(device => device.external_id)).toContain('sms-mac');
    expect(merged).toBe(googleUser);
    expect(center.database.sqlite.prepare('SELECT revoked_at FROM web_sessions WHERE id = ?').get('target-session'))
      .toMatchObject({ revoked_at: null });
    expect(center.database.sqlite.prepare('SELECT user_id, revoked_at FROM web_sessions WHERE id = ?').get('source-session'))
      .toMatchObject({ user_id: googleUser, revoked_at: now });
  });
});
