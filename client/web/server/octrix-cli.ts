import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OctrixCliStatus } from '../src/types.js';

function launcherSourcePath(): string {
  return process.env.OCTRIX_CLI_SOURCE
    ?? path.resolve(process.cwd(), 'host', 'bin', 'octrix');
}

function readLauncher(sourcePath = launcherSourcePath()): string {
  return fs.readFileSync(sourcePath, 'utf8');
}

export function getOctrixCliStatus(
  home = os.homedir(),
  sourcePath = launcherSourcePath(),
): OctrixCliStatus {
  const target = path.join(home, '.local', 'bin', 'octrix');
  if (!fs.existsSync(target)) return { path: target, state: 'not_installed' };

  try {
    const content = fs.readFileSync(target, 'utf8');
    const executable = (fs.statSync(target).mode & 0o111) !== 0;
    return {
      path: target,
      state: content === readLauncher(sourcePath) && executable ? 'current' : 'outdated',
    };
  } catch {
    return { path: target, state: 'outdated' };
  }
}

export function installOctrixCli(
  home = os.homedir(),
  sourcePath = launcherSourcePath(),
): string {
  const binDir = path.join(home, '.local', 'bin');
  const target = path.join(binDir, 'octrix');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  fs.copyFileSync(sourcePath, target);
  fs.chmodSync(target, 0o755);
  return target;
}
