import path from 'node:path';
import os from 'node:os';

export const MACOS_APP_BIN_DIRS = [
  '/Applications/Codex.app/Contents/Resources',
];

export const SYSTEM_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export function userBinDirs(homeDir: string = os.homedir()): string[] {
  return [
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
  ];
}
