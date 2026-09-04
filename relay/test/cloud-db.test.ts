import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openCloudDatabase } from '../src/cloud-db.js';

describe('Octrix Cloud database migrations', () => {
  it('为已有身份与短信 challenge 表补充字段并保留数据', () => {
    const directory = mkdtempSync(join(tmpdir(), 'octrix-cloud-db-'));
    const path = join(directory, 'octrix.sqlite3');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT, picture_url TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER
      );
      CREATE TABLE user_identities (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        provider TEXT NOT NULL, subject TEXT NOT NULL, identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
      );
      CREATE TABLE sms_challenges (
        id TEXT PRIMARY KEY, phone TEXT NOT NULL, flow TEXT NOT NULL,
        requester_user_id TEXT REFERENCES users(id), device_external_id TEXT, device_name TEXT, redirect_path TEXT,
        client_ip TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        provider_error_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        retry_after INTEGER NOT NULL, consumed_at INTEGER
      );
      INSERT INTO users (id, created_at, updated_at) VALUES ('user-1', 1, 1);
      INSERT INTO user_identities
        (id, user_id, provider, subject, identifier, created_at, last_used_at)
      VALUES ('identity-1', 'user-1', 'apple', 'subject-1', 'private@example.com', 1, 1);
      INSERT INTO sms_challenges
        (id, phone, flow, client_ip, status, created_at, expires_at, retry_after)
      VALUES ('challenge-1', '+8613900139000', 'web_login', '127.0.0.1', 'sent', 1, 2, 2);
    `);
    legacy.close();

    const database = openCloudDatabase(`sqlite://${path}`);
    try {
      const columns = database.sqlite.prepare('PRAGMA table_info(user_identities)').all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
        'apple_refresh_token_ciphertext',
        'apple_client_id',
      ]));
      expect(database.sqlite.prepare('SELECT identifier FROM user_identities WHERE id = ?').get('identity-1'))
        .toMatchObject({ identifier: 'private@example.com' });
      const smsColumns = database.sqlite.prepare('PRAGMA table_info(sms_challenges)').all() as Array<{ name: string }>;
      expect(smsColumns.map(column => column.name)).toEqual(expect.arrayContaining([
        'verification_method',
        'verification_code_hash',
      ]));
      expect(database.sqlite.prepare('SELECT phone FROM sms_challenges WHERE id = ?').get('challenge-1'))
        .toMatchObject({ phone: '+8613900139000' });
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
