import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface RelayCredentialStore {
  read(deviceId: string): string | null;
  write(deviceId: string, token: string): void;
  delete(deviceId: string): void;
}

const KEYCHAIN_SERVICE = 'work.octrix.relay';

export class MacKeychainCredentialStore implements RelayCredentialStore {
  read(deviceId: string): string | null {
    try {
      return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', deviceId, '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      return null;
    }
  }

  write(deviceId: string, token: string): void {
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', deviceId, '-w', token], {
      stdio: 'ignore',
    });
  }

  delete(deviceId: string): void {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', deviceId], { stdio: 'ignore' });
    } catch {
      // 删除不存在的钥匙串条目也视为成功。
    }
  }
}

export class FileRelayCredentialStore implements RelayCredentialStore {
  constructor(private readonly filePath = path.join(os.homedir(), '.config', 'octrix', 'relay-credentials.json')) {}

  read(deviceId: string): string | null {
    try {
      const values = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      return typeof values[deviceId] === 'string' ? values[deviceId] : null;
    } catch {
      return null;
    }
  }

  write(deviceId: string, token: string): void {
    const values = this.readAll();
    values[deviceId] = token;
    this.persist(values);
  }

  delete(deviceId: string): void {
    const values = this.readAll();
    delete values[deviceId];
    this.persist(values);
  }

  private readAll(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      return {};
    }
  }

  private persist(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
  }
}

export function defaultRelayCredentialStore(configPath?: string): RelayCredentialStore {
  if (configPath || process.platform !== 'darwin') {
    const filePath = configPath
      ? path.join(path.dirname(configPath), 'relay-credentials.json')
      : path.join(os.homedir(), '.config', 'octrix', 'relay-credentials.json');
    return new FileRelayCredentialStore(filePath);
  }
  return new MacKeychainCredentialStore();
}
