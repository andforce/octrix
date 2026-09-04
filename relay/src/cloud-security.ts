import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function tokenHash(value: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${value}`, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newId(): string {
  return randomUUID().replaceAll('-', '');
}

const DEVICE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateDeviceCode(): string {
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += DEVICE_CODE_ALPHABET[randomBytes(1)[0] % DEVICE_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeDeviceCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export function formatDeviceCode(value: string): string {
  const code = normalizeDeviceCode(value);
  return code.length <= 4 ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
}
