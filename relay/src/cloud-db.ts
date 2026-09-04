import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { schema } from './cloud-schema.js';

function sqlitePath(databaseUrl: string): string {
  if (databaseUrl === ':memory:' || databaseUrl === 'file::memory:') return ':memory:';
  if (databaseUrl.startsWith('sqlite:///')) return databaseUrl.slice('sqlite://'.length);
  if (databaseUrl.startsWith('file:')) return databaseUrl.slice('file:'.length);
  throw new Error('OCTRIX_DATABASE_URL 仅支持 sqlite:/// 或 file:');
}

function initializeSchema(sqlite: Database.Database): void {
  sqlite.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT, picture_url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL, subject TEXT NOT NULL, identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
  apple_refresh_token_ciphertext TEXT, apple_client_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_provider_subject ON user_identities(provider, subject);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY, session_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, redirect_path TEXT NOT NULL,
  mode TEXT NOT NULL, initiator_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sms_challenges (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, flow TEXT NOT NULL,
  requester_user_id TEXT REFERENCES users(id), device_external_id TEXT, device_name TEXT, redirect_path TEXT,
  client_ip TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  verification_method TEXT NOT NULL DEFAULT 'provider', verification_code_hash TEXT,
  provider_error_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  retry_after INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS sms_phone_created ON sms_challenges(phone, created_at);
CREATE INDEX IF NOT EXISTS sms_ip_created ON sms_challenges(client_ip, created_at);
CREATE TABLE IF NOT EXISTS app_review_sms_failures (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, client_ip TEXT NOT NULL, attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_review_sms_failure_window
  ON app_review_sms_failures(phone, client_ip, attempted_at);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  external_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_kind_external ON devices(kind, external_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT REFERENCES devices(id),
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS device_authorizations (
  id TEXT PRIMARY KEY, poll_token_hash TEXT NOT NULL UNIQUE, browser_token_hash TEXT UNIQUE,
  user_code_hash TEXT UNIQUE, device_external_id TEXT NOT NULL, device_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS mobile_authorizations (
  id TEXT PRIMARY KEY, request_token_hash TEXT NOT NULL UNIQUE, app_code_hash TEXT UNIQUE,
  return_uri TEXT NOT NULL, device_external_id TEXT NOT NULL, device_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_id TEXT REFERENCES users(id),
  device_id TEXT REFERENCES devices(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY, owner_user_id TEXT REFERENCES users(id), event_type TEXT NOT NULL,
  device_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
`);

  const smsColumns = sqlite.prepare('PRAGMA table_info(sms_challenges)').all() as Array<{ name: string }>;
  if (!smsColumns.some(column => column.name === 'device_external_id')) {
    sqlite.exec('ALTER TABLE sms_challenges ADD COLUMN device_external_id TEXT');
  }
  if (!smsColumns.some(column => column.name === 'verification_method')) {
    sqlite.exec(`ALTER TABLE sms_challenges ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'provider'`);
  }
  if (!smsColumns.some(column => column.name === 'verification_code_hash')) {
    sqlite.exec('ALTER TABLE sms_challenges ADD COLUMN verification_code_hash TEXT');
  }

  const identityColumns = sqlite.prepare('PRAGMA table_info(user_identities)').all() as Array<{ name: string }>;
  if (!identityColumns.some(column => column.name === 'apple_refresh_token_ciphertext')) {
    sqlite.exec('ALTER TABLE user_identities ADD COLUMN apple_refresh_token_ciphertext TEXT');
  }
  if (!identityColumns.some(column => column.name === 'apple_client_id')) {
    sqlite.exec('ALTER TABLE user_identities ADD COLUMN apple_client_id TEXT');
  }
}

export function openCloudDatabase(databaseUrl: string) {
  const path = sqlitePath(databaseUrl);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  initializeSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export type CloudDatabase = ReturnType<typeof openCloudDatabase>;
