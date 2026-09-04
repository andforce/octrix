import { z } from 'zod';
import { normalizeMainlandPhone } from './sms.js';

const numberFromEnv = (fallback: number) => z.preprocess(
  value => value === undefined || value === '' ? fallback : Number(value),
  z.number().int().positive(),
);

const booleanFromEnv = (fallback: boolean) => z.preprocess(value => {
  if (value === undefined || value === '') return fallback;
  return value === true || value === '1' || value === 'true';
}, z.boolean());

function applePrivateKeyFromEnv(): string {
  const inline = process.env.OCTRIX_APPLE_OAUTH_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, '\n').trim();
  const encoded = process.env.OCTRIX_APPLE_OAUTH_PRIVATE_KEY_BASE64;
  if (!encoded) return '';
  return Buffer.from(encoded, 'base64').toString('utf8').trim();
}

const schema = z.object({
  publicUrl: z.string().url(),
  databaseUrl: z.string().default('sqlite:////data/octrix.sqlite3'),
  tokenPepper: z.string().min(16),
  googleOAuthClientId: z.string().default(''),
  googleOAuthClientSecret: z.string().default(''),
  googleAllowedEmails: z.string().default(''),
  appleOAuthClientId: z.string().default(''),
  appleNativeClientId: z.string().default(''),
  appleOAuthTeamId: z.string().default(''),
  appleOAuthKeyId: z.string().default(''),
  appleOAuthPrivateKey: z.string().default(''),
  smsAllowedPhones: z.string().default(''),
  appReviewSmsPhones: z.string().default(''),
  appReviewSmsCode: z.string().default(''),
  webSessionTtlSeconds: numberFromEnv(60 * 60 * 24 * 30),
  oauthStateTtlSeconds: numberFromEnv(600),
  authorizationTtlSeconds: numberFromEnv(600),
  authorizationPollSeconds: numberFromEnv(2),
  smsCodeTtlSeconds: numberFromEnv(300),
  smsResendSeconds: numberFromEnv(60),
  smsPhoneHourlyLimit: numberFromEnv(5),
  smsPhoneDailyLimit: numberFromEnv(10),
  smsIpHourlyLimit: numberFromEnv(20),
  smsMaxVerifyAttempts: numberFromEnv(5),
  legacyAuthEnabled: booleanFromEnv(false),
  legacyAuthUntil: z.string().default(''),
});

export type CloudSettings = z.infer<typeof schema>;

export function loadCloudSettings(): CloudSettings {
  const settings = schema.parse({
    publicUrl: process.env.OCTRIX_PUBLIC_URL ?? process.env.RELAY_PUBLIC_URL,
    databaseUrl: process.env.OCTRIX_DATABASE_URL,
    tokenPepper: process.env.OCTRIX_TOKEN_PEPPER ?? process.env.RELAY_SMS_CLIENT_TOKEN_SECRET ?? process.env.RELAY_TOKEN,
    googleOAuthClientId: process.env.OCTRIX_GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: process.env.OCTRIX_GOOGLE_OAUTH_CLIENT_SECRET,
    googleAllowedEmails: process.env.OCTRIX_GOOGLE_ALLOWED_EMAILS,
    appleOAuthClientId: process.env.OCTRIX_APPLE_OAUTH_CLIENT_ID,
    appleNativeClientId: process.env.OCTRIX_APPLE_NATIVE_CLIENT_ID,
    appleOAuthTeamId: process.env.OCTRIX_APPLE_OAUTH_TEAM_ID,
    appleOAuthKeyId: process.env.OCTRIX_APPLE_OAUTH_KEY_ID,
    appleOAuthPrivateKey: applePrivateKeyFromEnv(),
    smsAllowedPhones: process.env.OCTRIX_SMS_ALLOWED_PHONES ?? process.env.RELAY_SMS_ALLOWED_PHONES,
    appReviewSmsPhones: process.env.OCTRIX_APP_REVIEW_SMS_PHONES,
    appReviewSmsCode: process.env.OCTRIX_APP_REVIEW_SMS_CODE,
    webSessionTtlSeconds: process.env.OCTRIX_WEB_SESSION_TTL_SECONDS,
    oauthStateTtlSeconds: process.env.OCTRIX_OAUTH_STATE_TTL_SECONDS,
    authorizationTtlSeconds: process.env.OCTRIX_AUTHORIZATION_TTL_SECONDS,
    authorizationPollSeconds: process.env.OCTRIX_AUTHORIZATION_POLL_SECONDS,
    smsCodeTtlSeconds: process.env.OCTRIX_SMS_CODE_TTL_SECONDS,
    smsResendSeconds: process.env.OCTRIX_SMS_RESEND_SECONDS,
    smsPhoneHourlyLimit: process.env.OCTRIX_SMS_PHONE_HOURLY_LIMIT,
    smsPhoneDailyLimit: process.env.OCTRIX_SMS_PHONE_DAILY_LIMIT,
    smsIpHourlyLimit: process.env.OCTRIX_SMS_IP_HOURLY_LIMIT,
    smsMaxVerifyAttempts: process.env.OCTRIX_SMS_MAX_VERIFY_ATTEMPTS,
    legacyAuthEnabled: process.env.OCTRIX_LEGACY_AUTH_ENABLED,
    legacyAuthUntil: process.env.OCTRIX_LEGACY_AUTH_UNTIL,
  });
  const url = new URL(settings.publicUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('OCTRIX_PUBLIC_URL 必须使用 HTTPS');
  }
  if (settings.legacyAuthEnabled) {
    const expiresAt = Date.parse(settings.legacyAuthUntil);
    const now = Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('开启旧授权兼容时必须设置未来时间 OCTRIX_LEGACY_AUTH_UNTIL');
    }
    if (expiresAt > now + 7 * 24 * 60 * 60 * 1000) {
      throw new Error('OCTRIX_LEGACY_AUTH_UNTIL 最多只能设置为 7 天后');
    }
  }
  const configuredReviewPhones = settings.appReviewSmsPhones.split(',').map(value => value.trim()).filter(Boolean);
  if (configuredReviewPhones.length === 0 && settings.appReviewSmsCode) {
    throw new Error('配置审核固定验证码时必须设置 OCTRIX_APP_REVIEW_SMS_PHONES');
  }
  if (configuredReviewPhones.some(phone => !normalizeMainlandPhone(phone))) {
    throw new Error('OCTRIX_APP_REVIEW_SMS_PHONES 只能包含中国大陆 +86 手机号');
  }
  if (configuredReviewPhones.length > 0 && !/^\d{6}$/.test(settings.appReviewSmsCode)) {
    throw new Error('配置审核手机号时必须设置 6 位 OCTRIX_APP_REVIEW_SMS_CODE');
  }
  return settings;
}

function csvSet(value: string): Set<string> {
  return new Set(value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
}

export function allowedGoogleEmails(settings: CloudSettings): Set<string> {
  return csvSet(settings.googleAllowedEmails);
}

export function allowedSmsPhones(settings: CloudSettings): Set<string> {
  return new Set([
    ...settings.smsAllowedPhones.split(',').map(normalizeMainlandPhone),
    ...settings.appReviewSmsPhones.split(',').map(normalizeMainlandPhone),
  ].filter((value): value is string => Boolean(value)));
}

export function appReviewSmsPhones(settings: CloudSettings): Set<string> {
  return new Set(settings.appReviewSmsPhones.split(',').map(normalizeMainlandPhone).filter((value): value is string => Boolean(value)));
}

export function appReviewSmsConfigured(settings: CloudSettings): boolean {
  return appReviewSmsPhones(settings).size > 0 && /^\d{6}$/.test(settings.appReviewSmsCode);
}

export function googleAuthConfigured(settings: CloudSettings): boolean {
  return Boolean(settings.googleOAuthClientId && settings.googleOAuthClientSecret && allowedGoogleEmails(settings).size);
}

export function appleAuthConfigured(settings: CloudSettings): boolean {
  return Boolean(
    settings.appleOAuthClientId
    && settings.appleOAuthTeamId
    && settings.appleOAuthKeyId
    && settings.appleOAuthPrivateKey.startsWith('-----BEGIN PRIVATE KEY-----')
    && settings.appleOAuthPrivateKey.endsWith('-----END PRIVATE KEY-----'),
  );
}

export function appleNativeAuthConfigured(settings: CloudSettings): boolean {
  return Boolean(
    settings.appleNativeClientId
    && settings.appleOAuthTeamId
    && settings.appleOAuthKeyId
    && settings.appleOAuthPrivateKey.startsWith('-----BEGIN PRIVATE KEY-----')
    && settings.appleOAuthPrivateKey.endsWith('-----END PRIVATE KEY-----'),
  );
}
