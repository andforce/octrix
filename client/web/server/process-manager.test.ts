import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  augmentedPath,
  parseAgentStartupPromptOutput,
  parseBypassPermissionsPromptOutput,
  parseModelPickerTerminalOutput,
  parseWorkspaceTrustPromptOutput,
  ProcessManager,
  resolveBinary,
  stripAnsi,
  usesGeminiInputMode,
} from './process-manager';
import { MACOS_APP_BIN_DIRS } from './cli-paths';

const tempDirs: string[] = [];
const CLAUDE_AGENT_CASES = [
  {
    id: 'claude-code',
    agentName: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    platform: 'claude-code',
  },
  {
    id: 'openclaude',
    agentName: 'OpenClaude',
    command: 'openclaude --permission-mode bypassPermissions',
    platform: 'openclaude',
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bridge-process-manager-'));
  tempDirs.push(dir);
  return dir;
}

describe('stripAnsi', () => {
  it('strips CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('strips bold/underline codes', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m \x1b[4munderline\x1b[24m')).toBe('bold underline');
  });

  it('strips cursor movement sequences', () => {
    expect(stripAnsi('hello\x1b[2Aworld')).toBe('helloworld');
  });

  it('strips cursor style sequences used by Codex CLI', () => {
    expect(stripAnsi('\x1b[0 q/model')).toBe('/model');
  });

  it('strips OSC sequences (window title etc)', () => {
    expect(stripAnsi('\x1b]0;My Title\x07actual content')).toBe('actual content');
  });

  it('normalizes CRLF to LF', () => {
    expect(stripAnsi('line1\r\nline2\r\n')).toBe('line1\nline2\n');
  });

  it('strips bare carriage returns (line overwriting)', () => {
    expect(stripAnsi('progress: 50%\rprogress: 100%')).toBe('progress: 50%progress: 100%');
  });

  it('preserves plain text and newlines', () => {
    const text = 'Hello World\nLine 2\n  indented';
    expect(stripAnsi(text)).toBe(text);
  });

  it('handles complex AI terminal output', () => {
    const raw = '\x1b[1;36mThinking:\x1b[0m analyzing the request...\n\x1b[32m✓\x1b[0m Done';
    expect(stripAnsi(raw)).toBe('Thinking: analyzing the request...\n✓ Done');
  });
});

describe('ProcessManager streaming fallback', () => {
  it('streams cleaned PTY output while a conversation watcher is not active yet', () => {
    const pm = new ProcessManager();
    const dir = makeTempDir();
    const logFilePath = path.join(dir, 'agent.log');
    fs.writeFileSync(logFilePath, 'partial answer from terminal');
    const streamed: Array<{
      agentName: string;
      groupId: string;
      taskSessionId: string | undefined;
      content: string;
      existingId: string | undefined;
    }> = [];

    try {
      pm.processes.push({
        id: 'proc-1',
        agentId: 'agent-1',
        groupId: 'group-1',
        name: 'Generic CLI',
        command: 'generic-agent',
        sessionName: 'session-1',
        launchedAt: Date.now(),
        isRunning: true,
        logFilePath,
      });
      (pm as any).conversationStates.set('proc-1', {
        watcher: { isActive: false, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });
      (pm as any).pendingResponses.set('proc-1', {
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        sentText: 'user prompt',
        createdAt: Date.now(),
      });
      pm.onAgentOutput = (agentName, groupId, taskSessionId, content, existingId) => {
        streamed.push({ agentName, groupId, taskSessionId, content, existingId });
        return 'message-1';
      };

      (pm as any).refreshAll();

      expect(streamed).toEqual([{
        agentName: 'Generic CLI',
        groupId: 'group-1',
        taskSessionId: 'task-1',
        content: 'partial answer from terminal',
        existingId: undefined,
      }]);
    } finally {
      pm.destroy();
    }
  });

  it('does not stream Codex PTY output while structured JSONL entries are still pending', () => {
    const pm = new ProcessManager();
    const dir = makeTempDir();
    const logFilePath = path.join(dir, 'codex.log');
    fs.writeFileSync(logFilePath, [
      'Improve documentation in @filename',
      'Working(0s • esc to interrupt)',
      '~/DesktopWorki-Working-Working',
    ].join('\n'));
    const streamed: Array<{
      content: string;
      existingId: string | undefined;
    }> = [];
    const completed: string[] = [];

    try {
      pm.processes.push({
        id: 'proc-codex',
        agentId: 'agent-codex',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex --dangerously-bypass-approvals-and-sandbox',
        platform: 'openai-codex-cli',
        sessionName: 'session-codex',
        launchedAt: Date.now(),
        isRunning: true,
        logFilePath,
      });
      (pm as any).conversationStates.set('proc-codex', {
        watcher: { isActive: true, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });
      (pm as any).pendingResponses.set('proc-codex', {
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        sentText: 'user prompt',
        createdAt: Date.now(),
      });
      pm.onAgentOutput = (_agentName, _groupId, _taskSessionId, content, existingId) => {
        streamed.push({ content, existingId });
        return 'message-1';
      };
      pm.onAgentOutputComplete = (_agentName, _groupId, _taskSessionId, content) => {
        completed.push(content);
      };

      (pm as any).refreshAll();
      (pm as any).refreshAll();
      (pm as any).refreshAll();

      expect(streamed).toEqual([]);
      expect(completed).toEqual([]);
      expect((pm as any).pendingResponses.has('proc-codex')).toBe(true);
    } finally {
      pm.destroy();
    }
  });

  it.each(CLAUDE_AGENT_CASES)('does not stream $agentName TUI output before the first JSONL session becomes active', (agent) => {
    const pm = new ProcessManager();
    const dir = makeTempDir();
    const logFilePath = path.join(dir, `${agent.id}.log`);
    fs.writeFileSync(logFilePath, [
      '› 测试首次',
      '· Contemplating...',
      '────────────────────────────────────────────────',
      '¥0.0000 turncache0%ctx0% · OK/1000K',
      '✱',
    ].join('\n'));
    const streamed: Array<{
      content: string;
      existingId: string | undefined;
    }> = [];

    try {
      pm.processes.push({
        id: `proc-${agent.id}-startup`,
        agentId: `agent-${agent.id}`,
        groupId: 'group-1',
        name: agent.agentName,
        command: agent.command,
        platform: agent.platform,
        sessionName: `session-${agent.id}`,
        launchedAt: Date.now(),
        isRunning: true,
        logFilePath,
      });
      (pm as any).conversationStates.set(`proc-${agent.id}-startup`, {
        watcher: { isActive: false, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });
      (pm as any).pendingResponses.set(`proc-${agent.id}-startup`, {
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        sentText: '测试首次',
        createdAt: Date.now(),
      });
      pm.onAgentOutput = (_agentName, _groupId, _taskSessionId, content, existingId) => {
        streamed.push({ content, existingId });
        return 'message-1';
      };

      (pm as any).refreshAll();
      (pm as any).refreshAll();

      expect(streamed).toEqual([]);
      expect((pm as any).pendingResponses.has(`proc-${agent.id}-startup`)).toBe(true);
    } finally {
      pm.destroy();
    }
  });
});

describe('ProcessManager response interruption', () => {
  it('cancels delayed prompt submission when stopped before Enter', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const write = vi.fn();

    try {
      pm.processes.push({
        id: 'proc-delayed-input',
        agentId: 'agent-delayed-input',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-delayed-input',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-delayed-input', 'proc-delayed-input');
      (pm as any).ptyProcesses.set('proc-delayed-input', { write, kill: vi.fn() });

      pm.sendKeys('agent-delayed-input', 'must not be submitted', 'group-1', 'task-1', 'response-1');
      expect(pm.interruptAgent(
        'agent-delayed-input', 'group-1', 'task-1', 'response-1',
      )).toBe(true);
      vi.advanceTimersByTime(1_000);

      expect(write.mock.calls.map(([value]) => value)).toEqual(['\x1b[I', '\x1b']);
    } finally {
      pm.destroy();
    }
  });

  it('cancels delayed Enter after prompt text has reached the CLI editor', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const write = vi.fn();

    try {
      pm.processes.push({
        id: 'proc-delayed-enter',
        agentId: 'agent-delayed-enter',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-delayed-enter',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-delayed-enter', 'proc-delayed-enter');
      (pm as any).ptyProcesses.set('proc-delayed-enter', { write, kill: vi.fn() });

      pm.sendKeys('agent-delayed-enter', 'draft only', 'group-1', 'task-1', 'response-1');
      vi.advanceTimersByTime(60);
      expect(pm.interruptAgent(
        'agent-delayed-enter', 'group-1', 'task-1', 'response-1',
      )).toBe(true);
      vi.advanceTimersByTime(1_000);

      expect(write.mock.calls.map(([value]) => value)).toEqual([
        '\x1b[I',
        'draft only',
        '\x1b',
        '\x15',
      ]);
      expect(write).not.toHaveBeenCalledWith('\r');
    } finally {
      pm.destroy();
    }
  });

  it('interrupts the matching response and keeps the CLI process online', () => {
    const pm = new ProcessManager();
    const write = vi.fn();
    const kill = vi.fn();
    const completed: Array<{ taskSessionId?: string; content: string }> = [];

    try {
      pm.processes.push({
        id: 'proc-1',
        agentId: 'agent-1',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-1',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', { write, kill });
      const conversationState = {
        watcher: { isActive: true, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      };
      (pm as any).conversationStates.set('proc-1', conversationState);
      (pm as any).pendingResponses.set('proc-1', {
        identity: {
          responseId: 'response-1',
          envelopeId: 'message-1',
        },
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        createdAt: Date.now(),
      });
      pm.onAgentOutputComplete = (_agentName, _groupId, taskSessionId, content) => {
        completed.push({ taskSessionId, content });
      };

      expect(pm.interruptAgent('agent-1', 'group-1', 'task-1', 'response-1')).toBe(true);

      expect(write).toHaveBeenCalledWith('\x1b');
      expect(completed).toEqual([{ taskSessionId: 'task-1', content: '' }]);
      expect((pm as any).pendingResponses.has('proc-1')).toBe(false);
      expect(conversationState).toMatchObject({ suppressUnclaimedUntil: expect.any(Number) });

      const emitEntries = vi.fn().mockReturnValue('message-2');
      pm.onConversationEntries = emitEntries;
      (pm as any).emitUnclaimedConversationEntries(pm.processes[0], conversationState, [
        { id: 'cancel-tail', role: 'thinking', content: 'cancelled', timestamp: 1 },
      ]);
      expect(emitEntries).not.toHaveBeenCalled();

      (pm as any).emitUnclaimedConversationEntries(pm.processes[0], conversationState, [
        { id: 'user-2', role: 'user', content: 'continue from terminal', timestamp: 2 },
        { id: 'assistant-2', role: 'assistant', content: 'continued', timestamp: 3 },
      ]);
      expect(emitEntries).toHaveBeenCalledWith(
        'OpenAI Codex CLI',
        'group-1',
        'task-1',
        [{ id: 'assistant-2', role: 'assistant', content: 'continued', timestamp: 3 }],
        undefined,
        'complete',
      );
      expect(pm.isAgentRunning('agent-1', 'group-1')).toBe(true);
    } finally {
      pm.destroy();
    }
  });

  it('does not interrupt a newer response in the same task session', () => {
    const pm = new ProcessManager();
    const write = vi.fn();
    const kill = vi.fn();

    try {
      pm.processes.push({
        id: 'proc-1',
        agentId: 'agent-1',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-1',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', { write, kill });
      (pm as any).pendingResponses.set('proc-1', {
        identity: { responseId: 'response-new' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });

      expect(pm.interruptAgent('agent-1', 'group-1', 'task-1', 'response-old')).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.has('proc-1')).toBe(true);
    } finally {
      pm.destroy();
    }
  });

  it('uses Ctrl+C to interrupt the current Gemini request', () => {
    const pm = new ProcessManager();
    const write = vi.fn();

    try {
      pm.processes.push({
        id: 'proc-gemini',
        agentId: 'agent-gemini',
        groupId: 'group-1',
        name: 'Gemini CLI',
        command: 'gemini',
        platform: 'gemini-cli',
        sessionName: 'session-gemini',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-gemini', 'proc-gemini');
      (pm as any).ptyProcesses.set('proc-gemini', { write, kill: vi.fn() });
      (pm as any).pendingResponses.set('proc-gemini', {
        identity: { responseId: 'response-1' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });

      expect(pm.interruptAgent('agent-gemini', 'group-1', 'task-1', 'response-1')).toBe(true);
      expect(write).toHaveBeenCalledWith('\x03');
    } finally {
      pm.destroy();
    }
  });

  it('does not let an interrupted transcript turn complete the next response', () => {
    const pm = new ProcessManager();
    const write = vi.fn();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-1',
        agentId: 'agent-1',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-1',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', { write, kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys('agent-1', 'first prompt', 'group-1', 'task-1', 'response-old');
      const state = (pm as any).conversationStates.get('proc-1');
      state.watcher.emit('entries', [{
        id: 'old-thinking',
        role: 'thinking',
        content: 'working',
        timestamp: 1,
        turnId: 'turn-old',
        source: 'codex_jsonl_event',
      }]);
      expect(pm.interruptAgent('agent-1', 'group-1', 'task-1', 'response-old')).toBe(true);

      emitted.mockClear();
      completed.mockClear();
      pm.sendKeys('agent-1', 'second prompt', 'group-1', 'task-1', 'response-next');
      state.watcher.emit('entries', [{
        id: 'old-complete',
        role: 'assistant',
        content: 'cancelled old response',
        timestamp: 2,
        turnId: 'turn-old',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.get('proc-1')).toMatchObject({
        identity: { responseId: 'response-next' },
      });
    } finally {
      pm.destroy();
    }
  });

  it('does not bind a late old Codex turn start to the next response', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-codex-race',
        agentId: 'agent-codex-race',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-codex-race',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-codex-race', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'first prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'second prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(250);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-old');
      state.watcher.emit('entries', [{
        id: 'old-user',
        role: 'user',
        content: 'first prompt',
        timestamp: 1,
        turnId: 'turn-old',
      }]);
      state.watcher.emit('entries', [{
        id: 'old-complete',
        role: 'assistant',
        content: 'cancelled old response',
        timestamp: 2,
        turnId: 'turn-old',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.get(proc.id)).toMatchObject({
        identity: { responseId: 'response-next' },
      });

      vi.advanceTimersByTime(250);
      state.watcher.emit('turn-started', 'turn-next');
      state.watcher.emit('entries', [{
        id: 'next-user',
        role: 'user',
        content: 'second prompt',
        timestamp: 2.5,
        turnId: 'turn-next',
      }]);
      state.watcher.emit('entries', [{
        id: 'next-complete',
        role: 'assistant',
        content: 'new response',
        timestamp: 3,
        turnId: 'turn-next',
        source: 'codex_jsonl_task_complete',
      }]);
      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('accepts the next Codex turn when the cancelled prompt never created a boundary', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-codex-no-old-boundary',
        agentId: 'agent-codex-no-old-boundary',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-codex-no-old-boundary',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-codex-no-old-boundary', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'cancel before transcript', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'real next prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(2_250);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-next');
      state.watcher.emit('entries', [{
        id: 'next-user',
        role: 'user',
        content: 'real next prompt',
        timestamp: 2,
        turnId: 'turn-next',
      }]);
      state.watcher.emit('entries', [{
        id: 'next-complete',
        role: 'assistant',
        content: 'new response',
        timestamp: 3,
        turnId: 'turn-next',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('does not attach an unscoped Claude cancellation tail to the next response', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');

    try {
      const proc = {
        id: 'proc-claude-race',
        agentId: 'agent-claude-race',
        groupId: 'group-1',
        name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions',
        platform: 'claude-code',
        sessionName: 'session-claude-race',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-claude-race', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;

      pm.sendKeys(proc.agentId, 'first prompt', 'group-1', 'task-1', 'response-old');
      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        uuid: 'turn-old',
        message: { role: 'user', content: 'first prompt' },
      })));
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'second prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(600);

      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        uuid: 'turn-next',
        parentUuid: 'assistant-old',
        message: { role: 'user', content: 'second prompt' },
      })));
      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old',
        parentUuid: 'turn-old',
        message: { role: 'assistant', content: [{ type: 'text', text: 'cancelled old response' }] },
      })));

      expect(emitted).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.get(proc.id)).toMatchObject({
        identity: { responseId: 'response-next' },
      });

      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-next',
        parentUuid: 'turn-next',
        message: { role: 'assistant', content: [{ type: 'text', text: 'new response' }] },
      })));
      expect(emitted).toHaveBeenCalledOnce();
      expect(emitted.mock.calls[0][3]).toEqual([
        expect.objectContaining({ content: 'new response', turnId: 'turn-next' }),
      ]);
    } finally {
      pm.destroy();
    }
  });

  it('shows the next CodeBuddy response after interruption', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');

    try {
      const proc = {
        id: 'proc-codebuddy-interrupt',
        agentId: 'agent-codebuddy-interrupt',
        groupId: 'group-1',
        name: 'CodeBuddy CLI',
        command: 'codebuddy',
        platform: 'codebuddy-cli',
        sessionName: 'session-codebuddy-interrupt',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-codebuddy-interrupt', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;

      pm.sendKeys(proc.agentId, 'first prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(600);
      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'message',
        id: 'codebuddy-turn-old',
        role: 'user',
        content: [{ type: 'input_text', text: 'first prompt' }],
      })));
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);

      pm.sendKeys(proc.agentId, 'second prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(600);
      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'message',
        id: 'codebuddy-turn-next',
        role: 'user',
        content: [{ type: 'input_text', text: 'second prompt' }],
      })));
      state.watcher.emit('entries', state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'message',
        id: 'codebuddy-answer-next',
        parentId: 'codebuddy-turn-next',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'new response' }],
      })));

      expect(emitted).toHaveBeenCalledOnce();
      expect(emitted.mock.calls[0][3]).toEqual([
        expect.objectContaining({ content: 'new response', turnId: 'codebuddy-turn-next' }),
      ]);
    } finally {
      pm.destroy();
    }
  });

  it('never re-emits an interrupted turn through the unclaimed path', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('late-message');

    try {
      const proc = {
        id: 'proc-late-unclaimed',
        agentId: 'agent-late-unclaimed',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-late-unclaimed',
        launchedAt: Date.now(),
        isRunning: true,
      };
      const state = {
        watcher: { isActive: true, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
        activeTranscriptTurnId: 'turn-old',
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-late-unclaimed', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).conversationStates.set(proc.id, state);
      (pm as any).pendingResponses.set(proc.id, {
        identity: { responseId: 'response-old', transcriptTurnId: 'turn-old' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        createdAt: Date.now(),
      });
      pm.onConversationEntries = emitted;

      expect(pm.interruptAgent(
        proc.agentId, 'group-1', 'task-1', 'response-old',
      )).toBe(true);
      vi.advanceTimersByTime(3_000);
      (pm as any).emitUnclaimedConversationEntries(proc, state, [{
        id: 'late-old-answer',
        role: 'assistant',
        content: 'must stay suppressed',
        timestamp: Date.now() / 1000,
        turnId: 'turn-old',
      }]);

      expect(emitted).not.toHaveBeenCalled();
    } finally {
      pm.destroy();
    }
  });

  it('classifies a late old user boundary even when no pending response remains', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('late-message');

    try {
      const proc = {
        id: 'proc-late-boundary',
        agentId: 'agent-late-boundary',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-late-boundary',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-late-boundary', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;

      pm.sendKeys(proc.agentId, 'old prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-old');
      state.watcher.emit('entries', [{
        id: 'old-user',
        role: 'user',
        content: 'old prompt',
        timestamp: 1,
        turnId: 'turn-old',
      }]);
      state.watcher.emit('entries', [{
        id: 'old-answer',
        role: 'assistant',
        content: 'late old response',
        timestamp: 2,
        turnId: 'turn-old',
      }]);

      expect(emitted).not.toHaveBeenCalled();
      expect(state.interruptedTranscriptTurnIds).toContain('turn-old');
    } finally {
      pm.destroy();
    }
  });

  it('allows retrying the exact interrupted prompt text in a new turn', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-same-prompt',
        agentId: 'agent-same-prompt',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-same-prompt',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-same-prompt', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'same prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'same prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(2_250);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-next');
      state.watcher.emit('entries', [{
        id: 'next-user',
        role: 'user',
        content: 'same prompt',
        timestamp: 2,
        turnId: 'turn-next',
      }]);
      state.watcher.emit('entries', [{
        id: 'next-complete',
        role: 'assistant',
        content: 'new response',
        timestamp: 3,
        turnId: 'turn-next',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('keeps an old late boundary separate when retrying identical prompt text', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const write = vi.fn();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-same-prompt-old-first',
        agentId: 'agent-same-prompt-old-first',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-same-prompt-old-first',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-same-prompt-old-first', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write, kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'same prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      write.mockClear();
      pm.sendKeys(proc.agentId, 'same prompt', 'group-1', 'task-1', 'response-next');
      expect(write).not.toHaveBeenCalled();

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-old');
      state.watcher.emit('entries', [{
        id: 'old-user',
        role: 'user',
        content: 'same prompt',
        timestamp: 1,
        turnId: 'turn-old',
      }]);
      state.watcher.emit('entries', [{
        id: 'old-complete',
        role: 'assistant',
        content: 'cancelled old response',
        timestamp: 2,
        turnId: 'turn-old',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(write).toHaveBeenCalledWith('\x1b[I');
      expect(emitted).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(true);

      vi.advanceTimersByTime(250);
      state.watcher.emit('turn-started', 'turn-next');
      state.watcher.emit('entries', [{
        id: 'next-user',
        role: 'user',
        content: 'same prompt',
        timestamp: 3,
        turnId: 'turn-next',
      }]);
      state.watcher.emit('entries', [{
        id: 'next-complete',
        role: 'assistant',
        content: 'new response',
        timestamp: 4,
        turnId: 'turn-next',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      pm.destroy();
    }
  });

  it('keeps the first post-timeout turn tentative until its user boundary is classified', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-post-timeout-old-turn',
        agentId: 'agent-post-timeout-old-turn',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-post-timeout-old-turn',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-post-timeout-old-turn', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'old prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'next prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(2_250);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('turn-started', 'turn-old');
      state.watcher.emit('entries', [{
        id: 'late-old-user',
        role: 'user',
        content: 'old prompt',
        timestamp: 1,
        turnId: 'turn-old',
      }]);
      state.watcher.emit('entries', [{
        id: 'late-old-complete',
        role: 'assistant',
        content: 'cancelled old response',
        timestamp: 2,
        turnId: 'turn-old',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect((pm as any).pendingResponses.get(proc.id)).toMatchObject({
        identity: { responseId: 'response-next' },
      });

      state.watcher.emit('turn-started', 'turn-next');
      state.watcher.emit('entries', [{
        id: 'next-user',
        role: 'user',
        content: 'next prompt',
        timestamp: 3,
        turnId: 'turn-next',
      }]);
      state.watcher.emit('entries', [{
        id: 'next-complete',
        role: 'assistant',
        content: 'new response',
        timestamp: 4,
        turnId: 'turn-next',
        source: 'codex_jsonl_task_complete',
      }]);

      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('classifies JSONL lifecycle events before completing a batched next turn', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');
    const completed = vi.fn();
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, 'codex.jsonl');

    try {
      const proc = {
        id: 'proc-jsonl-batch',
        agentId: 'agent-jsonl-batch',
        groupId: 'group-1',
        name: 'OpenAI Codex CLI',
        command: 'codex',
        platform: 'openai-codex-cli',
        sessionName: 'session-jsonl-batch',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-jsonl-batch', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'old prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(250);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'next prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(2_250);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.sessionFile = transcriptPath;
      fs.writeFileSync(transcriptPath, [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-next' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'next prompt' } },
        {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-next',
            last_agent_message: 'new response',
          },
        },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      state.watcher.readJsonlUpdates();

      expect(emitted).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect((pm as any).pendingResponses.has(proc.id)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('processes every turn in a multi-turn watcher batch independently', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');

    try {
      const proc = {
        id: 'proc-multi-turn-batch',
        agentId: 'agent-multi-turn-batch',
        groupId: 'group-1',
        name: 'Gemini CLI',
        command: 'gemini',
        platform: 'gemini-cli',
        sessionName: 'session-multi-turn-batch',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-multi-turn-batch', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;

      pm.sendKeys(proc.agentId, 'old prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(600);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);

      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('entries', [
        { id: 'old-user', role: 'user', content: 'old prompt', timestamp: 1, turnId: 'turn-old' },
        { id: 'old-answer', role: 'assistant', content: 'cancelled old response', timestamp: 2, turnId: 'turn-old' },
        { id: 'next-user', role: 'user', content: 'terminal next prompt', timestamp: 3, turnId: 'turn-next' },
        { id: 'next-answer', role: 'assistant', content: 'terminal next response', timestamp: 4, turnId: 'turn-next' },
      ]);

      expect(emitted).toHaveBeenCalledOnce();
      expect(emitted.mock.calls[0][3]).toEqual([
        expect.objectContaining({ content: 'terminal next response', turnId: 'turn-next' }),
      ]);
    } finally {
      pm.destroy();
    }
  });

  it('keeps a response interruptible after quiet output completion while its turn is active', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const write = vi.fn();
    const completed = vi.fn();

    try {
      const proc = {
        id: 'proc-quiet-active-turn',
        agentId: 'agent-quiet-active-turn',
        groupId: 'group-1',
        name: 'CodeBuddy CLI',
        command: 'codebuddy',
        platform: 'codebuddy-cli',
        sessionName: 'session-quiet-active-turn',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-quiet-active-turn', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write, kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = vi.fn().mockReturnValue('message-long-tool');
      pm.onAgentOutputComplete = completed;

      pm.sendKeys(proc.agentId, 'run the long tool', 'group-1', 'task-1', 'response-long-tool');
      vi.advanceTimersByTime(600);
      const state = (pm as any).conversationStates.get(proc.id);
      state.watcher.emit('entries', [
        {
          id: 'long-tool-user',
          role: 'user',
          content: 'run the long tool',
          timestamp: 1,
          turnId: 'turn-long-tool',
        },
        {
          id: 'long-tool-started',
          role: 'tool',
          content: 'tool is still running',
          timestamp: 2,
          turnId: 'turn-long-tool',
        },
      ]);
      state.watcher.sessionFile = '/tmp/codebuddy-active.jsonl';
      const pending = (pm as any).pendingResponses.get(proc.id);
      pending.lastStructuredAt = Date.now() - 1_100;
      (pm as any).refreshAll();
      expect(completed).toHaveBeenCalledOnce();

      write.mockClear();
      expect(pm.interruptAgent(
        proc.agentId,
        'group-1',
        'task-1',
        'response-long-tool',
      )).toBe(true);
      expect(write).toHaveBeenCalledWith('\x1b');
      expect(pm.interruptAgent(
        proc.agentId,
        'group-1',
        'task-1',
        'response-long-tool',
      )).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('clears a non-native active turn when its pending response completes', () => {
    const pm = new ProcessManager();

    try {
      const proc = {
        id: 'proc-active-turn',
        agentId: 'agent-active-turn',
        groupId: 'group-1',
        name: 'CodeBuddy CLI',
        command: 'codebuddy',
        platform: 'codebuddy-cli',
        sessionName: 'session-active-turn',
        launchedAt: Date.now(),
        isRunning: true,
      };
      const pending = {
        identity: { responseId: 'response-1', transcriptTurnId: 'turn-1' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        entryStartIndex: 0,
        createdAt: Date.now(),
      };
      const state = {
        watcher: { isActive: true, stop() {} },
        allEntries: [],
        groupId: 'group-1',
        taskSessionId: 'task-1',
        activeTranscriptTurnId: 'turn-1',
      };
      pm.processes.push(proc);
      (pm as any).pendingResponses.set(proc.id, pending);
      (pm as any).conversationStates.set(proc.id, state);

      (pm as any).completePendingResponse(proc, pending, 'done');

      expect(state.activeTranscriptTurnId).toBeUndefined();
    } finally {
      pm.destroy();
    }
  });

  it('does not lose the next Copilot response when the cancelled turn had no boundary', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const emitted = vi.fn().mockReturnValue('message-next');

    try {
      const proc = {
        id: 'proc-copilot-boundary',
        agentId: 'agent-copilot-boundary',
        groupId: 'group-1',
        name: 'GitHub Copilot CLI',
        command: 'copilot',
        platform: 'github-copilot-cli',
        sessionName: 'session-copilot-boundary',
        launchedAt: Date.now(),
        isRunning: true,
      };
      pm.processes.push(proc);
      (pm as any).agentProcessMap.set('group-1\0agent-copilot-boundary', proc.id);
      (pm as any).ptyProcesses.set(proc.id, { write: vi.fn(), kill: vi.fn() });
      (pm as any).attachConversationWatcher(proc);
      pm.onConversationEntries = emitted;

      pm.sendKeys(proc.agentId, 'old prompt', 'group-1', 'task-1', 'response-old');
      vi.advanceTimersByTime(600);
      expect(pm.interruptAgent(proc.agentId, 'group-1', 'task-1', 'response-old')).toBe(true);
      pm.sendKeys(proc.agentId, 'next prompt', 'group-1', 'task-1', 'response-next');
      vi.advanceTimersByTime(2_600);

      const state = (pm as any).conversationStates.get(proc.id);
      const userEntries = state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'user.message',
        id: 'copilot-user-next',
        data: { content: 'next prompt' },
      }));
      if (userEntries.length > 0) state.watcher.emit('entries', userEntries);
      const startEntries = state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant.turn_start',
        data: { turnId: 'copilot-turn-next' },
      }));
      if (startEntries.length > 0) state.watcher.emit('entries', startEntries);
      const assistantEntries = state.watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant.message',
        data: { content: 'new response' },
      }));
      state.watcher.emit('entries', assistantEntries);

      expect(emitted).toHaveBeenCalledOnce();
      expect(emitted.mock.calls[0][3]).toEqual([
        expect.objectContaining({ content: 'new response', turnId: 'copilot-turn-next' }),
      ]);
    } finally {
      pm.destroy();
    }
  });
});

describe('ProcessManager structured conversation entries', () => {
  it('upserts entries by dedupeKey before falling back to id', () => {
    const pm = new ProcessManager();
    const state: any = {
      watcher: { isActive: true, stop() {} },
      allEntries: [],
      groupId: 'group-1',
      taskSessionId: 'task-1',
    };

    try {
      (pm as any).upsertConversationEntries(state, [{
        id: 'event-entry',
        dedupeKey: 'same-codex-message',
        role: 'assistant',
        content: 'partial',
        timestamp: 1,
      }]);
      (pm as any).upsertConversationEntries(state, [{
        id: 'response-entry',
        dedupeKey: 'same-codex-message',
        role: 'assistant',
        content: 'partial answer',
        timestamp: 2,
      }]);

      expect(state.allEntries).toHaveLength(1);
      expect(state.allEntries[0]).toMatchObject({
        id: 'response-entry',
        dedupeKey: 'same-codex-message',
        content: 'partial answer',
      });
    } finally {
      pm.destroy();
    }
  });

  it('prefers final_answer entries over commentary when building assistant text', () => {
    const pm = new ProcessManager();

    try {
      expect((pm as any).assistantTextFromEntries([
        { id: 'c1', role: 'assistant', content: 'working on it', timestamp: 1, phase: 'commentary' },
      ])).toBe('working on it');

      expect((pm as any).assistantTextFromEntries([
        { id: 'c1', role: 'assistant', content: 'working on it', timestamp: 1, phase: 'commentary' },
        { id: 'f1', role: 'assistant', content: 'done', timestamp: 2, phase: 'final_answer' },
      ])).toBe('done');
    } finally {
      pm.destroy();
    }
  });

  it('does not treat user JSONL entries as agent response entries', () => {
    const pm = new ProcessManager();
    const state: any = {
      watcher: { isActive: true, stop() {} },
      allEntries: [
        { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 },
      ],
      groupId: 'group-1',
      taskSessionId: 'task-1',
    };

    try {
      expect((pm as any).responseEntriesForPending(state, {
        entryStartIndex: 0,
      })).toEqual([
        { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 },
      ]);

      expect((pm as any).responseEntriesForPending(state, {
        entryStartIndex: 0,
      }).some((entry: any) => entry.role === 'user')).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it('ignores structured history before the current pending response timestamp', () => {
    const pm = new ProcessManager();
    const now = Date.now();
    const state: any = {
      watcher: { isActive: true, stop() {} },
      allEntries: [
        { id: 'old-a', role: 'assistant', content: '旧回答', timestamp: (now - 5_000) / 1000 },
        { id: 'new-u', role: 'user', content: '新问题', timestamp: now / 1000 },
        { id: 'new-a', role: 'assistant', content: '新回答', timestamp: (now + 100) / 1000 },
      ],
      groupId: 'group-1',
      taskSessionId: 'task-1',
    };

    try {
      expect((pm as any).responseEntriesForPending(state, {
        entryStartIndex: 0,
        minEntryTimestampMs: now - 1_000,
      })).toEqual([
        { id: 'new-a', role: 'assistant', content: '新回答', timestamp: (now + 100) / 1000 },
      ]);
    } finally {
      pm.destroy();
    }
  });

  it.each(CLAUDE_AGENT_CASES)('starts a new complete $agentName envelope for unclaimed assistant entries after a user JSONL boundary', (agent) => {
    const pm = new ProcessManager();
    const emitted: Array<{
      entries: any[];
      existingId?: string;
      status?: 'streaming' | 'complete';
    }> = [];
    const state: any = {
      watcher: { isActive: true, stop() {} },
      allEntries: [],
      groupId: 'group-1',
      taskSessionId: 'task-1',
      lastEnvelopeId: 'old-message',
    };
    const proc: any = {
      id: `proc-${agent.id}`,
      name: agent.agentName,
      agentId: `agent-${agent.id}`,
      command: agent.command,
      platform: agent.platform,
    };

    try {
      pm.onConversationEntries = (_agentName, _groupId, _taskSessionId, entries, existingId, status) => {
        emitted.push({ entries, existingId, status });
        return 'new-message';
      };

      (pm as any).emitUnclaimedConversationEntries(proc, state, [
        { id: 'u2', role: 'user', content: '你多大了', timestamp: 1 },
        { id: 'a2', role: 'assistant', content: '我是 Claude', timestamp: 2 },
      ]);

      expect(emitted).toEqual([{
        entries: [{ id: 'a2', role: 'assistant', content: '我是 Claude', timestamp: 2 }],
        existingId: undefined,
        status: 'complete',
      }]);
      expect(state.lastEnvelopeId).toBe('new-message');
    } finally {
      pm.destroy();
    }
  });

  it('can complete a pending response from Codex agent_message structured entries', () => {
    const pm = new ProcessManager();
    const completed: string[] = [];
    const proc: any = {
      id: 'proc-codex',
      agentId: 'agent-codex',
      groupId: 'group-1',
      name: 'OpenAI Codex CLI',
      command: 'codex',
      platform: 'openai-codex-cli',
      sessionName: 'session-codex',
      launchedAt: Date.now(),
      isRunning: true,
    };
    const pending: any = {
      groupId: 'group-1',
      taskSessionId: 'task-1',
      snapshotOffset: 0,
      lastFileSize: 0,
      stableCount: 0,
      entryStartIndex: 0,
      createdAt: Date.now(),
    };
    const state: any = {
      watcher: { isActive: true, stop() {} },
      allEntries: [{
        id: 'event-entry',
        role: 'assistant',
        content: 'early visible answer',
        timestamp: 1,
        phase: 'commentary',
        source: 'codex_jsonl_event',
      }],
      groupId: 'group-1',
      taskSessionId: 'task-1',
    };

    try {
      pm.onAgentOutputComplete = (_agentName, _groupId, _taskSessionId, content) => {
        completed.push(content);
      };

      expect((pm as any).completePendingFromEntries(proc, pending, state)).toBe(true);
      expect(completed).toEqual(['early visible answer']);
    } finally {
      pm.destroy();
    }
  });

  it.each(CLAUDE_AGENT_CASES)('completes $agentName structured responses after JSONL entries go quiet without PTY growth', (agent) => {
    const pm = new ProcessManager();
    const dir = makeTempDir();
    const logFilePath = path.join(dir, `${agent.id}.log`);
    fs.writeFileSync(logFilePath, 'prompt already written');
    const completed: string[] = [];
    const procId = `proc-${agent.id}`;
    const agentId = `agent-${agent.id}`;

    try {
      pm.processes.push({
        id: procId,
        agentId,
        groupId: 'group-1',
        name: agent.agentName,
        command: agent.command,
        platform: agent.platform,
        sessionName: `session-${agent.id}`,
        launchedAt: Date.now(),
        isRunning: true,
        logFilePath,
      });
      (pm as any).conversationStates.set(procId, {
        watcher: { isActive: true, stop() {} },
        allEntries: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '你好！有什么可以帮你？',
          timestamp: 1,
        }],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });
      (pm as any).pendingResponses.set(procId, {
        identity: { envelopeId: 'message-1' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: fs.statSync(logFilePath).size,
        lastFileSize: fs.statSync(logFilePath).size,
        stableCount: 0,
        hasStructuredEntries: true,
        lastStructuredAt: Date.now() - 2_000,
        entryStartIndex: 0,
        sentText: '你好',
        createdAt: Date.now(),
      });
      pm.onAgentOutputComplete = (_agentName, _groupId, _taskSessionId, content) => {
        completed.push(content);
      };

      (pm as any).refreshAll();

      expect(completed).toEqual(['你好！有什么可以帮你？']);
      expect((pm as any).pendingResponses.has(procId)).toBe(false);
    } finally {
      pm.destroy();
    }
  });

  it.each(CLAUDE_AGENT_CASES)('completes an existing $agentName structured response before starting the next prompt', (agent) => {
    const pm = new ProcessManager();
    const dir = makeTempDir();
    const logFilePath = path.join(dir, `${agent.id}.log`);
    fs.writeFileSync(logFilePath, '');
    const completed: string[] = [];
    const procId = `proc-${agent.id}`;
    const agentId = `agent-${agent.id}`;

    try {
      pm.processes.push({
        id: procId,
        agentId,
        groupId: 'group-1',
        name: agent.agentName,
        command: agent.command,
        platform: agent.platform,
        sessionName: `session-${agent.id}`,
        launchedAt: Date.now(),
        isRunning: true,
        logFilePath,
      });
      (pm as any).agentProcessMap.set(`group-1\0${agentId}`, procId);
      (pm as any).conversationStates.set(procId, {
        watcher: { isActive: true, stop() {} },
        allEntries: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '第一轮回答',
          timestamp: 1,
        }],
        groupId: 'group-1',
        taskSessionId: 'task-1',
      });
      (pm as any).pendingResponses.set(procId, {
        identity: { envelopeId: 'message-1' },
        groupId: 'group-1',
        taskSessionId: 'task-1',
        snapshotOffset: 0,
        lastFileSize: 0,
        stableCount: 0,
        hasStructuredEntries: true,
        lastStructuredAt: Date.now() - 2_000,
        entryStartIndex: 0,
        sentText: '第一轮',
        createdAt: Date.now(),
      });
      pm.onAgentOutputComplete = (_agentName, _groupId, _taskSessionId, content) => {
        completed.push(content);
      };

      pm.sendKeys(agentId, '第二轮', 'group-1', 'task-1');

      const nextPending = (pm as any).pendingResponses.get(procId);
      expect(completed).toEqual(['第一轮回答']);
      expect(nextPending.sentText).toBe('第二轮');
      expect(nextPending.entryStartIndex).toBe(1);
      expect(nextPending.identity.envelopeId).toBeUndefined();
    } finally {
      pm.destroy();
    }
  });
});

describe('parseModelPickerTerminalOutput', () => {
  it('ignores Codex slash-command help before the picker opens', () => {
    const parsed = parseModelPickerTerminalOutput(
      '\x1b[0 q/model/model  choose what model and reasoning effort to use[...]',
    );

    expect(parsed.selectedIndex).toBeNull();
    expect(parsed.options).toEqual([]);
  });

  it('parses compact Codex model-and-effort picker output', () => {
    const parsed = parseModelPickerTerminalOutput([
      '\x1b[0 q/model/model choose what model and reasoning effort to use',
      'Select Model and Effort',
      'Access legacy models by running codex -m <model_name> or in your config.toml',
      '› 1. gpt-5.5 (current)    Frontier model for complex coding, research, and real-world work.',
      '2.gpt-5.4Strong model for everyday coding.',
      '3.gpt-5.4-miniSmall, fast, and cost-efficient model for simpler coding tasks.',
      '4.gpt-5.3-codex-sparkUltra-fast coding model.',
      'Press enter to confirm or esc to go back',
    ].join(''));

    expect(parsed.selectedIndex).toBe(0);
    expect(parsed.options.map(option => option.label)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
    expect(parsed.options[0].isCurrent).toBe(true);
  });

  it('parses compact Codex reasoning-effort picker output after model selection', () => {
    const parsed = parseModelPickerTerminalOutput([
      'Select Model and Effort',
      '› 1. gpt-5.5 (current)    Frontier model for complex coding, research, and real-world work.',
      'Press enter to confirm or esc to go back',
      'Select Reasoning Level for gpt-5.5',
      '1.LowFast responses with lighter reasoning',
      '2.Medium(default)Balances speed and reasoning depth for everyday tasks',
      '3.HighGreater reasoning depth for complex problems',
      '› 4. Extra high (current)  Extra high reasoning depth for complex problems',
      'Press enter to confirm or esc to go back',
    ].join(''));

    expect(parsed.selectedIndex).toBe(3);
    expect(parsed.options.map(option => option.label)).toEqual(['Low', 'Medium', 'High', 'Extra high']);
    expect(parsed.options[3].isCurrent).toBe(true);
  });

  it('parses Codex-style model lists with a highlighted row', () => {
    const parsed = parseModelPickerTerminalOutput([
      '\x1b[?1049hSelect model',
      '› gpt-5-codex (current)',
      '  o4-mini',
      '  gpt-4.1',
    ].join('\r\n'));

    expect(parsed.selectedIndex).toBe(0);
    expect(parsed.options.map(option => option.label)).toEqual(['gpt-5-codex', 'o4-mini', 'gpt-4.1']);
    expect(parsed.options[0].isCurrent).toBe(true);
  });

  it('parses Claude-style selector output', () => {
    const parsed = parseModelPickerTerminalOutput([
      'Choose model',
      '❯ Claude Sonnet 4.5',
      '  Claude Opus 4.1',
      '  Claude Haiku 3.5',
    ].join('\n'));

    expect(parsed.selectedIndex).toBe(0);
    expect(parsed.options.map(option => option.label)).toEqual([
      'Claude Sonnet 4.5',
      'Claude Opus 4.1',
      'Claude Haiku 3.5',
    ]);
  });

  it('parses Claude Code model picker output without slash-command suggestions', () => {
    const parsed = parseModelPickerTerminalOutput([
      '/modelSettheAImodelforClaudeCode(currentlydeepseek-v4-pro[1m])',
      '/claude-apiReferencefortheClaudeAPI/AnthropicSDK—modelids,pricing,params,streaming,',
      'BEFOREopeningthetargetfile;don\'tskipbecauseit"lookslikeaone-liner"',
      '❯ /model',
      '  Selectmodel',
      '  Switch betweenClaudemodels. Your pick becomes the default for new sessions.',
      '    1. Default(recommended)Use the default model (currently depeek-v4-pro[1m]) · $5/$25per Mtok',
      '2.deepseek-v4-pro[1m]Cusom Opusmodel(1Mcontext)',
      '    3. deepseek-v4-pro[1m]Custom Sonnet model (1M context)',
      '4.deepseek-v4-flashCustom Haiku model',
      '  ❯ 5.deepseek-v4-pro[1m]✔Custommodel',
      '●Higheffort(default)←/→toadjust',
      'Entertosetasdefault·stousethissessiononly·Esctocancel',
    ].join('\n'));

    expect(parsed.selectedIndex).toBe(4);
    expect(parsed.options.map(option => option.label)).toEqual([
      'Default (recommended)',
      'deepseek-v4-pro[1m] - Custom Opus model (1M context)',
      'deepseek-v4-pro[1m] - Custom Sonnet model (1M context)',
      'deepseek-v4-flash - Custom Haiku model',
      'deepseek-v4-pro[1m] - Custom model',
    ]);
    expect(parsed.options[4].isCurrent).toBe(true);
    expect(parsed.options.some(option => option.label.includes('/model'))).toBe(false);
  });

  it('parses Claude Code model picker rows from the desktop layout', () => {
    const parsed = parseModelPickerTerminalOutput([
      'Select model',
      'Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
      '',
      '  1. Default (recommended)   Use the default model (currently deepseek-v4-pro[1m]) · $5/$25 per Mtok',
      '  2. deepseek-v4-pro[1m]     Custom Opus model (1M context)',
      '  3. deepseek-v4-pro[1m]     Custom Sonnet model (1M context)',
      '  4. deepseek-v4-flash       Custom Haiku model',
      '› 5. deepseek-v4-pro[1m] ✓   Custom model',
      '',
      '● High effort (default) ←/→ to adjust',
      'Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n'));

    expect(parsed.selectedIndex).toBe(4);
    expect(parsed.options.map(option => option.label)).toEqual([
      'Default (recommended)',
      'deepseek-v4-pro[1m] - Custom Opus model (1M context)',
      'deepseek-v4-pro[1m] - Custom Sonnet model (1M context)',
      'deepseek-v4-flash - Custom Haiku model',
      'deepseek-v4-pro[1m] - Custom model',
    ]);
    expect(parsed.options[4].isCurrent).toBe(true);
  });

  it('ignores Claude Code welcome screen redraws before the model picker opens', () => {
    const parsed = parseModelPickerTerminalOutput([
      '╭───Claude Code v2.1.201────────────────────────╮',
      '│ Welcome back! │ Tips for getting started      │',
      '│ ▐▛███▜▌       │ What\'s new                    │',
      '│ ▝▜█████▛▘     │ Claude Sonnet 5 sessions no longer use the mid-conversation system role │',
      '│ deepseek-v4-pro[1m] · API Usage Billing │ Changed the "default" permission mode │',
      '╰───────────────────────────────────────────────╯',
      '❯',
    ].join('\n'));

    expect(parsed.options).toEqual([]);
    expect(parsed.selectedIndex).toBeNull();
  });

  it('parses Claude Code effort picker output', () => {
    const parsed = parseModelPickerTerminalOutput([
      '❯ /effort',
      '  Efort',
      '             Faster                                             Smarter',
      '────────────────────────────────────────▲──┆──────────────────',
      'lowmediumhighxhighmaxultracode',
      'xhigh+workflows',
      'Mayuseexcessivetokensresultinginlongresponsetimesoroverthinking.Usesparinglyforthehardesttasks.',
      '←/→toadjust·Entertoconfirm·Esctocancel',
      '?forshortcuts·←foragents ◈max·/effort',
    ].join('\n'));

    expect(parsed.selectedIndex).toBe(4);
    expect(parsed.options.map(option => option.label)).toEqual([
      'Low',
      'Medium',
      'High',
      'Xhigh',
      'Max',
      'Ultracode',
    ]);
    expect(parsed.options[4].isCurrent).toBe(true);
  });

  it('parses Copilot-style checkbox output', () => {
    const parsed = parseModelPickerTerminalOutput([
      'Available models',
      '[x] GPT-5',
      '[ ] Claude Sonnet 4',
      '[ ] o4-mini',
    ].join('\n'));

    expect(parsed.selectedIndex).toBe(0);
    expect(parsed.options.map(option => option.label)).toEqual(['GPT-5', 'Claude Sonnet 4', 'o4-mini']);
  });
});

describe('ProcessManager model picker commands', () => {
  it('opens Claude effort picker with /effort', () => {
    const pm = new ProcessManager();
    try {
      pm.processes.push({
        id: 'proc-1',
        agentId: 'agent-1',
        groupId: 'group-1',
        name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions',
        platform: 'claude-code',
        sessionName: 'session-1',
        launchedAt: Date.now(),
        isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      const writes: string[] = [];
      (pm as any).writeTextWithEnter = (_proc: unknown, text: string) => {
        writes.push(text);
      };

      pm.startModelPicker('agent-1', 'group-1', 'effort');

      expect(writes).toEqual(['/effort']);
    } finally {
      pm.destroy();
    }
  });
});

describe('ProcessManager input writing', () => {
  it.each([
    ['Codex CLI', 'openai-codex-cli', 'codex', 150],
    ['Claude Code', 'claude-code', 'claude --permission-mode bypassPermissions', 500],
    ['OpenClaude', 'openclaude', 'openclaude --permission-mode bypassPermissions', 500],
  ])('uses bracketed paste for multiline %s input before submitting', (name, platform, command, enterDelay) => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const proc = {
      id: 'proc-1',
      agentId: 'agent-1',
      groupId: 'group-1',
      name,
      command,
      platform,
      sessionName: 'session-1',
      launchedAt: Date.now(),
      isRunning: true,
    };
    const child = { write: vi.fn() };
    const text = '请先阅读这张图\n\n`file:.octrix-mobile-attachments/1/photo.png` ';

    try {
      (pm as any).ptyProcesses.set(proc.id, child);

      (pm as any).writeTextWithEnter(proc, text);

      expect(child.write).toHaveBeenCalledTimes(1);
      expect(child.write).toHaveBeenNthCalledWith(1, '\x1b[I');

      vi.advanceTimersByTime(50);
      expect(child.write).toHaveBeenNthCalledWith(2, `\x1b[200~${text}\x1b[201~`);

      vi.advanceTimersByTime(enterDelay);
      expect(child.write).toHaveBeenNthCalledWith(3, '\r');
    } finally {
      pm.destroy();
    }
  });

  it('keeps single-line paste-capable agent input as plain text', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const proc = {
      id: 'proc-1',
      agentId: 'agent-1',
      groupId: 'group-1',
      name: 'OpenAI Codex CLI',
      command: 'codex',
      platform: 'openai-codex-cli',
      sessionName: 'session-1',
      launchedAt: Date.now(),
      isRunning: true,
    };
    const child = { write: vi.fn() };

    try {
      (pm as any).ptyProcesses.set(proc.id, child);

      (pm as any).writeTextWithEnter(proc, 'hello');

      vi.advanceTimersByTime(50);
      expect(child.write).toHaveBeenNthCalledWith(2, 'hello');
    } finally {
      pm.destroy();
    }
  });

  it('keeps multiline Gemini input on the plain-text path', () => {
    vi.useFakeTimers();
    const pm = new ProcessManager();
    const proc = {
      id: 'proc-1',
      agentId: 'agent-1',
      groupId: 'group-1',
      name: 'Gemini CLI',
      command: 'gemini --yolo',
      platform: 'gemini-cli',
      sessionName: 'session-1',
      launchedAt: Date.now(),
      isRunning: true,
    };
    const child = { write: vi.fn() };
    const text = '请看附件\n\n`file:.octrix-mobile-attachments/1/photo.png` ';

    try {
      (pm as any).ptyProcesses.set(proc.id, child);

      (pm as any).writeTextWithEnter(proc, text);

      expect(child.write).toHaveBeenNthCalledWith(1, text);
      vi.advanceTimersByTime(500);
      expect(child.write).toHaveBeenNthCalledWith(2, '\r');
    } finally {
      pm.destroy();
    }
  });
});

describe('parseWorkspaceTrustPromptOutput', () => {
  it('detects Claude workspace trust prompts and extracts the directory', () => {
    const parsed = parseWorkspaceTrustPromptOutput([
      'Accessing workspace:',
      '',
      '/Users/test/project',
      '',
      'Quick safety check: Is this a project you created or one you trust?',
      '',
      '1. Yes, I trust this folder',
      '2. No, exit',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));

    expect(parsed?.directory).toBe('/Users/test/project');
    expect(parsed?.rawPreview).toContain('Yes, I trust this folder');
  });

  it('detects ANSI-colored workspace trust prompts', () => {
    const parsed = parseWorkspaceTrustPromptOutput([
      '\x1b[33mAccessing workspace:\x1b[0m',
      '',
      '\x1b[1m/Users/test/project\x1b[0m',
      '',
      'Quick safety check: Is this a project you created or one you trust?',
      '',
      '\x1b[36m›\x1b[0m 1. Yes, I trust this folder',
      '2. No, exit',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\r\n'));

    expect(parsed?.directory).toBe('/Users/test/project');
  });

  it('detects OpenClaude prompts that use cursor-right spacing between words', () => {
    const parsed = parseWorkspaceTrustPromptOutput([
      '\x1b[38;2;255;193;7mAccessing\x1b[1Cworkspace:\x1b[39m',
      '',
      '\x1b[1m/Users/test\x1b[22m',
      '',
      'Quick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?',
      '',
      '\x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\x1b[39m',
      '2.\x1b[1CNo,\x1b[1Cexit',
      '',
      'Enter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel',
    ].join('\r\n'));

    expect(parsed?.directory).toBe('/Users/test');
    expect(parsed?.rawPreview).toContain('Accessing workspace:');
  });

  it('detects Claude Code prompts that use absolute-column spacing between words', () => {
    const parsed = parseWorkspaceTrustPromptOutput([
      'Accessing\x1b[12Gworkspace:',
      '',
      '\x1b[2G/Users/test',
      '',
      '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gtrust?',
      '',
      '\x1b[2G❯\x1b[4G1.\x1b[7GYes,\x1b[12GI\x1b[14Gtrust\x1b[20Gthis\x1b[25Gfolder',
      '\x1b[4G2.\x1b[7GNo,\x1b[11Gexit',
      '',
      '\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel',
    ].join('\r\r\n'));

    expect(parsed?.directory).toBe('/Users/test');
    expect(parsed?.rawPreview).toContain('Yes, I trust this folder');
  });

  it('ignores normal terminal output', () => {
    expect(parseWorkspaceTrustPromptOutput('Welcome\nReady for input\n')).toBeNull();
  });
});

describe('parseBypassPermissionsPromptOutput', () => {
  const bypassPrompt = [
    'WARNING: Claude Code running in Bypass Permissions mode',
    '',
    'In Bypass Permissions mode, Claude Code will not ask for your approval before running',
    'potentially dangerous commands.',
    '',
    '› No, exit',
    '  Yes, I accept',
    '',
    'Enter to confirm · Esc to cancel',
  ].join('\r\n');

  it('detects the first-run bypass permissions warning', () => {
    const parsed = parseBypassPermissionsPromptOutput(bypassPrompt);

    expect(parsed?.rawPreview).toContain('Yes, I accept');
    expect(parseAgentStartupPromptOutput(bypassPrompt)?.kind).toBe('bypass-permissions');
  });

  it('handles ANSI colors and cursor-position spacing', () => {
    const raw = [
      '\x1b[33mWARNING:\x1b[0m Claude\x1b[8GCode running in Bypass Permissions mode',
      '\x1b[2G›\x1b[4GNo,\x1b[8Gexit',
      '\x1b[4GYes,\x1b[9GI\x1b[11Gaccept',
      '\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm · Esc to cancel',
    ].join('\r\n');
    const parsed = parseBypassPermissionsPromptOutput(raw);

    expect(parsed?.rawPreview).toContain('No, exit');
    expect(parseAgentStartupPromptOutput(raw)?.kind).toBe('bypass-permissions');
  });

  it('ignores an informational bypass mode log without choices', () => {
    expect(parseBypassPermissionsPromptOutput('Claude Code running in Bypass Permissions mode')).toBeNull();
  });
});

describe('agent startup prompt resolution', () => {
  it('moves from the default No selection to Yes before trusting a workspace', () => {
    const pm = new ProcessManager();
    const child = { write: vi.fn(), kill: vi.fn() };
    try {
      (pm as any).processes.push({
        id: 'proc-1', agentId: 'agent-1', groupId: 'group-1', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', platform: 'claude-code',
        sessionName: 'test', launchedAt: Date.now(), isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', child);
      (pm as any).agentStartupPrompts.set('group-1\0agent-1', {
        kind: 'workspace-trust', agentId: 'agent-1', agentName: 'Claude Code', groupId: 'group-1',
        directory: '/tmp/project',
        rawPreview: 'Security guide\n❯ No, exit\n  Yes, I trust this folder',
        detectedAt: 1, updatedAt: 1,
      });

      expect(pm.resolveAgentStartupPrompts('group-1', 'accept', ['agent-1']).resolved).toBe(1);
      expect(child.write).toHaveBeenCalledWith('\x1b[B\r');
    } finally {
      pm.destroy();
    }
  });

  it('confirms the already-selected Yes choice for legacy workspace trust requests', () => {
    const pm = new ProcessManager();
    const child = { write: vi.fn(), kill: vi.fn() };
    try {
      (pm as any).processes.push({
        id: 'proc-1', agentId: 'agent-1', groupId: 'group-1', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', platform: 'claude-code',
        sessionName: 'test', launchedAt: Date.now(), isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', child);
      (pm as any).agentStartupPrompts.set('group-1\0agent-1', {
        kind: 'workspace-trust', agentId: 'agent-1', agentName: 'Claude Code', groupId: 'group-1',
        directory: '/tmp/project',
        rawPreview: 'Security guide\n❯ Yes, I trust this folder\n  No, exit',
        detectedAt: 1, updatedAt: 1,
      });

      expect(pm.confirmWorkspaceTrustPrompts('group-1', ['agent-1']).confirmed).toBe(1);
      expect(child.write).toHaveBeenCalledWith('\r');
    } finally {
      pm.destroy();
    }
  });

  it('confirms the selected No choice when declining workspace trust', () => {
    const pm = new ProcessManager();
    const child = { write: vi.fn(), kill: vi.fn() };
    try {
      (pm as any).processes.push({
        id: 'proc-1', agentId: 'agent-1', groupId: 'group-1', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', platform: 'claude-code',
        sessionName: 'test', launchedAt: Date.now(), isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', child);
      (pm as any).agentStartupPrompts.set('group-1\0agent-1', {
        kind: 'workspace-trust', agentId: 'agent-1', agentName: 'Claude Code', groupId: 'group-1',
        directory: '/tmp/project',
        rawPreview: 'Security guide\n❯ No, exit\n  Yes, I trust this folder',
        detectedAt: 1, updatedAt: 1,
      });

      expect(pm.resolveAgentStartupPrompts('group-1', 'decline', ['agent-1']).resolved).toBe(1);
      expect(child.write).toHaveBeenCalledWith('\r');
    } finally {
      pm.destroy();
    }
  });

  it('moves to Yes before accepting the bypass permissions prompt', () => {
    const pm = new ProcessManager();
    const child = { write: vi.fn(), kill: vi.fn() };
    try {
      (pm as any).processes.push({
        id: 'proc-1', agentId: 'agent-1', groupId: 'group-1', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', platform: 'claude-code',
        sessionName: 'test', launchedAt: Date.now(), isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', child);
      (pm as any).agentStartupPrompts.set('group-1\0agent-1', {
        kind: 'bypass-permissions', agentId: 'agent-1', agentName: 'Claude Code', groupId: 'group-1',
        directory: '/tmp/project', rawPreview: 'warning\n› No, exit\n  Yes, I accept', detectedAt: 1, updatedAt: 1,
      });

      expect(pm.resolveAgentStartupPrompts('group-1', 'accept', ['agent-1']).resolved).toBe(1);
      expect(child.write).toHaveBeenCalledWith('\x1b[B\r');
      expect(pm.getAgentStartupPrompts('group-1')).toEqual([]);
    } finally {
      pm.destroy();
    }
  });

  it('keeps the default No selection when declining bypass permissions', () => {
    const pm = new ProcessManager();
    const child = { write: vi.fn(), kill: vi.fn() };
    try {
      (pm as any).processes.push({
        id: 'proc-1', agentId: 'agent-1', groupId: 'group-1', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', platform: 'claude-code',
        sessionName: 'test', launchedAt: Date.now(), isRunning: true,
      });
      (pm as any).agentProcessMap.set('group-1\0agent-1', 'proc-1');
      (pm as any).ptyProcesses.set('proc-1', child);
      (pm as any).agentStartupPrompts.set('group-1\0agent-1', {
        kind: 'bypass-permissions', agentId: 'agent-1', agentName: 'Claude Code', groupId: 'group-1',
        directory: '/tmp/project', rawPreview: 'warning\n› No, exit\n  Yes, I accept', detectedAt: 1, updatedAt: 1,
      });

      pm.resolveAgentStartupPrompts('group-1', 'decline', ['agent-1']);
      expect(child.write).toHaveBeenCalledWith('\r');
    } finally {
      pm.destroy();
    }
  });
});

describe('accumulatedBody monotonic protection (logic)', () => {
  it('keeps longer accumulated body when delta gets shorter', () => {
    let accumulatedBody = '';

    const delta1 = 'Hello World';
    if (delta1.length >= accumulatedBody.length) {
      accumulatedBody = delta1;
    }
    expect(accumulatedBody).toBe('Hello World');

    const delta2 = 'Hello World! More content here';
    if (delta2.length >= accumulatedBody.length) {
      accumulatedBody = delta2;
    }
    expect(accumulatedBody).toBe('Hello World! More content here');

    const delta3 = 'More content here';
    if (delta3.length >= accumulatedBody.length) {
      accumulatedBody = delta3;
    }
    expect(accumulatedBody).toBe('Hello World! More content here');
  });

  it('accepts equal-length replacement', () => {
    let accumulatedBody = 'AAAA';
    const delta = 'BBBB';
    if (delta.length >= accumulatedBody.length) {
      accumulatedBody = delta;
    }
    expect(accumulatedBody).toBe('BBBB');
  });
});

describe('launch path resolution', () => {
  it('augments PATH with user-local bin directories for packaged app launches', () => {
    const dirs = augmentedPath().split(':');
    expect(dirs).toContain(path.dirname(process.execPath));
    expect(dirs).toContain(path.join(os.homedir(), '.npm-global', 'bin'));
    expect(dirs).toContain(path.join(os.homedir(), '.local', 'bin'));
    expect(dirs).toContain(path.join(os.homedir(), '.cargo', 'bin'));
    expect(dirs).toContain('/Applications/Codex.app/Contents/Resources');
  });

  it('keeps Codex.app bundle paths shared with installation detection', () => {
    expect(augmentedPath().split(':')).toEqual(expect.arrayContaining(MACOS_APP_BIN_DIRS));
  });

  it('preserves PATH entries loaded from the user shell', () => {
    const dirs = augmentedPath(['/Users/test/.nvm/versions/node/v22.0.0/bin', '/usr/bin:/bin']).split(':');
    expect(dirs).toContain('/Users/test/.nvm/versions/node/v22.0.0/bin');
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain('/bin');
  });

  it('keeps user npm globals before Homebrew fallback binaries', () => {
    const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin');
    const dirs = augmentedPath([`${npmGlobalBin}:/opt/homebrew/bin:/usr/bin`]).split(':');
    expect(dirs.indexOf(npmGlobalBin)).toBeLessThan(dirs.indexOf('/opt/homebrew/bin'));
  });

  it('resolves executables from user-local bin directories', () => {
    const userLocalBin = path.join(os.homedir(), '.local', 'bin');
    const restorePath = process.env.PATH;
    const createdUserLocalDir = !fs.existsSync(userLocalBin);
    const tempDir = makeTempDir();
    const originalBinaryPath = path.join(userLocalBin, 'cli-bridge-test-bin');
    const tempBinaryPath = path.join(tempDir, 'cli-bridge-test-bin');
    const hadOriginalBinary = fs.existsSync(originalBinaryPath);

    fs.mkdirSync(userLocalBin, { recursive: true });
    if (hadOriginalBinary) {
      fs.renameSync(originalBinaryPath, tempBinaryPath);
    }

    try {
      fs.writeFileSync(originalBinaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = '/usr/bin:/bin';
      expect(resolveBinary('cli-bridge-test-bin')).toBe(originalBinaryPath);
    } finally {
      fs.rmSync(originalBinaryPath, { force: true });
      if (hadOriginalBinary) {
        fs.renameSync(tempBinaryPath, originalBinaryPath);
      }
      if (createdUserLocalDir) {
        fs.rmdirSync(userLocalBin);
      }
      process.env.PATH = restorePath;
    }
  });

  it('skips non-executable files while resolving binaries', () => {
    const tempDir = makeTempDir();
    const binaryPath = path.join(tempDir, 'cli-bridge-not-executable');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

    expect(resolveBinary('cli-bridge-not-executable', [tempDir])).toBe('cli-bridge-not-executable');
  });
});

describe('usesGeminiInputMode', () => {
  it('detects Gemini CLI processes by agent name', () => {
    expect(usesGeminiInputMode({
      name: 'Gemini CLI-11',
      command: 'some-other-command',
    })).toBe(true);
  });

  it('detects Gemini CLI processes by launch command', () => {
    expect(usesGeminiInputMode({
      name: 'Custom Agent',
      command: '/opt/homebrew/bin/gemini --yolo',
    })).toBe(true);
  });

  it('keeps focus-event mode for non-Gemini agents', () => {
    expect(usesGeminiInputMode({
      name: 'Claude Code',
      command: 'claude --permission-mode bypassPermissions',
    })).toBe(false);
  });
});
