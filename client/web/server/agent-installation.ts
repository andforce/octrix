import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { ENABLED_AGENTS, type AgentPlatform } from '../src/agent-platforms.js';
import { MACOS_APP_BIN_DIRS, SYSTEM_BIN_DIRS } from './cli-paths.js';

export type PlatformInstallState = Partial<Record<AgentPlatform, boolean>>;

const COMMON_BIN_DIRS = [
  '~/.local/bin',
  '~/.cargo/bin',
  ...SYSTEM_BIN_DIRS,
  ...MACOS_APP_BIN_DIRS,
];
const INSTALL_STATE_CACHE_TTL_MS = 5000;

let installStateCache: { expiresAt: number; state: PlatformInstallState } | null = null;

function expandHome(path: string, homeDir?: string): string {
  if (!path.startsWith('~/') || !homeDir) return path;
  return join(homeDir, path.slice(2));
}

function resolveCandidateBinDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = new Set<string>();
  const pathValue = env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    const trimmed = dir.trim();
    if (trimmed) dirs.add(trimmed);
  }

  for (const dir of COMMON_BIN_DIRS) {
    const expanded = expandHome(dir, env.HOME);
    if (expanded) dirs.add(expanded);
  }

  const explicitNode = env.CLI_BRIDGE_NODE;
  if (explicitNode) dirs.add(dirname(explicitNode));

  if (process.execPath) dirs.add(dirname(process.execPath));

  return Array.from(dirs);
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('which', [command], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });
  const resolved = result.status === 0 ? result.stdout.trim() : '';
  if (resolved && isExecutable(resolved)) return resolved;

  for (const dir of resolveCandidateBinDirs(env)) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function detectCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveCommandPath(command, env) !== null;
}

export function detectPlatformInstallState(options: { force?: boolean; now?: number; ttlMs?: number } = {}): PlatformInstallState {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? INSTALL_STATE_CACHE_TTL_MS;
  if (!options.force && installStateCache && installStateCache.expiresAt > now) {
    return { ...installStateCache.state };
  }

  const installState = {} as PlatformInstallState;
  for (const platform of ENABLED_AGENTS) {
    installState[platform.platform] = detectCommand(platform.executable);
  }
  installStateCache = { state: installState, expiresAt: now + ttlMs };
  return { ...installState };
}

export function clearPlatformInstallStateCache() {
  installStateCache = null;
}
