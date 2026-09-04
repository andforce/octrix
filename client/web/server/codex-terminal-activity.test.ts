import { describe, expect, it } from 'vitest';
import { CodexTerminalActivityTracker } from './codex-terminal-activity';

async function render(tracker: CodexTerminalActivityTracker, content: string) {
  await tracker.write(content);
  return tracker.snapshot();
}

describe('CodexTerminalActivityTracker', () => {
  it('keeps Codex busy while MCP servers are starting even when the input prompt is visible', async () => {
    const tracker = new CodexTerminalActivityTracker();

    const state = await render(tracker, [
      '\x1b[2J\x1b[H',
      'OpenAI Codex (v0.144.5)\r\n',
      '• Starting MCP servers (3/5): cloudflare-api, codex_apps (3s • esc to interrupt)\r\n',
      '› Find and fix a bug in @filename\r\n',
      'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
    ].join(''));

    expect(state).toMatchObject({ phase: 'initializing', busy: true, ready: false });
  });

  it('keeps Codex busy while the current terminal screen says Working', async () => {
    const tracker = new CodexTerminalActivityTracker();

    const state = await render(tracker, [
      '\x1b[2J\x1b[H',
      'OpenAI Codex (v0.144.5)\r\n',
      '• Explored\r\n',
      '  └ Read context.md\r\n',
      '• Working (16s • esc to interrupt)\r\n',
      '› Implement {feature}\r\n',
      'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
    ].join(''));

    expect(state).toMatchObject({ phase: 'working', busy: true, ready: false });
  });

  it('uses the current rendered screen instead of stale status text in terminal history', async () => {
    const tracker = new CodexTerminalActivityTracker(200, 50, { startupSettleMs: 0 });
    await tracker.write([
      '\x1b[2J\x1b[H',
      'OpenAI Codex (v0.144.5)\r\n',
      '• Working (16s • esc to interrupt)\r\n',
      '› Implement {feature}',
    ].join(''));

    const state = await render(tracker, [
      '\x1b[2J\x1b[H',
      'OpenAI Codex (v0.144.5)\r\n',
      '• Finished the requested change.\r\n',
      '› Implement {feature}\r\n',
      'gpt-5.6-sol xhigh fast · ~/Desktop/Ker',
    ].join(''));

    expect(state).toMatchObject({ phase: 'idle', busy: false, ready: true });
  });

  it('keeps the first input prompt in startup until it remains stable', async () => {
    const tracker = new CodexTerminalActivityTracker(200, 50, { startupSettleMs: 20 });

    const firstPrompt = await render(tracker, [
      '\x1b[2J\x1b[H',
      'OpenAI Codex (v0.144.5)\r\n',
      '› Find and fix a bug in @filename',
    ].join(''));
    expect(firstPrompt).toMatchObject({ phase: 'initializing', busy: true, ready: false });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(tracker.snapshot()).toMatchObject({ phase: 'idle', busy: false, ready: true });
  });
});
