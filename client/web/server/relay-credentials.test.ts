import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRelayCredentialStore } from './relay-credentials.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('FileRelayCredentialStore', () => {
  it('开发环境凭证文件权限固定为 0600 且支持撤销', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-credential-'));
    dirs.push(dir);
    const file = path.join(dir, 'credentials.json');
    const store = new FileRelayCredentialStore(file);

    store.write('mac-1', 'secret-token');
    expect(store.read('mac-1')).toBe('secret-token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    store.delete('mac-1');
    expect(store.read('mac-1')).toBeNull();
  });
});
