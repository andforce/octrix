import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  pictureUrl: text('picture_url'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const userIdentities = sqliteTable('user_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(),
  subject: text('subject').notNull(),
  identifier: text('identifier').notNull(),
  appleRefreshTokenCiphertext: text('apple_refresh_token_ciphertext'),
  appleClientId: text('apple_client_id'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
}, table => ({ providerSubject: uniqueIndex('identity_provider_subject').on(table.provider, table.subject) }));

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  kind: text('kind').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
}, table => ({ kindExternal: uniqueIndex('devices_kind_external').on(table.kind, table.externalId) }));

export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  deviceId: text('device_id').references(() => devices.id),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export const schema = { users, userIdentities, devices, authTokens };
