import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appleAuthConfigured,
  appleNativeAuthConfigured,
  appReviewSmsPhones,
  loadCloudSettings,
} from '../src/cloud-config.js';

describe('CloudSettings', () => {
  afterEach(() => vi.unstubAllEnvs());

  function baseEnvironment() {
    vi.stubEnv('OCTRIX_TOKEN_PEPPER', 'test-pepper-at-least-16-bytes');
    vi.stubEnv('OCTRIX_PUBLIC_URL', 'https://remote.example.com');
  }

  it('必须显式配置公网地址', () => {
    vi.stubEnv('OCTRIX_TOKEN_PEPPER', 'test-pepper-at-least-16-bytes');
    expect(() => loadCloudSettings()).toThrow();
  });

  it('兼容模式必须提供未来 7 天内的明确截止时间', () => {
    baseEnvironment();
    vi.stubEnv('OCTRIX_LEGACY_AUTH_ENABLED', 'true');
    expect(() => loadCloudSettings()).toThrow('OCTRIX_LEGACY_AUTH_UNTIL');

    vi.stubEnv('OCTRIX_LEGACY_AUTH_UNTIL', new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString());
    expect(() => loadCloudSettings()).toThrow('最多只能设置为 7 天后');
  });

  it('接受未来 7 天内的兼容截止时间', () => {
    baseEnvironment();
    const until = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubEnv('OCTRIX_LEGACY_AUTH_ENABLED', 'true');
    vi.stubEnv('OCTRIX_LEGACY_AUTH_UNTIL', until);
    expect(loadCloudSettings().legacyAuthUntil).toBe(until);
  });

  it('从 base64 环境变量读取 Apple 私钥且在签名配置完整时启用', () => {
    baseEnvironment();
    const privateKey = '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----';
    vi.stubEnv('OCTRIX_APPLE_OAUTH_CLIENT_ID', 'com.example.octrix.web');
    vi.stubEnv('OCTRIX_APPLE_NATIVE_CLIENT_ID', 'com.example.octrix.mobile');
    vi.stubEnv('OCTRIX_APPLE_OAUTH_TEAM_ID', 'TEAMID1234');
    vi.stubEnv('OCTRIX_APPLE_OAUTH_KEY_ID', 'KEYID12345');
    vi.stubEnv('OCTRIX_APPLE_OAUTH_PRIVATE_KEY_BASE64', Buffer.from(privateKey).toString('base64'));
    const settings = loadCloudSettings();
    expect(settings.appleOAuthPrivateKey).toBe(privateKey);
    expect(appleAuthConfigured(settings)).toBe(true);
    expect(appleNativeAuthConfigured(settings)).toBe(true);
  });

  it('从受控环境读取两个 App Review 手机号和固定验证码', () => {
    baseEnvironment();
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_PHONES', '13900139000,13700137000');
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_CODE', '246810');

    const settings = loadCloudSettings();

    expect(appReviewSmsPhones(settings)).toEqual(new Set(['+8613900139000', '+8613700137000']));
    expect(settings.appReviewSmsCode).toBe('246810');
  });

  it('配置 App Review 手机号时拒绝缺失的固定验证码', () => {
    baseEnvironment();
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_PHONES', '13800138000');

    expect(() => loadCloudSettings()).toThrow('OCTRIX_APP_REVIEW_SMS_CODE');
  });

  it('配置 App Review 固定验证码时拒绝缺失的手机号', () => {
    baseEnvironment();
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_CODE', '246810');

    expect(() => loadCloudSettings()).toThrow('OCTRIX_APP_REVIEW_SMS_PHONES');
  });

  it('拒绝无法规范化的 App Review 手机号', () => {
    baseEnvironment();
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_PHONES', 'not-a-phone');
    vi.stubEnv('OCTRIX_APP_REVIEW_SMS_CODE', '246810');

    expect(() => loadCloudSettings()).toThrow('OCTRIX_APP_REVIEW_SMS_PHONES');
  });
});
