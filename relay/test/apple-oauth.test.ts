import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  appleDisplayName,
  appleEmailVerified,
  appleNameFromParts,
  createAppleClientSecret,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  hashAppleNonce,
  revokeAppleToken,
} from '../src/apple-oauth.js';
import type { CloudSettings } from '../src/cloud-config.js';

describe('Sign in with Apple helpers', () => {
  it('使用 P-256 私钥签发短期 client secret', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const settings = {
      appleOAuthClientId: 'com.example.octrix.web',
      appleNativeClientId: 'com.example.octrix.mobile',
      appleOAuthTeamId: 'TEAMID1234',
      appleOAuthKeyId: 'KEYID12345',
      appleOAuthPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    } as CloudSettings;
    const now = Date.parse('2026-09-03T12:00:00Z');

    const token = await createAppleClientSecret(settings, now);
    const verified = await jwtVerify(token, publicKey, {
      issuer: settings.appleOAuthTeamId,
      audience: 'https://appleid.apple.com',
      subject: settings.appleOAuthClientId,
      currentDate: new Date(now),
    });

    expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', kid: settings.appleOAuthKeyId });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);

    const nativeToken = await createAppleClientSecret(settings, now, settings.appleNativeClientId);
    await expect(jwtVerify(nativeToken, publicKey, {
      issuer: settings.appleOAuthTeamId,
      audience: 'https://appleid.apple.com',
      subject: settings.appleNativeClientId,
      currentDate: new Date(now),
    })).resolves.toBeDefined();
  });

  it('兼容 Apple 的邮箱验证值并清理首次返回的姓名', () => {
    expect(appleEmailVerified(true)).toBe(true);
    expect(appleEmailVerified('true')).toBe(true);
    expect(appleEmailVerified('false')).toBe(false);
    expect(appleDisplayName(JSON.stringify({
      name: { firstName: ' Alice\u0000 ', lastName: ' Appleseed ' },
    }))).toBe('Alice Appleseed');
    expect(appleDisplayName('{invalid')).toBeNull();
    expect(appleNameFromParts(' Alice\u0000 ', ' Appleseed ')).toBe('Alice Appleseed');
    expect(hashAppleNonce('native-raw-nonce')).toBe('89555f601f880d02b443791218c4eecbca6e437febc81acbcb270f95b98e6e5e');
  });

  it('加密保存 Apple refresh token，并使用匹配的客户端标识撤销授权', async () => {
    const pepper = 'test-pepper-at-least-16-bytes';
    const encrypted = encryptAppleRefreshToken('apple-refresh-token', pepper);
    expect(encrypted).not.toContain('apple-refresh-token');
    expect(decryptAppleRefreshToken(encrypted, pepper)).toBe('apple-refresh-token');
    expect(() => decryptAppleRefreshToken(encrypted, 'different-pepper-value')).toThrow();

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const settings = {
      appleOAuthClientId: 'com.example.octrix.web',
      appleNativeClientId: 'com.example.octrix.mobile',
      appleOAuthTeamId: 'TEAMID1234',
      appleOAuthKeyId: 'KEYID12345',
      appleOAuthPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    } as CloudSettings;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await revokeAppleToken(settings, 'apple-refresh-token', settings.appleNativeClientId);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://appleid.apple.com/auth/revoke');
      const body = init.body as URLSearchParams;
      expect(body.get('client_id')).toBe(settings.appleNativeClientId);
      expect(body.get('token')).toBe('apple-refresh-token');
      expect(body.get('token_type_hint')).toBe('refresh_token');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
