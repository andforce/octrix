import type { CloudDatabase } from './cloud-db.js';
import type { CloudSettings } from './cloud-config.js';
import {
  formatDeviceCode,
  generateDeviceCode,
  newId,
  normalizeDeviceCode,
  randomToken,
  tokenHash,
} from './cloud-security.js';
import { maskPhone } from './sms.js';

export type IdentityProvider = 'apple' | 'google' | 'sms';
export type TokenScope = 'relay:device' | 'relay:client';

export interface AuthenticatedActor {
  kind: 'device' | 'client';
  ownerUserId: string;
  deviceId: string;
  externalDeviceId: string;
  tokenId: string;
}

export interface PublicAccount {
  id: string;
  name: string | null;
  picture_url: string | null;
  primary_label: string;
  identities: Array<{ id: string; provider: IdentityProvider; label: string }>;
}

export interface PublicDevice {
  id: string;
  kind: 'mac' | 'ios';
  external_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  online?: boolean;
}

export class CloudAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function rowOrNull<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

function rows<T>(value: unknown[]): T[] {
  return value as T[];
}

function iso(value: number | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export class AuthorizationCenter {
  private readonly revokedListeners = new Set<(tokenId: string, deviceId: string | null) => void>();

  constructor(
    readonly database: CloudDatabase,
    readonly settings: CloudSettings,
    private readonly now: () => number = () => Date.now(),
  ) {}

  close(): void {
    this.database.sqlite.close();
  }

  onTokenRevoked(listener: (tokenId: string, deviceId: string | null) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  authenticate(token: string): AuthenticatedActor | null {
    if (!token) return null;
    const row = rowOrNull<{
      id: string;
      scope: TokenScope;
      owner_user_id: string;
      device_id: string;
      external_id: string;
      revoked_at: number | null;
      device_revoked_at: number | null;
    }>(this.database.sqlite.prepare(`
      SELECT t.id, t.scope, t.owner_user_id, t.device_id, d.external_id,
             t.revoked_at, d.revoked_at AS device_revoked_at
      FROM auth_tokens t JOIN devices d ON d.id = t.device_id
      WHERE t.token_hash = ?
    `).get(tokenHash(token, this.settings.tokenPepper)));
    if (!row || row.revoked_at || row.device_revoked_at) return null;
    if (row.scope !== 'relay:device' && row.scope !== 'relay:client') return null;
    this.database.sqlite.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?').run(this.now(), row.id);
    this.database.sqlite.prepare('UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(this.now(), this.now(), row.device_id);
    return {
      kind: row.scope === 'relay:device' ? 'device' : 'client',
      ownerUserId: row.owner_user_id,
      deviceId: row.device_id,
      externalDeviceId: row.external_id,
      tokenId: row.id,
    };
  }

  resolveIdentity(input: {
    provider: IdentityProvider;
    subject: string;
    identifier: string;
    targetUserId?: string;
    name?: string | null;
    pictureUrl?: string | null;
  }): string {
    const timestamp = this.now();
    const existing = rowOrNull<{ id: string; user_id: string }>(this.database.sqlite
      .prepare('SELECT id, user_id FROM user_identities WHERE provider = ? AND subject = ?')
      .get(input.provider, input.subject));
    let userId = input.targetUserId ?? existing?.user_id;
    if (!userId) {
      userId = newId();
      this.database.sqlite.prepare(`
        INSERT INTO users (id, name, picture_url, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, input.name ?? null, input.pictureUrl ?? null, timestamp, timestamp, timestamp);
    }
    if (existing && existing.user_id !== userId) {
      userId = this.mergeUsers(userId, existing.user_id);
    }
    if (existing) {
      this.database.sqlite.prepare(`
        UPDATE user_identities SET user_id = ?, identifier = ?, last_used_at = ? WHERE id = ?
      `).run(userId, input.identifier, timestamp, existing.id);
    } else {
      this.database.sqlite.prepare(`
        INSERT INTO user_identities (id, user_id, provider, subject, identifier, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newId(), userId, input.provider, input.subject, input.identifier, timestamp, timestamp);
    }
    this.database.sqlite.prepare(`
      UPDATE users SET
        name = CASE WHEN ? IS NULL OR ? = '' THEN name ELSE ? END,
        picture_url = CASE WHEN ? IS NULL OR ? = '' THEN picture_url ELSE ? END,
        updated_at = ?, last_login_at = ? WHERE id = ?
    `).run(
      input.name ?? null, input.name ?? null, input.name ?? null,
      input.pictureUrl ?? null, input.pictureUrl ?? null, input.pictureUrl ?? null,
      timestamp, timestamp, userId,
    );
    this.audit(userId, 'identity.used', null, { provider: input.provider });
    return userId;
  }

  account(userId: string): PublicAccount {
    const user = rowOrNull<{ id: string; name: string | null; picture_url: string | null }>(
      this.database.sqlite.prepare('SELECT id, name, picture_url FROM users WHERE id = ?').get(userId),
    );
    if (!user) throw new CloudAuthError(404, 'account_not_found', '账号不存在');
    const identities = rows<{ id: string; provider: IdentityProvider; identifier: string }>(
      this.database.sqlite.prepare('SELECT id, provider, identifier FROM user_identities WHERE user_id = ? ORDER BY created_at').all(userId),
    ).map(identity => ({
      id: identity.id,
      provider: identity.provider,
      label: identity.provider === 'sms' ? maskPhone(identity.identifier) : identity.identifier,
    }));
    return {
      id: user.id,
      name: user.name,
      picture_url: user.picture_url,
      primary_label: user.name || identities[0]?.label || 'Octrix 用户',
      identities,
    };
  }

  unlinkIdentity(userId: string, identityId: string, keepSessionId?: string): PublicAccount {
    const count = rowOrNull<{ count: number }>(this.database.sqlite
      .prepare('SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?').get(userId))?.count ?? 0;
    if (count <= 1) throw new CloudAuthError(409, 'last_identity', '账号至少需要保留一种登录方式');
    const result = this.database.sqlite.prepare('DELETE FROM user_identities WHERE id = ? AND user_id = ?').run(identityId, userId);
    if (!result.changes) throw new CloudAuthError(404, 'identity_not_found', '登录方式不存在');
    if (keepSessionId) {
      this.database.sqlite.prepare('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL')
        .run(this.now(), userId, keepSessionId);
    }
    this.audit(userId, 'identity.unlinked', null, {});
    return this.account(userId);
  }

  createDeviceAuthorization(input: { mode: 'browser' | 'device'; deviceId: string; deviceName: string }) {
    if (!input.deviceId.trim() || !input.deviceName.trim()) {
      throw new CloudAuthError(400, 'invalid_device', '设备 ID 和名称不能为空');
    }
    const pollToken = randomToken();
    const browserToken = input.mode === 'browser' ? randomToken() : null;
    let userCode: string | null = null;
    for (let attempt = 0; attempt < 8 && !userCode; attempt += 1) {
      const candidate = generateDeviceCode();
      const exists = this.database.sqlite.prepare('SELECT 1 FROM device_authorizations WHERE user_code_hash = ?').get(
        tokenHash(candidate, this.settings.tokenPepper),
      );
      if (!exists) userCode = candidate;
    }
    if (input.mode === 'device' && !userCode) throw new Error('无法生成唯一设备授权码');
    const id = newId();
    const expiresAt = this.now() + this.settings.authorizationTtlSeconds * 1000;
    this.database.sqlite.prepare(`
      INSERT INTO device_authorizations
      (id, poll_token_hash, browser_token_hash, user_code_hash, device_external_id, device_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      tokenHash(pollToken, this.settings.tokenPepper),
      browserToken ? tokenHash(browserToken, this.settings.tokenPepper) : null,
      userCode ? tokenHash(userCode, this.settings.tokenPepper) : null,
      input.deviceId.trim(), input.deviceName.trim().slice(0, 255), this.now(), expiresAt,
    );
    const verificationUri = `${this.settings.publicUrl}/activate`;
    return {
      id,
      poll_token: pollToken,
      verification_uri: verificationUri,
      browser_url: browserToken ? `${this.settings.publicUrl}/authorize/device?token=${encodeURIComponent(browserToken)}` : undefined,
      user_code: userCode ? formatDeviceCode(userCode) : undefined,
      expires_at: new Date(expiresAt).toISOString(),
      interval: this.settings.authorizationPollSeconds,
    };
  }

  lookupDeviceAuthorization(input: { browserToken?: string; userCode?: string }) {
    const row = input.browserToken
      ? rowOrNull<{ id: string; device_name: string; device_external_id: string; status: string; expires_at: number }>(
        this.database.sqlite.prepare(`SELECT id, device_name, device_external_id, status, expires_at FROM device_authorizations WHERE browser_token_hash = ?`)
          .get(tokenHash(input.browserToken, this.settings.tokenPepper)),
      )
      : input.userCode
        ? rowOrNull<{ id: string; device_name: string; device_external_id: string; status: string; expires_at: number }>(
          this.database.sqlite.prepare(`SELECT id, device_name, device_external_id, status, expires_at FROM device_authorizations WHERE user_code_hash = ?`)
            .get(tokenHash(normalizeDeviceCode(input.userCode), this.settings.tokenPepper)),
        )
        : null;
    if (!row) throw new CloudAuthError(404, 'authorization_not_found', '授权请求不存在');
    if (row.expires_at <= this.now()) throw new CloudAuthError(410, 'authorization_expired', '授权请求已过期');
    return { id: row.id, device_name: row.device_name, device_id: row.device_external_id, status: row.status };
  }

  decideDeviceAuthorization(userId: string, input: { browserToken?: string; userCode?: string; decision: 'approve' | 'deny' }) {
    const row = this.lookupDeviceAuthorization(input);
    if (row.status !== 'pending') throw new CloudAuthError(409, 'authorization_decided', '授权请求已经处理');
    if (input.decision === 'approve') this.assertDeviceOwnership(userId, 'mac', row.device_id);
    this.database.sqlite.prepare(`
      UPDATE device_authorizations SET status = ?, user_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'
    `).run(input.decision === 'approve' ? 'approved' : 'denied', userId, this.now(), row.id);
    this.audit(userId, `device.authorization.${input.decision}`, null, { device_name: row.device_name });
    return { status: input.decision === 'approve' ? 'approved' : 'denied' };
  }

  pollDeviceAuthorization(pollToken: string) {
    const row = rowOrNull<{
      id: string; status: string; user_id: string | null; device_external_id: string;
      device_name: string; expires_at: number; consumed_at: number | null;
    }>(this.database.sqlite.prepare('SELECT * FROM device_authorizations WHERE poll_token_hash = ?')
      .get(tokenHash(pollToken, this.settings.tokenPepper)));
    if (!row) throw new CloudAuthError(404, 'authorization_not_found', '授权请求不存在');
    if (row.expires_at <= this.now()) throw new CloudAuthError(410, 'authorization_expired', '授权请求已过期');
    if (row.status === 'denied') throw new CloudAuthError(403, 'authorization_denied', '用户拒绝了授权请求');
    if (row.status !== 'approved' || !row.user_id) return { status: row.status, interval: this.settings.authorizationPollSeconds };
    if (row.consumed_at) throw new CloudAuthError(409, 'authorization_consumed', '授权请求已经使用');
    const issued = this.database.sqlite.transaction(() => {
      const claimed = this.database.sqlite.prepare('UPDATE device_authorizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(this.now(), row.id);
      if (claimed.changes !== 1) throw new CloudAuthError(409, 'authorization_consumed', '授权请求已经使用');
      const result = this.issueDeviceToken(row.user_id!, 'mac', row.device_external_id, row.device_name, 'relay:device');
      this.audit(row.user_id!, 'device.authorized', result.device.id, { kind: 'mac' });
      return result;
    })();
    return {
      status: 'approved',
      access_token: issued.token,
      token_type: 'Bearer',
      server_url: this.settings.publicUrl,
      user: this.account(row.user_id),
      device: issued.device,
    };
  }

  createMobileAuthorization(input: { returnUri: string; deviceId: string; deviceName: string }) {
    const uri = new URL(input.returnUri);
    if (uri.protocol !== 'octrix:' || uri.host !== 'auth') {
      throw new CloudAuthError(400, 'invalid_return_uri', 'Octrix App 回调地址无效');
    }
    const requestToken = randomToken();
    const id = newId();
    const expiresAt = this.now() + this.settings.authorizationTtlSeconds * 1000;
    this.database.sqlite.prepare(`
      INSERT INTO mobile_authorizations
      (id, request_token_hash, return_uri, device_external_id, device_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, tokenHash(requestToken, this.settings.tokenPepper), uri.toString(), input.deviceId, input.deviceName, this.now(), expiresAt);
    return { id, requestToken, authorizeUrl: `${this.settings.publicUrl}/authorize/mobile?token=${encodeURIComponent(requestToken)}` };
  }

  createApprovedMobileAuthorization(
    userId: string,
    input: { deviceId: string; deviceName: string; method?: 'sms' | 'apple' },
  ) {
    this.assertDeviceOwnership(userId, 'ios', input.deviceId);
    const requestToken = randomToken();
    const authorizationCode = randomToken();
    const id = newId();
    const expiresAt = this.now() + this.settings.authorizationTtlSeconds * 1000;
    this.database.sqlite.prepare(`
      INSERT INTO mobile_authorizations
      (id, request_token_hash, app_code_hash, return_uri, device_external_id, device_name,
       status, user_id, created_at, expires_at, decided_at)
      VALUES (?, ?, ?, 'octrix://auth', ?, ?, 'approved', ?, ?, ?, ?)
    `).run(
      id,
      tokenHash(requestToken, this.settings.tokenPepper),
      tokenHash(authorizationCode, this.settings.tokenPepper),
      input.deviceId,
      input.deviceName,
      userId,
      this.now(),
      expiresAt,
      this.now(),
    );
    this.audit(userId, 'mobile.authorization.approve', null, {
      device_name: input.deviceName,
      method: input.method ?? 'sms',
    });
    return { authorizationCode, expiresAt };
  }

  lookupMobileAuthorization(requestToken: string) {
    const row = rowOrNull<{ id: string; device_name: string; device_external_id: string; status: string; expires_at: number }>(
      this.database.sqlite.prepare(`SELECT id, device_name, device_external_id, status, expires_at FROM mobile_authorizations WHERE request_token_hash = ?`)
        .get(tokenHash(requestToken, this.settings.tokenPepper)),
    );
    if (!row) throw new CloudAuthError(404, 'authorization_not_found', '移动端授权请求不存在');
    if (row.expires_at <= this.now()) throw new CloudAuthError(410, 'authorization_expired', '移动端授权请求已过期');
    return { id: row.id, device_name: row.device_name, device_id: row.device_external_id, status: row.status };
  }

  decideMobileAuthorization(userId: string, requestToken: string, decision: 'approve' | 'deny') {
    const row = this.lookupMobileAuthorization(requestToken);
    if (row.status !== 'pending') throw new CloudAuthError(409, 'authorization_decided', '授权请求已经处理');
    const stored = rowOrNull<{ return_uri: string }>(this.database.sqlite.prepare('SELECT return_uri FROM mobile_authorizations WHERE id = ?').get(row.id));
    if (decision === 'deny') {
      this.database.sqlite.prepare(`UPDATE mobile_authorizations SET status = 'denied', user_id = ?, decided_at = ? WHERE id = ?`)
        .run(userId, this.now(), row.id);
      const callback = new URL(stored!.return_uri);
      callback.searchParams.set('error', 'access_denied');
      this.audit(userId, 'mobile.authorization.deny', null, { device_name: row.device_name });
      return { status: 'denied' as const, callback_url: callback.toString() };
    }
    this.assertDeviceOwnership(userId, 'ios', row.device_id);
    const rawCode = randomToken();
    this.database.sqlite.prepare(`
      UPDATE mobile_authorizations SET status = 'approved', user_id = ?, app_code_hash = ?, decided_at = ? WHERE id = ?
    `).run(userId, tokenHash(rawCode, this.settings.tokenPepper), this.now(), row.id);
    const callback = new URL(stored!.return_uri);
    callback.searchParams.set('code', rawCode);
    callback.searchParams.set('server', this.settings.publicUrl);
    this.audit(userId, 'mobile.authorization.approve', null, { device_name: row.device_name });
    return { status: 'approved' as const, callback_url: callback.toString() };
  }

  exchangeMobileCode(code: string) {
    const row = rowOrNull<{
      id: string; user_id: string; device_external_id: string; device_name: string;
      expires_at: number; consumed_at: number | null;
    }>(this.database.sqlite.prepare(`
      SELECT id, user_id, device_external_id, device_name, expires_at, consumed_at
      FROM mobile_authorizations WHERE app_code_hash = ? AND status = 'approved'
    `).get(tokenHash(code, this.settings.tokenPepper)));
    if (!row) throw new CloudAuthError(404, 'mobile_code_not_found', '移动端授权码无效');
    if (row.expires_at <= this.now()) throw new CloudAuthError(410, 'mobile_code_expired', '移动端授权码已过期');
    if (row.consumed_at) throw new CloudAuthError(409, 'mobile_code_consumed', '移动端授权码已经使用');
    const issued = this.issueDeviceToken(row.user_id, 'ios', row.device_external_id, row.device_name, 'relay:client');
    this.database.sqlite.prepare('UPDATE mobile_authorizations SET consumed_at = ?, device_id = ? WHERE id = ? AND consumed_at IS NULL')
      .run(this.now(), issued.device.id, row.id);
    return {
      access_token: issued.token,
      token_type: 'Bearer',
      server_url: this.settings.publicUrl,
      user: this.account(row.user_id),
      device: issued.device,
    };
  }

  listDevices(userId: string, kind?: 'mac' | 'ios'): PublicDevice[] {
    const deviceRows = rows<{
      id: string; kind: 'mac' | 'ios'; external_id: string; name: string;
      created_at: number; last_seen_at: number | null;
    }>(kind
      ? this.database.sqlite.prepare(`SELECT id, kind, external_id, name, created_at, last_seen_at FROM devices WHERE owner_user_id = ? AND kind = ? AND revoked_at IS NULL ORDER BY updated_at DESC`).all(userId, kind)
      : this.database.sqlite.prepare(`SELECT id, kind, external_id, name, created_at, last_seen_at FROM devices WHERE owner_user_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC`).all(userId));
    return deviceRows.map(row => ({ ...row, created_at: iso(row.created_at)!, last_seen_at: iso(row.last_seen_at) }));
  }

  renameDevice(userId: string, deviceId: string, name: string): PublicDevice {
    const cleanName = name.trim().slice(0, 255);
    if (!cleanName) throw new CloudAuthError(400, 'invalid_name', '设备名称不能为空');
    const changed = this.database.sqlite.prepare(`UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`)
      .run(cleanName, this.now(), deviceId, userId);
    if (!changed.changes) throw new CloudAuthError(404, 'device_not_found', '设备不存在');
    this.audit(userId, 'device.renamed', deviceId, {});
    return this.listDevices(userId).find(device => device.id === deviceId)!;
  }

  revokeDevice(userId: string, deviceId: string): void {
    const tokenRows = rows<{ id: string }>(this.database.sqlite.prepare(`SELECT id FROM auth_tokens WHERE device_id = ? AND owner_user_id = ? AND revoked_at IS NULL`).all(deviceId, userId));
    const timestamp = this.now();
    const changed = this.database.sqlite.prepare('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL')
      .run(timestamp, timestamp, deviceId, userId);
    if (!changed.changes) throw new CloudAuthError(404, 'device_not_found', '设备不存在');
    this.database.sqlite.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(timestamp, deviceId);
    for (const token of tokenRows) for (const listener of this.revokedListeners) listener(token.id, deviceId);
    this.audit(userId, 'device.revoked', deviceId, {});
  }

  revokeToken(tokenId: string, userId: string): void {
    const row = rowOrNull<{ device_id: string | null }>(this.database.sqlite.prepare(`SELECT device_id FROM auth_tokens WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`).get(tokenId, userId));
    if (!row) throw new CloudAuthError(404, 'token_not_found', '授权凭证不存在');
    this.database.sqlite.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ?').run(this.now(), tokenId);
    for (const listener of this.revokedListeners) listener(tokenId, row.device_id);
    this.audit(userId, 'token.revoked', row.device_id, {});
  }

  revokePresentedToken(rawToken: string): void {
    const actor = this.authenticate(rawToken);
    if (!actor) throw new CloudAuthError(401, 'invalid_token', '设备授权无效或已撤销');
    this.revokeToken(actor.tokenId, actor.ownerUserId);
  }

  updateConnectedDevice(actor: AuthenticatedActor, name: string): void {
    if (actor.kind !== 'device') return;
    this.database.sqlite.prepare(`UPDATE devices SET name = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(name.slice(0, 255), this.now(), this.now(), actor.deviceId);
  }

  events(userId: string, limit = 30) {
    return rows<{ id: string; event_type: string; device_id: string | null; metadata_json: string; created_at: number }>(
      this.database.sqlite.prepare(`SELECT id, event_type, device_id, metadata_json, created_at FROM auth_events WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(userId, Math.min(Math.max(limit, 1), 100)),
    ).map(row => ({ ...row, metadata: JSON.parse(row.metadata_json), created_at: iso(row.created_at) }));
  }

  sessions(userId: string) {
    return rows<{ id: string; created_at: number; expires_at: number }>(this.database.sqlite.prepare(`
      SELECT id, created_at, expires_at FROM web_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC
    `).all(userId, this.now())).map(row => ({ id: row.id, created_at: iso(row.created_at), expires_at: iso(row.expires_at) }));
  }

  revokeSession(userId: string, sessionId: string): void {
    const result = this.database.sqlite.prepare('UPDATE web_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(this.now(), sessionId, userId);
    if (!result.changes) throw new CloudAuthError(404, 'session_not_found', '会话不存在');
    this.audit(userId, 'session.revoked', null, {});
  }

  saveAppleRefreshToken(userId: string, subject: string, ciphertext: string, clientId: string): void {
    const result = this.database.sqlite.prepare(`
      UPDATE user_identities
      SET apple_refresh_token_ciphertext = ?, apple_client_id = ?
      WHERE user_id = ? AND provider = 'apple' AND subject = ?
    `).run(ciphertext, clientId, userId, subject);
    if (result.changes !== 1) throw new CloudAuthError(404, 'apple_identity_not_found', 'Apple 登录身份不存在');
  }

  appleRefreshTokens(userId: string): Array<{ ciphertext: string; clientId: string }> {
    return rows<{ ciphertext: string; clientId: string }>(this.database.sqlite.prepare(`
      SELECT apple_refresh_token_ciphertext AS ciphertext, apple_client_id AS clientId
      FROM user_identities
      WHERE user_id = ? AND provider = 'apple'
        AND apple_refresh_token_ciphertext IS NOT NULL AND apple_client_id IS NOT NULL
    `).all(userId));
  }

  deleteAccount(userId: string): void {
    const account = this.database.sqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!account) throw new CloudAuthError(404, 'account_not_found', '账号不存在');

    const tokenRows = rows<{ id: string; device_id: string | null }>(this.database.sqlite.prepare(`
      SELECT id, device_id FROM auth_tokens
      WHERE owner_user_id = ? AND revoked_at IS NULL
    `).all(userId));

    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(`
        DELETE FROM mobile_authorizations
        WHERE user_id = ? OR device_id IN (SELECT id FROM devices WHERE owner_user_id = ?)
      `).run(userId, userId);
      this.database.sqlite.prepare('DELETE FROM auth_tokens WHERE owner_user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM device_authorizations WHERE user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM oauth_states WHERE initiator_user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM sms_challenges WHERE requester_user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM auth_events WHERE owner_user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM user_identities WHERE user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM devices WHERE owner_user_id = ?').run(userId);
      this.database.sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
    })();

    for (const token of tokenRows) {
      for (const listener of this.revokedListeners) listener(token.id, token.device_id);
    }
  }

  private assertDeviceOwnership(userId: string, kind: 'mac' | 'ios', externalId: string): void {
    const existing = rowOrNull<{ owner_user_id: string; revoked_at: number | null }>(this.database.sqlite
      .prepare('SELECT owner_user_id, revoked_at FROM devices WHERE kind = ? AND external_id = ?')
      .get(kind, externalId));
    if (existing && existing.revoked_at === null && existing.owner_user_id !== userId) {
      throw new CloudAuthError(
        409,
        'device_owned_by_another_account',
        '该设备已绑定其他账号，请先在授权中心把 Google 与手机号绑定到同一账号，或改用原账号批准',
      );
    }
  }

  private issueDeviceToken(userId: string, kind: 'mac' | 'ios', externalId: string, name: string, scope: TokenScope) {
    const timestamp = this.now();
    const replacedTokenIds: string[] = [];
    let device = rowOrNull<{ id: string; owner_user_id: string; revoked_at: number | null }>(this.database.sqlite
      .prepare('SELECT id, owner_user_id, revoked_at FROM devices WHERE kind = ? AND external_id = ?')
      .get(kind, externalId));
    if (device) {
      if (device.owner_user_id !== userId && device.revoked_at === null) {
        throw new CloudAuthError(409, 'device_owned_by_another_account', '该设备已绑定其他账号');
      }
      replacedTokenIds.push(...rows<{ id: string }>(this.database.sqlite.prepare('SELECT id FROM auth_tokens WHERE device_id = ? AND revoked_at IS NULL').all(device.id)).map(token => token.id));
      this.database.sqlite.prepare(`UPDATE devices SET owner_user_id = ?, name = ?, revoked_at = NULL, updated_at = ?, last_seen_at = ? WHERE id = ?`)
        .run(userId, name, timestamp, timestamp, device.id);
      this.database.sqlite.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(timestamp, device.id);
    } else {
      device = { id: newId(), owner_user_id: userId, revoked_at: null };
      this.database.sqlite.prepare(`
        INSERT INTO devices (id, owner_user_id, kind, external_id, name, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(device.id, userId, kind, externalId, name, timestamp, timestamp, timestamp);
    }
    const rawToken = randomToken();
    this.database.sqlite.prepare(`
      INSERT INTO auth_tokens (id, token_hash, scope, owner_user_id, device_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), tokenHash(rawToken, this.settings.tokenPepper), scope, userId, device.id, timestamp, timestamp);
    for (const tokenId of replacedTokenIds) {
      for (const listener of this.revokedListeners) listener(tokenId, device.id);
    }
    return { token: rawToken, device: this.listDevices(userId).find(entry => entry.id === device!.id)! };
  }

  private mergeUsers(firstUserId: string, secondUserId: string): string {
    if (firstUserId === secondUserId) return firstUserId;
    const users = rows<{ id: string }>(this.database.sqlite.prepare('SELECT id FROM users WHERE id IN (?, ?)').all(firstUserId, secondUserId));
    if (users.length !== 2) throw new Error('无法合并不存在的账号');
    const canonical = users.find(user => user.id === firstUserId)!;
    const source = users.find(user => user.id === secondUserId)!;
    this.database.sqlite.transaction(() => {
      for (const [table, column] of [
        ['user_identities', 'user_id'], ['devices', 'owner_user_id'],
        ['auth_tokens', 'owner_user_id'], ['device_authorizations', 'user_id'],
        ['mobile_authorizations', 'user_id'], ['oauth_states', 'initiator_user_id'],
        ['sms_challenges', 'requester_user_id'], ['auth_events', 'owner_user_id'],
      ] as const) {
        this.database.sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(canonical.id, source.id);
      }
      this.database.sqlite.prepare('UPDATE web_sessions SET user_id = ?, revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?')
        .run(canonical.id, this.now(), source.id);
      this.database.sqlite.prepare('DELETE FROM users WHERE id = ?').run(source.id);
    })();
    return canonical.id;
  }

  private audit(userId: string | null, eventType: string, deviceId: string | null, metadata: Record<string, unknown>): void {
    this.database.sqlite.prepare(`INSERT INTO auth_events (id, owner_user_id, event_type, device_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId(), userId, eventType, deviceId, JSON.stringify(metadata), this.now());
  }
}
