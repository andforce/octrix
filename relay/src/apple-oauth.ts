import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { CloudSettings } from './cloud-config.js';

export const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

function appleTokenEncryptionKey(tokenPepper: string): Buffer {
  return createHash('sha256').update(`octrix:apple-refresh-token:${tokenPepper}`, 'utf8').digest();
}

export function encryptAppleRefreshToken(token: string, tokenPepper: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', appleTokenEncryptionKey(tokenPepper), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptAppleRefreshToken(value: string, tokenPepper: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) throw new Error('Apple refresh token ciphertext is invalid');
  const decipher = createDecipheriv('aes-256-gcm', appleTokenEncryptionKey(tokenPepper), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export async function createAppleClientSecret(
  settings: CloudSettings,
  now = Date.now(),
  clientId = settings.appleOAuthClientId,
): Promise<string> {
  const key = await importPKCS8(settings.appleOAuthPrivateKey, 'ES256');
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: settings.appleOAuthKeyId })
    .setIssuer(settings.appleOAuthTeamId)
    .setAudience(APPLE_ISSUER)
    .setSubject(clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(key);
}

export async function exchangeAppleCode(settings: CloudSettings, code: string): Promise<Record<string, unknown>> {
  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.appleOAuthClientId,
      client_secret: await createAppleClientSecret(settings),
      redirect_uri: `${settings.publicUrl}/auth/apple/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) throw new Error('Apple token exchange failed');
  return await response.json() as Record<string, unknown>;
}

export async function exchangeAppleNativeCode(settings: CloudSettings, code: string): Promise<Record<string, unknown>> {
  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.appleNativeClientId,
      client_secret: await createAppleClientSecret(settings, Date.now(), settings.appleNativeClientId),
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) throw new Error('Apple native token exchange failed');
  return await response.json() as Record<string, unknown>;
}

export async function revokeAppleToken(settings: CloudSettings, token: string, clientId: string): Promise<void> {
  if (![settings.appleOAuthClientId, settings.appleNativeClientId].includes(clientId)) {
    throw new Error('Apple client identifier is invalid');
  }
  const response = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: await createAppleClientSecret(settings, Date.now(), clientId),
      token,
      token_type_hint: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error('Apple token revocation failed');
}

export async function verifyAppleToken(settings: CloudSettings, idToken: string, nonce: string): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  const result = await jwtVerify(idToken, jwks, { issuer: APPLE_ISSUER, audience: settings.appleOAuthClientId });
  if (result.payload.nonce !== nonce) throw new Error('Apple nonce does not match');
  return result.payload;
}

export function hashAppleNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

export async function verifyAppleNativeToken(settings: CloudSettings, idToken: string, nonce: string): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  const result = await jwtVerify(idToken, jwks, { issuer: APPLE_ISSUER, audience: settings.appleNativeClientId });
  if (result.payload.nonce !== hashAppleNonce(nonce)) throw new Error('Apple native nonce does not match');
  return result.payload;
}

export function appleEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

export function appleDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName]
      .filter((part): part is string => typeof part === 'string')
      .map(part => part.replace(/[\u0000-\u001f\u007f]/g, '').trim())
      .filter(Boolean);
    return parts.join(' ').slice(0, 255) || null;
  } catch {
    return null;
  }
}

export function appleNameFromParts(firstName: unknown, lastName: unknown): string | null {
  const parts = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string')
    .map(part => part.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter(Boolean);
  return parts.join(' ').slice(0, 255) || null;
}
