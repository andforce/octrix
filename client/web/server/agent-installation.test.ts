import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENABLED_AGENTS, ENABLED_AGENT_PLATFORMS } from '../src/agent-platforms';
import { clearPlatformInstallStateCache, detectCommand, detectPlatformInstallState } from './agent-installation';
import { MACOS_APP_BIN_DIRS } from './cli-paths';

describe('detectCommand', () => {
  it('detects command from PATH', () => {
    expect(detectCommand('node')).toBe(true);
  });

  it('falls back to common bin directories when PATH is incomplete', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'agent-install-home-'));
    const localBin = join(tempHome, '.local', 'bin');
    const fakeCommand = 'agent-test-fallback';
    const fakeCommandPath = join(localBin, fakeCommand);
    mkdirSync(localBin, { recursive: true });
    writeFileSync(fakeCommandPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    chmodSync(fakeCommandPath, 0o755);

    try {
      expect(detectCommand(fakeCommand, { PATH: '/usr/bin:/bin', HOME: tempHome })).toBe(true);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('includes macOS app bundle CLI paths in fallback detection', () => {
    expect(MACOS_APP_BIN_DIRS).toContain('/Applications/Codex.app/Contents/Resources');
  });

  it('returns false for unknown command', () => {
    expect(detectCommand('command-that-does-not-exist-abc-123')).toBe(false);
  });

  it('returns true when command exists even if script interpreter is missing', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'agent-install-shebang-'));
    const localBin = join(tempHome, '.local', 'bin');
    const fakeCommand = 'agent-test-missing-interpreter';
    const fakeCommandPath = join(localBin, fakeCommand);
    mkdirSync(localBin, { recursive: true });
    writeFileSync(fakeCommandPath, '#!/usr/bin/env definitely-not-installed-cli-bridge\nexit 0\n', {
      mode: 0o755,
    });
    chmodSync(fakeCommandPath, 0o755);

    try {
      expect(detectCommand(fakeCommand, {
        PATH: '/usr/bin:/bin',
        HOME: tempHome,
        CLI_BRIDGE_NODE: '/definitely/missing/node',
      })).toBe(true);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('caches platform install state briefly and returns defensive copies', () => {
    clearPlatformInstallStateCache();
    const key = ENABLED_AGENTS[0].platform;
    const first = detectPlatformInstallState({ force: true, now: 1000, ttlMs: 1000 });
    const expected = first[key];

    first[key] = !expected;
    const second = detectPlatformInstallState({ now: 1500, ttlMs: 1000 });

    expect(second[key]).toBe(expected);
    clearPlatformInstallStateCache();
  });

  it('detects every platform currently exposed by the product', () => {
    const state = detectPlatformInstallState({ force: true });

    expect(Object.keys(state)).toEqual(ENABLED_AGENT_PLATFORMS);
    expect(state).toHaveProperty('opencode');
    expect(state).toHaveProperty('cursor-cli');
  });
});
