import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ptyMock = vi.hoisted(() => {
  let latest: {
    emitData(data: string): void;
    writes: string[];
  } | undefined;

  return {
    spawn: vi.fn(() => {
      const dataHandlers: Array<(data: string) => void> = [];
      const writes: string[] = [];
      latest = {
        emitData(data: string) {
          for (const handler of dataHandlers) handler(data);
        },
        writes,
      };
      return {
        onData(handler: (data: string) => void) { dataHandlers.push(handler); },
        onExit() {},
        write(data: string) { writes.push(data); },
        resize() {},
        kill() {},
      };
    }),
    latest: () => latest,
  };
});

vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }));

import { ProcessManager } from './process-manager';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  ptyMock.spawn.mockClear();
});

function launchCodex(pm: ProcessManager) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-codex-activity-'));
  tempDirs.push(cwd);
  expect(pm.launchAgent({
    id: 'agent-codex',
    name: 'Codex CLI',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    platform: 'openai-codex-cli',
  }, 39800, cwd, 'group-1')).toBeUndefined();
  return ptyMock.latest()!;
}

describe('ProcessManager Codex terminal activity', () => {
  it('holds the first prompt through the prompt-before-MCP startup race and submits it once ready', async () => {
    const pm = new ProcessManager();
    try {
      const pty = launchCodex(pm);
      pty.emitData([
        '\x1b[2J\x1b[H',
        'OpenAI Codex (v0.144.5)\r\n',
        '› Find and fix a bug in @filename\r\n',
        'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
      ].join(''));

      await new Promise(resolve => setTimeout(resolve, 30));
      expect(pm.getBusyAgentIdsByGroup()).toEqual({ 'group-1': ['agent-codex'] });

      const prompt = '介绍一下这个项目';
      pm.sendKeys('agent-codex', prompt, 'group-1', undefined, 'response-1');
      pty.emitData([
        '\x1b[2J\x1b[H',
        'OpenAI Codex (v0.144.5)\r\n',
        '• Starting MCP servers (3/5): cloudflare-api, codex_apps (3s • esc to interrupt)\r\n',
        '› Find and fix a bug in @filename',
      ].join(''));

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(pty.writes).not.toContain(prompt);
      expect(pty.writes).not.toContain('\r');

      pty.emitData([
        '\x1b[2J\x1b[H',
        'OpenAI Codex (v0.144.5)\r\n',
        '› Find and fix a bug in @filename\r\n',
        'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
      ].join(''));

      await vi.waitFor(() => {
        expect(pty.writes.filter(write => write === prompt)).toHaveLength(1);
        expect(pty.writes.filter(write => write === '\r')).toHaveLength(1);
      }, { timeout: 3_000 });
    } finally {
      pm.destroy();
    }
  });

  it('does not declare Codex ready while MCP startup is visible', async () => {
    const pm = new ProcessManager();
    try {
      const pty = launchCodex(pm);
      pty.emitData([
        '\x1b[2J\x1b[H',
        `${'Codex startup output\r\n'.repeat(30)}`,
        '• Starting MCP servers (3/5): cloudflare-api, codex_apps (3s • esc to interrupt)\r\n',
        '› Find and fix a bug in @filename',
      ].join(''));

      await vi.waitFor(() => {
        expect(pm.getBusyAgentIdsByGroup()).toEqual({ 'group-1': ['agent-codex'] });
      });
      await expect(pm.waitForPtyReady('agent-codex', {
        waitForStable: true,
        timeoutMs: 50,
        groupId: 'group-1',
      })).resolves.toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('keeps Codex busy from the PTY Working screen and clears it after the screen becomes idle', async () => {
    const pm = new ProcessManager();
    try {
      const pty = launchCodex(pm);
      pty.emitData([
        '\x1b[2J\x1b[H',
        'OpenAI Codex (v0.144.5)\r\n',
        '• Working (16s • esc to interrupt)\r\n',
        '› Implement {feature}',
      ].join(''));

      await vi.waitFor(() => {
        expect(pm.getBusyAgentIdsByGroup()).toEqual({ 'group-1': ['agent-codex'] });
      });

      pty.emitData([
        '\x1b[2J\x1b[H',
        'OpenAI Codex (v0.144.5)\r\n',
        '• Finished the requested change.\r\n',
        '› Implement {feature}\r\n',
        'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
      ].join(''));

      await vi.waitFor(() => {
        expect(pm.getBusyAgentIdsByGroup()).toEqual({});
      }, { timeout: 3_000 });
      await expect(pm.waitForPtyReady('agent-codex', {
        waitForStable: true,
        timeoutMs: 100,
        groupId: 'group-1',
      })).resolves.toBe(true);
    } finally {
      pm.destroy();
    }
  });
});
