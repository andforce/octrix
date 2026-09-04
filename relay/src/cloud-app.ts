import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  APPLE_AUTH_URL,
  appleDisplayName,
  appleEmailVerified,
  appleNameFromParts,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  exchangeAppleCode,
  exchangeAppleNativeCode,
  hashAppleNonce,
  revokeAppleToken,
  verifyAppleNativeToken,
  verifyAppleToken,
} from './apple-oauth.js';
import type { AuthorizationCenter } from './auth-center.js';
import { CloudAuthError } from './auth-center.js';
import {
  allowedGoogleEmails,
  allowedSmsPhones,
  appReviewSmsConfigured,
  appReviewSmsPhones,
  appleAuthConfigured,
  appleNativeAuthConfigured,
  googleAuthConfigured,
  type CloudSettings,
} from './cloud-config.js';
import { newId, randomToken, tokenHash } from './cloud-security.js';
import { normalizeMainlandPhone, SmsProviderError, type SmsVerificationPort } from './sms.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const SESSION_COOKIE = 'octrix_session';
const CSRF_COOKIE = 'octrix_csrf';
const OAUTH_COOKIE = 'octrix_oauth_state';

interface CloudAppDependencies {
  center: AuthorizationCenter;
  settings: CloudSettings;
  sms: SmsVerificationPort;
  onlineDeviceIds?: (ownerUserId: string) => Set<string>;
  siteDist?: string;
  googleIdentity?: (code: string) => Promise<JWTPayload>;
  appleIdentity?: (code: string, nonce: string) => Promise<JWTPayload>;
  appleNativeIdentity?: (code: string, hashedNonce: string) => Promise<JWTPayload>;
  appleTokenRevoker?: (settings: CloudSettings, token: string, clientId: string) => Promise<void>;
}

interface SessionActor {
  userId: string;
  sessionId: string;
}

function rowOrNull<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

function safeRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  const parsed = new URL(value, 'https://local.invalid');
  return parsed.origin === 'https://local.invalid' ? `${parsed.pathname}${parsed.search}`.slice(0, 1024) : '/dashboard';
}

function cookieSecure(settings: CloudSettings): boolean {
  return new URL(settings.publicUrl).protocol === 'https:';
}

function normalizeReturnUri(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'octrix:' && url.host === 'auth' ? url.toString() : null;
  } catch {
    return null;
  }
}

function currentSession(center: AuthorizationCenter, settings: CloudSettings, request: FastifyRequest): SessionActor | null {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  return rowOrNull<SessionActor>(center.database.sqlite.prepare(`
    SELECT user_id AS userId, id AS sessionId FROM web_sessions
    WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(tokenHash(raw, settings.tokenPepper), Date.now()));
}

function requireSession(center: AuthorizationCenter, settings: CloudSettings, request: FastifyRequest): SessionActor {
  const session = currentSession(center, settings, request);
  if (!session) throw new CloudAuthError(401, 'authentication_required', '请先登录');
  return session;
}

function requireCsrf(center: AuthorizationCenter, settings: CloudSettings, request: FastifyRequest): SessionActor {
  const session = requireSession(center, settings, request);
  const cookieValue = request.cookies?.[CSRF_COOKIE] ?? '';
  const headerValue = String(request.headers['x-csrf-token'] ?? '');
  if (!cookieValue || cookieValue !== headerValue) throw new CloudAuthError(403, 'csrf_failed', '请求校验失败，请刷新页面重试');
  const row = rowOrNull<{ csrf_hash: string }>(center.database.sqlite.prepare('SELECT csrf_hash FROM web_sessions WHERE id = ?').get(session.sessionId));
  if (!row || row.csrf_hash !== tokenHash(cookieValue, settings.tokenPepper)) {
    throw new CloudAuthError(403, 'csrf_failed', '请求校验失败，请重新登录');
  }
  return session;
}

function requireClientActor(center: AuthorizationCenter, request: FastifyRequest) {
  const authorization = String(request.headers.authorization ?? '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const actor = center.authenticate(token);
  if (!actor) throw new CloudAuthError(401, 'authentication_required', '请先登录');
  if (actor.kind !== 'client') {
    throw new CloudAuthError(403, 'client_required', '只能从已登录的 Octrix 客户端执行此操作');
  }
  return actor;
}

function setSession(center: AuthorizationCenter, settings: CloudSettings, reply: FastifyReply, userId: string): void {
  const raw = randomToken();
  const csrf = randomToken(20);
  const now = Date.now();
  center.database.sqlite.prepare(`
    INSERT INTO web_sessions (id, session_hash, csrf_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(newId(), tokenHash(raw, settings.tokenPepper), tokenHash(csrf, settings.tokenPepper), userId, now, now + settings.webSessionTtlSeconds * 1000);
  const common = { secure: cookieSecure(settings), sameSite: 'lax' as const, path: '/' };
  reply.setCookie(SESSION_COOKIE, raw, { ...common, httpOnly: true, maxAge: settings.webSessionTtlSeconds });
  reply.setCookie(CSRF_COOKIE, csrf, { ...common, httpOnly: false, maxAge: settings.webSessionTtlSeconds });
}

async function exchangeGoogleCode(settings: CloudSettings, code: string): Promise<Record<string, unknown>> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.googleOAuthClientId,
      client_secret: settings.googleOAuthClientSecret,
      redirect_uri: `${settings.publicUrl}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) throw new Error('Google token exchange failed');
  return await response.json() as Record<string, unknown>;
}

async function verifyGoogleToken(settings: CloudSettings, idToken: string): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const result = await jwtVerify(idToken, jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: settings.googleOAuthClientId });
  if (result.payload.email_verified !== true) throw new Error('Google email is not verified');
  return result.payload;
}

function smsReady(settings: CloudSettings, sms: SmsVerificationPort): boolean {
  return (sms.isReady() && allowedSmsPhones(settings).size > 0) || appReviewSmsConfigured(settings);
}

function appReviewSmsCodeHash(settings: CloudSettings, challengeId: string, code: string): string {
  return tokenHash(`app-review-sms:${challengeId}:${code}`, settings.tokenPepper);
}

function matchesAppReviewSmsCode(settings: CloudSettings, challengeId: string, code: string, codeHash: string): boolean {
  const expected = Buffer.from(codeHash);
  const actual = Buffer.from(appReviewSmsCodeHash(settings, challengeId, code));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function buildCloudApp(deps: CloudAppDependencies) {
  const { center, settings, sms } = deps;
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cookie);
  await app.register(formbody);

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string; issues?: unknown }, request, reply) => {
    const statusCode = error instanceof CloudAuthError ? error.statusCode : typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = error instanceof CloudAuthError ? error.code : typeof error.code === 'string' ? error.code : 'server_error';
    if (statusCode >= 500) request.log.error({ error_name: error.name, error_code: code }, 'request failed');
    reply.status(statusCode).send({ error: { code, message: statusCode >= 500 ? '服务器暂时不可用' : error.message } });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => {
    center.database.sqlite.prepare('SELECT 1').get();
    return { status: 'ready', database: 'ok' };
  });

  app.get('/api/v1/auth/methods', async () => ({
    apple: appleAuthConfigured(settings),
    apple_native: appleNativeAuthConfigured(settings),
    google: googleAuthConfigured(settings),
    sms: smsReady(settings, sms),
    authentication: 'octrix_account',
    public_url: settings.publicUrl,
    sms_config: { country_code: '+86', code_length: 6, resend_seconds: settings.smsResendSeconds },
  }));

  app.get('/api/v1/me', async request => {
    const session = requireSession(center, settings, request);
    return { user: center.account(session.userId) };
  });

  app.post('/api/v1/logout', async (request, reply) => {
    const session = currentSession(center, settings, request);
    if (session) center.revokeSession(session.userId, session.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/google/start', async (request, reply) => {
    if (!googleAuthConfigured(settings)) throw new CloudAuthError(503, 'google_not_configured', 'Google 登录尚未配置');
    const query = request.query as { next?: string; mode?: string };
    const mode = query.mode === 'link' ? 'link' : 'login';
    const initiator = mode === 'link' ? requireSession(center, settings, request).userId : null;
    const state = randomToken();
    center.database.sqlite.prepare(`
      INSERT INTO oauth_states (id, state_hash, redirect_path, mode, initiator_user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), tokenHash(state, settings.tokenPepper), safeRedirect(query.next), mode, initiator, Date.now(), Date.now() + settings.oauthStateTtlSeconds * 1000);
    reply.setCookie(OAUTH_COOKIE, state, {
      httpOnly: true, secure: cookieSecure(settings), sameSite: 'lax', path: '/', maxAge: settings.oauthStateTtlSeconds,
    });
    const params = new URLSearchParams({
      client_id: settings.googleOAuthClientId,
      redirect_uri: `${settings.publicUrl}/auth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
    });
    return reply.redirect(`${GOOGLE_AUTH_URL}?${params}`, 303);
  });

  app.get('/auth/apple/start', async (request, reply) => {
    if (!appleAuthConfigured(settings)) throw new CloudAuthError(503, 'apple_not_configured', 'Apple 登录尚未配置');
    const query = request.query as { next?: string; mode?: string };
    const mode = query.mode === 'link' ? 'link' : 'login';
    const initiator = mode === 'link' ? requireSession(center, settings, request).userId : null;
    const state = `apple.${randomToken()}`;
    center.database.sqlite.prepare(`
      INSERT INTO oauth_states (id, state_hash, redirect_path, mode, initiator_user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), tokenHash(state, settings.tokenPepper), safeRedirect(query.next), mode, initiator, Date.now(), Date.now() + settings.oauthStateTtlSeconds * 1000);
    reply.setCookie(OAUTH_COOKIE, state, {
      httpOnly: true, secure: cookieSecure(settings), sameSite: 'none', path: '/', maxAge: settings.oauthStateTtlSeconds,
    });
    const params = new URLSearchParams({
      client_id: settings.appleOAuthClientId,
      redirect_uri: `${settings.publicUrl}/auth/apple/callback`,
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
      state,
      nonce: state,
    });
    return reply.redirect(`${APPLE_AUTH_URL}?${params}`, 303);
  });

  app.get('/auth/google/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const cookieState = request.cookies?.[OAUTH_COOKIE];
    if (query.error || !query.code || !query.state || query.state !== cookieState) {
      throw new CloudAuthError(400, 'oauth_state_invalid', 'Google 登录状态无效，请重新登录');
    }
    const state = rowOrNull<{ id: string; redirect_path: string; mode: string; initiator_user_id: string | null }>(center.database.sqlite.prepare(`
      SELECT id, redirect_path, mode, initiator_user_id FROM oauth_states
      WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash(query.state, settings.tokenPepper), Date.now()));
    if (!state) throw new CloudAuthError(410, 'oauth_state_expired', 'Google 登录状态已过期');
    const claimed = center.database.sqlite.prepare('UPDATE oauth_states SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(Date.now(), state.id);
    if (claimed.changes !== 1) throw new CloudAuthError(410, 'oauth_state_expired', 'Google 登录状态已过期');
    const claims = deps.googleIdentity
      ? await deps.googleIdentity(query.code)
      : await exchangeGoogleCode(settings, query.code).then(token => verifyGoogleToken(settings, String(token.id_token ?? '')));
    if (claims.email_verified !== true) throw new CloudAuthError(403, 'google_email_unverified', 'Google 邮箱尚未验证');
    const email = String(claims.email ?? '').trim().toLowerCase();
    if (!allowedGoogleEmails(settings).has(email)) throw new CloudAuthError(403, 'email_not_allowed', '这个 Google 邮箱没有 Octrix 登录权限');
    const userId = center.resolveIdentity({
      provider: 'google', subject: String(claims.sub), identifier: email,
      targetUserId: state.mode === 'link' ? state.initiator_user_id ?? undefined : undefined,
      name: typeof claims.name === 'string' ? claims.name : null,
      pictureUrl: typeof claims.picture === 'string' ? claims.picture : null,
    });
    if (state.mode !== 'link') setSession(center, settings, reply, userId);
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    return reply.redirect(state.redirect_path, 303);
  });

  app.post('/auth/apple/callback', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: string; state?: string; error?: string; user?: string };
    const cookieState = request.cookies?.[OAUTH_COOKIE];
    if (body.error || !body.code || !body.state || !body.state.startsWith('apple.') || body.state !== cookieState) {
      throw new CloudAuthError(400, 'oauth_state_invalid', 'Apple 登录状态无效，请重新登录');
    }
    const state = rowOrNull<{ id: string; redirect_path: string; mode: string; initiator_user_id: string | null }>(center.database.sqlite.prepare(`
      SELECT id, redirect_path, mode, initiator_user_id FROM oauth_states
      WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash(body.state, settings.tokenPepper), Date.now()));
    if (!state) throw new CloudAuthError(410, 'oauth_state_expired', 'Apple 登录状态已过期');
    const claimed = center.database.sqlite.prepare('UPDATE oauth_states SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(Date.now(), state.id);
    if (claimed.changes !== 1) throw new CloudAuthError(410, 'oauth_state_expired', 'Apple 登录状态已过期');
    let appleRefreshToken = '';
    let claims: JWTPayload;
    if (deps.appleIdentity) {
      claims = await deps.appleIdentity(body.code, body.state);
    } else {
      const token = await exchangeAppleCode(settings, body.code);
      claims = await verifyAppleToken(settings, String(token.id_token ?? ''), body.state);
      appleRefreshToken = String(token.refresh_token ?? '');
      if (!appleRefreshToken) throw new CloudAuthError(502, 'apple_refresh_token_missing', 'Apple 登录未返回刷新令牌');
    }
    if (!appleEmailVerified(claims.email_verified)) {
      throw new CloudAuthError(403, 'apple_email_unverified', 'Apple 邮箱尚未验证');
    }
    if (claims.nonce !== body.state) throw new CloudAuthError(403, 'apple_nonce_invalid', 'Apple 登录凭证无效，请重新登录');
    const subject = String(claims.sub ?? '').trim();
    const email = String(claims.email ?? '').trim().toLowerCase();
    if (!subject || !email) throw new CloudAuthError(403, 'apple_identity_incomplete', 'Apple 登录信息不完整');
    const userId = center.resolveIdentity({
      provider: 'apple', subject, identifier: email,
      targetUserId: state.mode === 'link' ? state.initiator_user_id ?? undefined : undefined,
      name: appleDisplayName(body.user),
    });
    if (appleRefreshToken) {
      center.saveAppleRefreshToken(
        userId,
        subject,
        encryptAppleRefreshToken(appleRefreshToken, settings.tokenPepper),
        settings.appleOAuthClientId,
      );
    }
    if (state.mode !== 'link') setSession(center, settings, reply, userId);
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    return reply.redirect(state.redirect_path, 303);
  });

  app.post('/api/v1/mobile/auth/apple', async (request, reply) => {
    if (!appleNativeAuthConfigured(settings)) {
      throw new CloudAuthError(503, 'apple_native_not_configured', 'iPhone Apple 登录尚未配置');
    }
    const body = (request.body ?? {}) as {
      authorization_code?: string;
      nonce?: string;
      first_name?: string;
      last_name?: string;
      device_id?: string;
      device_name?: string;
    };
    const code = String(body.authorization_code ?? '').trim();
    const nonce = String(body.nonce ?? '').trim();
    const deviceId = String(body.device_id ?? '').trim().slice(0, 255);
    const deviceName = String(body.device_name ?? '').trim().slice(0, 255);
    if (!code || code.length > 8192) throw new CloudAuthError(400, 'invalid_apple_code', 'Apple 授权码无效');
    if (nonce.length < 16 || nonce.length > 255) throw new CloudAuthError(400, 'invalid_apple_nonce', 'Apple 登录随机数无效');
    if (!deviceId) throw new CloudAuthError(400, 'invalid_device_id', '移动设备标识不能为空');
    if (!deviceName) throw new CloudAuthError(400, 'invalid_device_name', '移动设备名称不能为空');

    const hashedNonce = hashAppleNonce(nonce);
    let appleRefreshToken = '';
    let claims: JWTPayload;
    if (deps.appleNativeIdentity) {
      claims = await deps.appleNativeIdentity(code, hashedNonce);
    } else {
      const token = await exchangeAppleNativeCode(settings, code);
      claims = await verifyAppleNativeToken(settings, String(token.id_token ?? ''), nonce);
      appleRefreshToken = String(token.refresh_token ?? '');
      if (!appleRefreshToken) throw new CloudAuthError(502, 'apple_refresh_token_missing', 'Apple 登录未返回刷新令牌');
    }
    if (!appleEmailVerified(claims.email_verified)) {
      throw new CloudAuthError(403, 'apple_email_unverified', 'Apple 邮箱尚未验证');
    }
    if (claims.nonce !== hashedNonce) {
      throw new CloudAuthError(403, 'apple_nonce_invalid', 'Apple 登录凭证无效，请重新登录');
    }
    const subject = String(claims.sub ?? '').trim();
    const email = String(claims.email ?? '').trim().toLowerCase();
    if (!subject || !email) throw new CloudAuthError(403, 'apple_identity_incomplete', 'Apple 登录信息不完整');
    const userId = center.resolveIdentity({
      provider: 'apple',
      subject,
      identifier: email,
      name: appleNameFromParts(body.first_name, body.last_name),
    });
    if (appleRefreshToken) {
      center.saveAppleRefreshToken(
        userId,
        subject,
        encryptAppleRefreshToken(appleRefreshToken, settings.tokenPepper),
        settings.appleNativeClientId,
      );
    }
    const authorization = center.createApprovedMobileAuthorization(userId, {
      deviceId,
      deviceName,
      method: 'apple',
    });
    return reply.send({
      authorization_code: authorization.authorizationCode,
      expires_at: new Date(authorization.expiresAt).toISOString(),
      server_url: settings.publicUrl,
    });
  });

  app.post('/api/v1/auth/sms/challenges', async (request, reply) => {
    if (!smsReady(settings, sms)) throw new CloudAuthError(503, 'sms_not_configured', '短信登录尚未配置');
    const body = request.body as { phone?: string; flow?: string; next?: string; device_id?: string; device_name?: string };
    const flow = body.flow === 'link' ? 'link' : body.flow === 'mobile_login' ? 'mobile_login' : 'web_login';
    const deviceId = String(body.device_id ?? '').trim().slice(0, 255);
    const deviceName = String(body.device_name ?? 'iPhone').trim().slice(0, 255);
    if (flow === 'mobile_login' && !deviceId) throw new CloudAuthError(400, 'invalid_device_id', '移动设备标识不能为空');
    if (flow === 'mobile_login' && !deviceName) throw new CloudAuthError(400, 'invalid_device_name', '移动设备名称不能为空');
    const phone = normalizeMainlandPhone(String(body.phone ?? ''));
    if (!phone) throw new CloudAuthError(400, 'invalid_phone', '仅支持中国大陆 +86 手机号');
    if (!allowedSmsPhones(settings).has(phone)) throw new CloudAuthError(403, 'phone_not_allowed', '该手机号不在登录白名单中');
    const isAppReviewPhone = appReviewSmsPhones(settings).has(phone);
    if (!isAppReviewPhone && !sms.isReady()) throw new CloudAuthError(503, 'sms_not_configured', '短信登录尚未配置');
    const actor = flow === 'link' ? requireCsrf(center, settings, request) : null;
    const now = Date.now();
    if (isAppReviewPhone) {
      const failureCutoff = now - settings.smsCodeTtlSeconds * 1000;
      center.database.sqlite.prepare('DELETE FROM app_review_sms_failures WHERE attempted_at <= ?').run(failureCutoff);
      center.database.sqlite.prepare(`
        DELETE FROM sms_challenges
        WHERE verification_method = 'app_review' AND consumed_at IS NULL AND expires_at <= ?
      `).run(now);
    } else {
      const recent = rowOrNull<{ retry_after: number }>(center.database.sqlite.prepare(`
        SELECT retry_after FROM sms_challenges
        WHERE phone = ? AND verification_method = 'provider' AND status IN ('pending','sent','verifying')
        ORDER BY created_at DESC LIMIT 1
      `).get(phone));
      if (recent && recent.retry_after > now) {
        return reply.status(429).send({ error: { code: 'sms_resend_limited', message: '请稍后再发送验证码' }, retry_after: Math.ceil((recent.retry_after - now) / 1000) });
      }
      const phoneHour = rowOrNull<{ count: number }>(center.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM sms_challenges WHERE phone = ? AND verification_method = 'provider' AND created_at > ?`).get(phone, now - 3_600_000))?.count ?? 0;
      const phoneDay = rowOrNull<{ count: number }>(center.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM sms_challenges WHERE phone = ? AND verification_method = 'provider' AND created_at > ?`).get(phone, now - 86_400_000))?.count ?? 0;
      const ipHour = rowOrNull<{ count: number }>(center.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM sms_challenges WHERE client_ip = ? AND verification_method = 'provider' AND created_at > ?`).get(request.ip, now - 3_600_000))?.count ?? 0;
      if (phoneHour >= settings.smsPhoneHourlyLimit || phoneDay >= settings.smsPhoneDailyLimit || ipHour >= settings.smsIpHourlyLimit) {
        throw new CloudAuthError(429, 'sms_rate_limited', '验证码发送次数已达到限制，请稍后再试');
      }
    }
    const id = newId();
    center.database.sqlite.prepare(`
      INSERT INTO sms_challenges
      (id, phone, flow, requester_user_id, device_external_id, device_name, redirect_path,
       client_ip, verification_method, verification_code_hash, status, created_at, expires_at, retry_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, phone, flow, actor?.userId ?? null,
      flow === 'mobile_login' ? deviceId : null, flow === 'mobile_login' ? deviceName : null,
      flow === 'web_login' ? safeRedirect(body.next) : null,
      request.ip,
      isAppReviewPhone ? 'app_review' : 'provider',
      isAppReviewPhone ? appReviewSmsCodeHash(settings, id, settings.appReviewSmsCode) : null,
      now, now + settings.smsCodeTtlSeconds * 1000,
      now + (isAppReviewPhone ? 0 : settings.smsResendSeconds * 1000));
    if (isAppReviewPhone) {
      center.database.sqlite.prepare(`UPDATE sms_challenges SET status = 'sent' WHERE id = ?`).run(id);
    } else {
      try {
        await sms.send({ phone, outId: id });
        center.database.sqlite.prepare(`UPDATE sms_challenges SET status = 'sent' WHERE id = ?`).run(id);
      } catch (error) {
        const providerCode = error instanceof SmsProviderError ? error.providerCode : 'SMS_SEND_FAILED';
        center.database.sqlite.prepare(`UPDATE sms_challenges SET status = 'provider_failed', provider_error_code = ? WHERE id = ?`).run(providerCode, id);
        throw new CloudAuthError(502, 'sms_send_failed', '验证码发送失败');
      }
    }
    return reply.status(201).send({
      challenge_id: id,
      expires_at: new Date(now + settings.smsCodeTtlSeconds * 1000).toISOString(),
      retry_after: isAppReviewPhone ? 0 : settings.smsResendSeconds,
    });
  });

  app.post('/api/v1/auth/sms/challenges/:challengeId/verify', async (request, reply) => {
    const { challengeId } = request.params as { challengeId: string };
    const code = String((request.body as { code?: string }).code ?? '');
    if (!/^\d{6}$/.test(code)) throw new CloudAuthError(400, 'invalid_sms_code', '验证码必须是 6 位数字');
    const challenge = rowOrNull<{
      id: string; phone: string; flow: string; requester_user_id: string | null; redirect_path: string | null;
      device_external_id: string | null; device_name: string | null; client_ip: string;
      verification_method: 'provider' | 'app_review'; verification_code_hash: string | null;
      status: string; attempts: number; expires_at: number; consumed_at: number | null;
    }>(center.database.sqlite.prepare('SELECT * FROM sms_challenges WHERE id = ?').get(challengeId));
    if (!challenge) throw new CloudAuthError(404, 'sms_challenge_not_found', '验证码请求不存在');
    if (challenge.consumed_at) throw new CloudAuthError(409, 'sms_challenge_consumed', '验证码已经使用');
    if (challenge.expires_at <= Date.now()) throw new CloudAuthError(410, 'sms_challenge_expired', '验证码已过期');
    if (challenge.status !== 'sent' || challenge.attempts >= settings.smsMaxVerifyAttempts) throw new CloudAuthError(409, 'sms_challenge_unavailable', '验证码请求不可用');
    if (challenge.verification_method !== 'provider' && challenge.verification_method !== 'app_review') {
      throw new CloudAuthError(409, 'sms_challenge_unavailable', '验证码请求不可用');
    }
    if (challenge.verification_method === 'provider' && !sms.isReady()) {
      throw new CloudAuthError(503, 'sms_not_configured', '短信登录尚未配置');
    }
    if (challenge.verification_method === 'app_review' && !challenge.verification_code_hash) {
      throw new CloudAuthError(409, 'sms_challenge_unavailable', '验证码请求不可用');
    }
    if (challenge.verification_method === 'app_review') {
      const reviewFailures = rowOrNull<{ count: number }>(center.database.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM app_review_sms_failures
        WHERE phone = ? AND client_ip = ? AND attempted_at > ?
      `).get(challenge.phone, challenge.client_ip, Date.now() - settings.smsCodeTtlSeconds * 1000))?.count ?? 0;
      if (reviewFailures >= settings.smsMaxVerifyAttempts) {
        throw new CloudAuthError(429, 'sms_verify_limited', '验证码错误次数过多，请稍后再试');
      }
    }
    if (challenge.flow === 'link' && requireCsrf(center, settings, request).userId !== challenge.requester_user_id) {
      throw new CloudAuthError(403, 'sms_link_owner_mismatch', '绑定请求不属于当前账号');
    }
    const claimed = center.database.sqlite.prepare(`
      UPDATE sms_challenges SET status = 'verifying', attempts = attempts + 1 WHERE id = ? AND status = 'sent' AND consumed_at IS NULL
    `).run(challenge.id);
    if (claimed.changes !== 1) throw new CloudAuthError(409, 'sms_challenge_unavailable', '验证码正在校验或已失效');
    let passed = false;
    try {
      passed = challenge.verification_method === 'app_review'
        ? matchesAppReviewSmsCode(settings, challenge.id, code, challenge.verification_code_hash!)
        : await sms.verify({ phone: challenge.phone, outId: challenge.id, code });
    } catch {
      center.database.sqlite.prepare(`UPDATE sms_challenges SET status = 'sent', attempts = MAX(attempts - 1, 0) WHERE id = ?`).run(challenge.id);
      throw new CloudAuthError(502, 'sms_verify_failed', '验证码校验服务暂时不可用');
    }
    if (!passed) {
      if (challenge.verification_method === 'app_review') {
        center.database.sqlite.prepare(`
          INSERT INTO app_review_sms_failures (id, phone, client_ip, attempted_at) VALUES (?, ?, ?, ?)
        `).run(newId(), challenge.phone, challenge.client_ip, Date.now());
      }
      center.database.sqlite.prepare(`UPDATE sms_challenges SET status = ? WHERE id = ?`).run(challenge.attempts + 1 >= settings.smsMaxVerifyAttempts ? 'failed' : 'sent', challenge.id);
      throw new CloudAuthError(400, 'invalid_sms_code', '验证码错误');
    }
    const userId = center.resolveIdentity({
      provider: 'sms', subject: challenge.phone, identifier: challenge.phone,
      targetUserId: challenge.flow === 'link' ? challenge.requester_user_id ?? undefined : undefined,
    });
    center.database.sqlite.prepare(`UPDATE sms_challenges SET status = 'verified', consumed_at = ? WHERE id = ?`).run(Date.now(), challenge.id);
    if (challenge.flow === 'link') return { user: center.account(userId) };
    if (challenge.flow === 'mobile_login') {
      if (!challenge.device_external_id || !challenge.device_name) {
        throw new CloudAuthError(409, 'mobile_device_missing', '移动设备信息不完整，请重新获取验证码');
      }
      const authorization = center.createApprovedMobileAuthorization(userId, {
        deviceId: challenge.device_external_id,
        deviceName: challenge.device_name,
      });
      return {
        authorization_code: authorization.authorizationCode,
        expires_at: new Date(authorization.expiresAt).toISOString(),
        server_url: settings.publicUrl,
      };
    }
    setSession(center, settings, reply, userId);
    return { user: center.account(userId), redirect_to: challenge.redirect_path || '/dashboard' };
  });

  app.post('/api/v1/device-authorizations', async (request, reply) => {
    const body = request.body as { mode?: string; device_id?: string; device_name?: string };
    const result = center.createDeviceAuthorization({
      mode: body.mode === 'device' ? 'device' : 'browser',
      deviceId: String(body.device_id ?? ''), deviceName: String(body.device_name ?? ''),
    });
    return reply.status(201).send(result);
  });

  app.post('/api/v1/device-authorizations/token', async (request, reply) => {
    const body = request.body as { poll_token?: string };
    const result = center.pollDeviceAuthorization(String(body.poll_token ?? ''));
    return result.status === 'pending' ? reply.status(202).send(result) : result;
  });

  app.post('/api/v1/device/token/revoke', async (request, reply) => {
    const authorization = String(request.headers.authorization ?? '');
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    center.revokePresentedToken(token);
    return reply.status(204).send();
  });

  app.get('/api/v1/device-authorizations/resolve', async request => {
    requireSession(center, settings, request);
    const query = request.query as { token?: string; code?: string };
    return center.lookupDeviceAuthorization({ browserToken: query.token, userCode: query.code });
  });

  app.post('/api/v1/device-authorizations/decision', async request => {
    const session = requireCsrf(center, settings, request);
    const body = request.body as { token?: string; code?: string; decision?: string };
    return center.decideDeviceAuthorization(session.userId, {
      browserToken: body.token, userCode: body.code,
      decision: body.decision === 'deny' ? 'deny' : 'approve',
    });
  });

  app.get('/auth/mobile/start', async (request, reply) => {
    const query = request.query as { return_uri?: string; device_id?: string; device_name?: string };
    const returnUri = normalizeReturnUri(query.return_uri);
    if (!returnUri) throw new CloudAuthError(400, 'invalid_return_uri', 'Octrix App 回调地址无效');
    const requestRecord = center.createMobileAuthorization({
      returnUri,
      deviceId: String(query.device_id ?? '').trim() || newId(),
      deviceName: String(query.device_name ?? 'iPhone').trim().slice(0, 255),
    });
    return reply.redirect(requestRecord.authorizeUrl, 303);
  });

  app.get('/api/v1/mobile-authorizations/resolve', async request => {
    requireSession(center, settings, request);
    return center.lookupMobileAuthorization(String((request.query as { token?: string }).token ?? ''));
  });

  app.post('/api/v1/mobile-authorizations/decision', async request => {
    const session = requireCsrf(center, settings, request);
    const body = request.body as { token?: string; decision?: string };
    return center.decideMobileAuthorization(session.userId, String(body.token ?? ''), body.decision === 'deny' ? 'deny' : 'approve');
  });

  app.post('/api/v1/mobile/auth/token', async request => {
    return center.exchangeMobileCode(String((request.body as { code?: string }).code ?? ''));
  });

  app.get('/api/v1/account', async request => {
    const session = requireSession(center, settings, request);
    const online = deps.onlineDeviceIds?.(session.userId) ?? new Set<string>();
    const devices = center.listDevices(session.userId).map(device => ({ ...device, online: device.kind === 'mac' ? online.has(device.external_id) : undefined }));
    const sessions = center.sessions(session.userId).map(item => ({ ...item, current: item.id === session.sessionId }));
    return {
      user: center.account(session.userId),
      devices,
      sessions,
      events: center.events(session.userId),
      auth_methods: {
        apple: appleAuthConfigured(settings),
        google: googleAuthConfigured(settings),
        sms: smsReady(settings, sms),
      },
    };
  });

  app.delete('/api/v1/account', async (request, reply) => {
    const hasBearerToken = /^Bearer\s+/i.test(String(request.headers.authorization ?? ''));
    const userId = hasBearerToken
      ? requireClientActor(center, request).ownerUserId
      : requireCsrf(center, settings, request).userId;
    for (const credential of center.appleRefreshTokens(userId)) {
      let refreshToken: string;
      try {
        refreshToken = decryptAppleRefreshToken(credential.ciphertext, settings.tokenPepper);
      } catch {
        throw new CloudAuthError(500, 'apple_refresh_token_invalid', 'Apple 登录凭证无法读取');
      }
      try {
        await (deps.appleTokenRevoker ?? revokeAppleToken)(settings, refreshToken, credential.clientId);
      } catch {
        throw new CloudAuthError(502, 'apple_token_revoke_failed', 'Apple 登录授权撤销失败');
      }
    }
    center.deleteAccount(userId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.patch('/api/v1/account/devices/:deviceId', async request => {
    const session = requireCsrf(center, settings, request);
    return { device: center.renameDevice(session.userId, (request.params as { deviceId: string }).deviceId, String((request.body as { name?: string }).name ?? '')) };
  });

  app.delete('/api/v1/account/devices/:deviceId', async (request, reply) => {
    const session = requireCsrf(center, settings, request);
    center.revokeDevice(session.userId, (request.params as { deviceId: string }).deviceId);
    return reply.status(204).send();
  });

  app.delete('/api/v1/account/mac-devices/:externalDeviceId', async (request, reply) => {
    const actor = requireClientActor(center, request);
    const externalDeviceId = (request.params as { externalDeviceId: string }).externalDeviceId;
    const device = center.listDevices(actor.ownerUserId, 'mac')
      .find(item => item.external_id === externalDeviceId);
    if (device) center.revokeDevice(actor.ownerUserId, device.id);
    return reply.status(204).send();
  });

  app.delete('/api/v1/account/sessions/:sessionId', async (request, reply) => {
    const session = requireCsrf(center, settings, request);
    center.revokeSession(session.userId, (request.params as { sessionId: string }).sessionId);
    return reply.status(204).send();
  });

  app.delete('/api/v1/account/identities/:identityId', async request => {
    const session = requireCsrf(center, settings, request);
    return { user: center.unlinkIdentity(session.userId, (request.params as { identityId: string }).identityId, session.sessionId) };
  });

  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const siteDist = deps.siteDist ?? resolve(sourceDir, '../site/dist');
  if (existsSync(join(siteDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: siteDist, wildcard: false });
    const indexHtml = readFileSync(join(siteDist, 'index.html'), 'utf8');
    app.get('/*', async (_, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
  } else {
    app.get('/', async (_, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>Octrix</title><h1>Octrix Cloud</h1><p>网站前端尚未构建。</p>'));
  }

  await app.ready();
  return app;
}
