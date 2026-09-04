import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  SmsProviderError,
  maskPhone,
  normalizeMainlandPhone,
  type SmsVerificationPort,
} from './sms.js';

export interface SmsAuthOptions {
  relayToken: string;
  sms: SmsVerificationPort;
  publicUrl?: string;
  clientTokenSecret?: string;
  allowedPhones?: Set<string> | null;
  accessTokenTtlSeconds?: number;
  codeTtlSeconds?: number;
  resendSeconds?: number;
  phoneHourlyLimit?: number;
  phoneDailyLimit?: number;
  ipHourlyLimit?: number;
  maxVerifyAttempts?: number;
  now?: () => number;
}

export interface SmsChallengeResult {
  challenge_id: string;
  expires_at: string;
  retry_after: number;
}

export interface SmsVerifyResult {
  access_token: string;
  token_type: 'Bearer';
  expires_at: string;
  user: {
    phone: string;
  };
}

interface SmsChallenge {
  id: string;
  phone: string;
  deviceName: string;
  clientIp: string;
  status: 'pending' | 'sent' | 'verifying' | 'verified' | 'failed' | 'expired' | 'provider_failed';
  attempts: number;
  providerErrorCode?: string;
  createdAt: number;
  expiresAt: number;
  retryAfter: number;
  consumedAt?: number;
}

interface ClientTokenPayload {
  v: 1;
  typ: 'relay-sms';
  phone: string;
  iat: number;
  exp: number;
  jti: string;
}

export class RelayAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function newId(): string {
  return randomUUID().replaceAll('-', '');
}

function secondsUntil(timestamp: number, now: number): number {
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export class SmsAuthService {
  private readonly challenges = new Map<string, SmsChallenge>();
  private readonly accessTokenTtlSeconds: number;
  private readonly codeTtlSeconds: number;
  private readonly resendSeconds: number;
  private readonly phoneHourlyLimit: number;
  private readonly phoneDailyLimit: number;
  private readonly ipHourlyLimit: number;
  private readonly maxVerifyAttempts: number;
  private readonly tokenSecret: string;
  private readonly now: () => number;

  constructor(private readonly options: SmsAuthOptions) {
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 60 * 60 * 24 * 30;
    this.codeTtlSeconds = options.codeTtlSeconds ?? 300;
    this.resendSeconds = options.resendSeconds ?? 60;
    this.phoneHourlyLimit = options.phoneHourlyLimit ?? 5;
    this.phoneDailyLimit = options.phoneDailyLimit ?? 10;
    this.ipHourlyLimit = options.ipHourlyLimit ?? 20;
    this.maxVerifyAttempts = options.maxVerifyAttempts ?? 5;
    this.tokenSecret = options.clientTokenSecret || options.relayToken;
    this.now = options.now ?? (() => Date.now());
  }

  isReady(): boolean {
    return this.options.sms.isReady();
  }

  methods() {
    return {
      sms: this.isReady(),
      authentication: 'sms_verification',
      public_url: this.options.publicUrl || undefined,
      sms_config: {
        country_code: '+86',
        code_length: 6,
        resend_seconds: this.resendSeconds,
      },
    };
  }

  async createChallenge(input: { phone: string; deviceName?: string; clientIp: string }): Promise<SmsChallengeResult> {
    if (!this.isReady()) {
      throw new RelayAuthError(503, 'sms_not_configured', '短信验证尚未配置');
    }

    const phone = normalizeMainlandPhone(input.phone);
    if (!phone) {
      throw new RelayAuthError(400, 'invalid_phone', '仅支持中国大陆 +86 手机号');
    }
    if (this.options.allowedPhones && !this.options.allowedPhones.has(phone)) {
      throw new RelayAuthError(403, 'phone_not_allowed', '该手机号暂未开放登录');
    }

    const timestamp = this.now();
    this.sweep(timestamp);
    this.enforceCreateLimits(phone, input.clientIp, timestamp);

    const challenge: SmsChallenge = {
      id: newId(),
      phone,
      deviceName: input.deviceName?.trim() || 'iPhone',
      clientIp: input.clientIp,
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      expiresAt: timestamp + this.codeTtlSeconds * 1000,
      retryAfter: timestamp + this.resendSeconds * 1000,
    };
    this.challenges.set(challenge.id, challenge);

    try {
      await this.options.sms.send({ phone, outId: challenge.id });
      challenge.status = 'sent';
    } catch (error) {
      challenge.status = 'provider_failed';
      challenge.providerErrorCode = error instanceof SmsProviderError ? error.providerCode : 'SMS_SEND_FAILED';
      if (error instanceof SmsProviderError && error.retryable) {
        throw new RelayAuthError(429, 'sms_provider_limited', '短信服务限制了发送频率，请稍后再试');
      }
      throw new RelayAuthError(502, 'sms_send_failed', '验证码发送失败');
    }

    return {
      challenge_id: challenge.id,
      expires_at: new Date(challenge.expiresAt).toISOString(),
      retry_after: this.resendSeconds,
    };
  }

  async verifyChallenge(input: { challengeId: string; code: string }): Promise<SmsVerifyResult> {
    if (!this.isReady()) {
      throw new RelayAuthError(503, 'sms_not_configured', '短信验证尚未配置');
    }
    if (!/^\d{6}$/.test(input.code)) {
      throw new RelayAuthError(400, 'invalid_request', '验证码必须是 6 位数字');
    }

    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) {
      throw new RelayAuthError(404, 'sms_challenge_not_found', '验证码请求不存在');
    }
    if (challenge.consumedAt || challenge.status === 'verified') {
      throw new RelayAuthError(409, 'sms_challenge_consumed', '该验证码已经使用');
    }
    if (challenge.status !== 'sent') {
      throw new RelayAuthError(409, 'sms_challenge_unavailable', '该验证码请求不可用');
    }
    const timestamp = this.now();
    if (challenge.expiresAt <= timestamp) {
      challenge.status = 'expired';
      throw new RelayAuthError(410, 'sms_challenge_expired', '验证码已过期');
    }
    if (challenge.attempts >= this.maxVerifyAttempts) {
      throw new RelayAuthError(429, 'sms_verify_limited', '验证码错误次数过多，请重新发送');
    }

    challenge.status = 'verifying';
    challenge.attempts += 1;
    let passed = false;
    try {
      passed = await this.options.sms.verify({
        phone: challenge.phone,
        outId: challenge.id,
        code: input.code,
      });
    } catch (error) {
      challenge.status = 'sent';
      challenge.attempts = Math.max(challenge.attempts - 1, 0);
      challenge.providerErrorCode = error instanceof SmsProviderError ? error.providerCode : 'SMS_VERIFY_FAILED';
      throw new RelayAuthError(502, 'sms_verify_failed', '验证码校验服务暂时不可用');
    }

    if (!passed) {
      challenge.status = challenge.attempts >= this.maxVerifyAttempts ? 'failed' : 'sent';
      throw new RelayAuthError(400, 'invalid_sms_code', '验证码错误');
    }

    challenge.status = 'verified';
    challenge.consumedAt = timestamp;
    return this.issueAccessToken(challenge.phone, timestamp);
  }

  isAccessToken(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'octrix_sms_v1') return false;
    const [, body, signature] = parts;
    const expected = this.sign(body);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return false;
    if (!timingSafeEqual(actualBuffer, expectedBuffer)) return false;

    const payload = decodeBase64UrlJson<ClientTokenPayload>(body);
    if (!payload || payload.v !== 1 || payload.typ !== 'relay-sms') return false;
    return Number.isFinite(payload.exp) && payload.exp > this.now();
  }

  private enforceCreateLimits(phone: string, clientIp: string, timestamp: number) {
    const recent = [...this.challenges.values()]
      .filter(item => item.phone === phone && item.status !== 'provider_failed')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (recent && recent.retryAfter > timestamp) {
      throw new RelayAuthError(429, 'sms_resend_limited', '请稍后再发送验证码', {
        retry_after: secondsUntil(recent.retryAfter, timestamp),
      });
    }

    const hourAgo = timestamp - 60 * 60 * 1000;
    const dayAgo = timestamp - 24 * 60 * 60 * 1000;
    let phoneHour = 0;
    let phoneDay = 0;
    let ipHour = 0;
    for (const challenge of this.challenges.values()) {
      if (challenge.status === 'provider_failed') continue;
      if (challenge.phone === phone && challenge.createdAt > hourAgo) phoneHour += 1;
      if (challenge.phone === phone && challenge.createdAt > dayAgo) phoneDay += 1;
      if (challenge.clientIp === clientIp && challenge.createdAt > hourAgo) ipHour += 1;
    }
    if (
      phoneHour >= this.phoneHourlyLimit
      || phoneDay >= this.phoneDailyLimit
      || ipHour >= this.ipHourlyLimit
    ) {
      throw new RelayAuthError(429, 'sms_rate_limited', '验证码发送次数已达到限制，请稍后再试');
    }
  }

  private issueAccessToken(phone: string, timestamp: number): SmsVerifyResult {
    const expiresAt = timestamp + this.accessTokenTtlSeconds * 1000;
    const payload: ClientTokenPayload = {
      v: 1,
      typ: 'relay-sms',
      phone,
      iat: timestamp,
      exp: expiresAt,
      jti: newId(),
    };
    const body = base64UrlJson(payload);
    return {
      access_token: `octrix_sms_v1.${body}.${this.sign(body)}`,
      token_type: 'Bearer',
      expires_at: new Date(expiresAt).toISOString(),
      user: { phone: maskPhone(phone) },
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.tokenSecret).update(body).digest('base64url');
  }

  private sweep(timestamp: number) {
    const cutoff = timestamp - 24 * 60 * 60 * 1000;
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= timestamp && challenge.status === 'sent') {
        challenge.status = 'expired';
      }
      if (challenge.createdAt < cutoff || challenge.consumedAt) {
        this.challenges.delete(id);
      }
    }
  }
}
