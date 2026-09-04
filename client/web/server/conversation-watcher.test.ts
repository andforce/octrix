import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationWatcher,
  detectProfileId,
  encodeCodeBuddyProjectPath,
  getCodeBuddyProjectDir,
  getKiroCliDbPath,
  getOpenCodeDbPath,
  getQoderProjectDir,
  isStreamingConversationEntry,
  parseCodexSessionObject,
  parseCopilotEventObject,
  parseCursorTranscriptObject,
  parseGeminiSessionFile,
  startWhenFileExists,
} from './conversation-watcher';

const tempDirs: string[] = [];
const CLAUDE_JSONL_PROFILES = [
  { profileId: 'claude', label: 'Claude Code', configDirName: '.claude' },
  { profileId: 'openclaude', label: 'OpenClaude', configDirName: '.openclaude' },
] as const;

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-watcher-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectProfileId', () => {
  it('detects the supported platforms from normalized commands', () => {
    expect(detectProfileId('claude')).toBe('claude');
    expect(detectProfileId('openclaude')).toBe('openclaude');
    expect(detectProfileId('cursor')).toBe('cursor-cli');
    expect(detectProfileId('agent')).toBe('cursor-cli');
    expect(detectProfileId('codex')).toBe('codex');
    expect(detectProfileId('opencode')).toBe('opencode');
    expect(detectProfileId('kiro-cli')).toBe('kiro-cli');
    expect(detectProfileId('kiro')).toBe('kiro-cli');
    expect(detectProfileId('qodercli')).toBe('qoder-cli');
    expect(detectProfileId('codebuddy')).toBe('codebuddy-cli');
    expect(detectProfileId('gemini')).toBe('gemini-cli');
    expect(detectProfileId('github-copilot-cli')).toBe('github-copilot-cli');
  });

  it('detects commands with absolute paths and flags', () => {
    expect(detectProfileId('/opt/homebrew/bin/claude --dangerously-skip-permissions')).toBe('claude');
    expect(detectProfileId('/Users/alice/.local/bin/openclaude --permission-mode bypassPermissions')).toBe('openclaude');
    expect(detectProfileId('/usr/local/bin/cursor --model gpt-5.4')).toBe('cursor-cli');
    expect(detectProfileId('/usr/bin/github-copilot-cli --help')).toBe('github-copilot-cli');
    expect(detectProfileId('/opt/homebrew/bin/kiro-cli chat --trust-all-tools')).toBe('kiro-cli');
    expect(detectProfileId('/usr/local/bin/qodercli --dangerously-skip-permissions')).toBe('qoder-cli');
    expect(detectProfileId('/usr/local/bin/codebuddy -y')).toBe('codebuddy-cli');
  });

  it('supports common GitHub Copilot CLI aliases', () => {
    expect(detectProfileId('copilot')).toBe('github-copilot-cli');
    expect(detectProfileId('gh-copilot')).toBe('github-copilot-cli');
  });

  it('returns null for unsupported commands', () => {
    expect(detectProfileId('python script.py')).toBeNull();
  });
});

describe('parseCodexSessionObject', () => {
  it('parses agent_message events with phase and stable dedupe metadata', () => {
    const entries = parseCodexSessionObject({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'early visible answer', phase: 'commentary' },
      timestamp: '2026-07-06T01:00:00.000Z',
    }, { turnId: 'turn-1' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      content: 'early visible answer',
      phase: 'commentary',
      source: 'codex_jsonl_event',
      turnId: 'turn-1',
      itemType: 'assistant_message',
    });
    expect(entries[0].dedupeKey).toContain('codex:turn-1:assistant:commentary:assistant_message:');
  });

  it('dedupes equivalent agent_message and response_item message rows', () => {
    const eventEntries = parseCodexSessionObject({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'same text', phase: 'final_answer' },
    }, { turnId: 'turn-1' });
    const responseEntries = parseCodexSessionObject({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'same text' }],
      },
    }, { turnId: 'turn-1' });

    expect(responseEntries).toHaveLength(1);
    expect(responseEntries[0].dedupeKey).toBe(eventEntries[0].dedupeKey);
    expect(responseEntries[0].source).toBe('codex_jsonl_response_item');
  });

  it('parses task_complete last_agent_message as final answer with metrics', () => {
    const entries = parseCodexSessionObject({
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-2',
        last_agent_message: 'final answer',
        duration_ms: 1234,
        time_to_first_token_ms: 456,
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      content: 'final answer',
      phase: 'final_answer',
      source: 'codex_jsonl_task_complete',
      turnId: 'turn-2',
      metrics: { durationMs: 1234, timeToFirstTokenMs: 456 },
    });
  });

  it('parses agent_reasoning and ignores raw reasoning content', () => {
    expect(parseCodexSessionObject({
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: 'summary only' },
    }, { turnId: 'turn-1' })[0]).toMatchObject({
      role: 'thinking',
      content: 'summary only',
      source: 'codex_jsonl_event',
      itemType: 'reasoning',
    });

    expect(parseCodexSessionObject({
      type: 'event_msg',
      payload: { type: 'agent_reasoning_raw_content', text: 'raw hidden thought' },
    }, { turnId: 'turn-1' })).toHaveLength(0);
  });

  it('parses extended Codex tool response items', () => {
    const samples = [
      { payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'patch' }, toolName: 'apply_patch' },
      { payload: { type: 'custom_tool_call_output', name: 'apply_patch', output: 'ok' }, toolName: 'apply_patch' },
      { payload: { type: 'tool_search_call', execution: 'search', arguments: { query: 'x' } }, toolName: 'tool_search' },
      { payload: { type: 'tool_search_output', execution: 'search', status: 'completed', tools: [{ name: 'x' }] }, toolName: 'tool_search_result' },
      { payload: { type: 'local_shell_call', status: 'completed', action: { command: 'pwd' } }, toolName: 'local_shell' },
      { payload: { type: 'web_search_call', status: 'completed', action: { query: 'news' } }, toolName: 'web_search' },
      { payload: { type: 'image_generation_call', status: 'completed', revised_prompt: 'draw', result: 'base64' }, toolName: 'image_generation' },
    ];

    for (const sample of samples) {
      const entries = parseCodexSessionObject({
        type: 'response_item',
        payload: sample.payload,
      }, { turnId: 'turn-tool' });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        role: 'tool',
        toolName: sample.toolName,
        source: 'codex_jsonl_response_item',
        turnId: 'turn-tool',
        itemType: sample.payload.type,
      });
      expect(entries[0].content).not.toBe('');
    }
  });

  it('parses request_user_input function calls as structured human input entries', () => {
    const entries = parseCodexSessionObject({
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc-1',
        name: 'request_user_input',
        call_id: 'call-ask-1',
        arguments: JSON.stringify({
          autoResolutionMs: 60000,
          questions: [{
            id: 'dialog_kind',
            header: '范围',
            question: '交互对话框做在哪一端？',
            options: [
              { label: 'iOS + 后端 (Recommended)', description: '先让 iPhone 端可用。' },
              { label: 'Web + iOS + 后端', description: '两端都支持。' },
            ],
          }],
        }),
      },
    }, { turnId: 'turn-human' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'tool',
      toolName: 'request_user_input',
      itemType: 'request_user_input',
      source: 'codex_jsonl_response_item',
      turnId: 'turn-human',
      content: '交互对话框做在哪一端？',
      humanInput: {
        callId: 'call-ask-1',
        status: 'pending',
        autoResolutionMs: 60000,
        questions: [{
          id: 'dialog_kind',
          header: '范围',
          question: '交互对话框做在哪一端？',
          options: [
            { label: 'iOS + 后端 (Recommended)', description: '先让 iPhone 端可用。' },
            { label: 'Web + iOS + 后端', description: '两端都支持。' },
          ],
        }],
      },
    });
    expect(entries[0].dedupeKey).toContain('call-ask-1');
  });

  it('parses request_user_input outputs as answered updates using the same dedupe key', () => {
    const request = parseCodexSessionObject({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call-ask-2',
        arguments: JSON.stringify({
          questions: [{
            id: 'target_surface',
            question: '实现在哪些端？',
            options: [{ label: 'iOS + 后端 (Recommended)' }],
          }],
        }),
      },
    }, { turnId: 'turn-human' });
    const output = parseCodexSessionObject({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-ask-2',
        output: JSON.stringify({
          answers: {
            target_surface: { answers: ['iOS + 后端 (Recommended)'] },
          },
        }),
      },
    }, { turnId: 'turn-human' });

    expect(output).toHaveLength(1);
    expect(output[0].dedupeKey).toBe(request[0].dedupeKey);
    expect(output[0]).toMatchObject({
      role: 'tool',
      toolName: 'request_user_input',
      itemType: 'request_user_input',
      humanInput: {
        callId: 'call-ask-2',
        status: 'answered',
        selectedAnswers: {
          target_surface: ['iOS + 后端 (Recommended)'],
        },
      },
    });
  });
});

describe('Codex CLI watcher', () => {
  function writeCodexSession(
    filePath: string,
    cwd: string,
    prompt: string,
    answer: string,
    sessionId: string,
  ) {
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-16T08:51:00.000Z',
        payload: { id: sessionId, cwd, originator: 'codex-tui' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T08:51:00.500Z',
        payload: {
          type: 'user_message',
          message: '# AGENTS.md instructions\n<environment_context>injected context</environment_context>',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T08:51:01.000Z',
        payload: { type: 'task_started', turn_id: `turn-${sessionId}` },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T08:51:02.000Z',
        payload: { type: 'user_message', message: prompt },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T08:51:03.000Z',
        payload: { type: 'agent_message', message: answer, phase: 'final_answer' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-16T08:51:04.000Z',
        payload: { type: 'task_complete', turn_id: `turn-${sessionId}`, last_agent_message: answer },
      }),
    ].join('\n') + '\n');
  }

  it('switches to the next Codex JSONL session and emits its reply', () => {
    const dir = makeTempDir();
    const oldFile = path.join(dir, 'old.jsonl');
    const newFile = path.join(dir, 'new.jsonl');
    writeCodexSession(oldFile, dir, 'old prompt', 'old answer', 'old');
    writeCodexSession(newFile, dir, '介绍一下当前项目', '当前项目是一个收藏展示网站', 'new');
    const watcher = new ConversationWatcher('codex', dir) as any;
    const emitted: any[] = [];
    const resets: any[] = [];

    try {
      watcher.stop();
      watcher.stopped = false;
      watcher.on('entries', (entries: any[]) => emitted.push(...entries));
      watcher.on('reset', (event: any) => resets.push(event));
      watcher.onSessionFileFound(oldFile);
      emitted.length = 0;

      watcher.noteExpectedCodexPrompt('介绍一下当前项目');
      watcher.onSessionFileFound(newFile);

      expect(resets).toEqual([{ reason: 'session_switch', filePath: newFile }]);
      expect(emitted).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          phase: 'final_answer',
          content: '当前项目是一个收藏展示网站',
        }),
      ]));
    } finally {
      watcher.stop();
    }
  });

  it('assigns same-directory Codex sessions by their expected prompt without sharing one file', () => {
    const dir = makeTempDir();
    const firstFile = path.join(dir, 'first.jsonl');
    const secondFile = path.join(dir, 'second.jsonl');
    writeCodexSession(firstFile, dir, '研发 Leader 任务', 'leader answer', 'first');
    writeCodexSession(secondFile, dir, '研发成员任务', 'member answer', 'second');
    const leaderWatcher = new ConversationWatcher('codex', dir) as any;
    const memberWatcher = new ConversationWatcher('codex', dir) as any;

    try {
      leaderWatcher.stop();
      memberWatcher.stop();
      leaderWatcher.stopped = false;
      memberWatcher.stopped = false;
      leaderWatcher.spawnTime = 0;
      memberWatcher.spawnTime = 0;
      leaderWatcher.noteExpectedCodexPrompt('研发 Leader 任务');
      memberWatcher.noteExpectedCodexPrompt('研发成员任务');

      const leaderFile = leaderWatcher.findNewCodexSessionFile(dir);
      leaderWatcher.onSessionFileFound(leaderFile);
      const memberFile = memberWatcher.findNewCodexSessionFile(dir);
      memberWatcher.onSessionFileFound(memberFile);

      expect(leaderWatcher.sessionFile).toBe(firstFile);
      expect(memberWatcher.sessionFile).toBe(secondFile);
    } finally {
      leaderWatcher.stop();
      memberWatcher.stop();
    }
  });

  it('never lets two same-directory Codex watchers claim the same session file', () => {
    const dir = makeTempDir();
    const firstFile = path.join(dir, 'same-first.jsonl');
    const secondFile = path.join(dir, 'same-second.jsonl');
    writeCodexSession(firstFile, dir, '同一条群消息', 'first answer', 'same-first');
    writeCodexSession(secondFile, dir, '同一条群消息', 'second answer', 'same-second');
    const firstWatcher = new ConversationWatcher('codex', dir) as any;
    const secondWatcher = new ConversationWatcher('codex', dir) as any;

    try {
      firstWatcher.stop();
      secondWatcher.stop();
      firstWatcher.stopped = false;
      secondWatcher.stopped = false;
      firstWatcher.spawnTime = 0;
      secondWatcher.spawnTime = 0;
      firstWatcher.noteExpectedCodexPrompt('同一条群消息');
      secondWatcher.noteExpectedCodexPrompt('同一条群消息');

      firstWatcher.onSessionFileFound(firstWatcher.findNewCodexSessionFile(dir));
      secondWatcher.onSessionFileFound(secondWatcher.findNewCodexSessionFile(dir));

      expect(new Set([firstWatcher.sessionFile, secondWatcher.sessionFile])).toEqual(
        new Set([firstFile, secondFile]),
      );
    } finally {
      firstWatcher.stop();
      secondWatcher.stop();
    }
  });

  it('ignores a newer Codex session from another working directory', () => {
    const dir = makeTempDir();
    const ownFile = path.join(dir, 'own.jsonl');
    const otherFile = path.join(dir, 'other.jsonl');
    writeCodexSession(ownFile, '/Users/alice/project', 'own prompt', 'own answer', 'own');
    writeCodexSession(otherFile, '/Users/alice/other', 'other prompt', 'other answer', 'other');
    const watcher = new ConversationWatcher('codex', '/Users/alice/project') as any;

    try {
      watcher.stop();
      watcher.stopped = false;
      watcher.spawnTime = 0;
      watcher.noteExpectedCodexPrompt('own prompt');

      expect(watcher.findNewCodexSessionFile(dir)).toBe(ownFile);
    } finally {
      watcher.stop();
    }
  });

  it('associates a manually typed terminal prompt with the new Codex session', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'manual.jsonl');
    writeCodexSession(filePath, dir, '介绍一下当前项目', '项目介绍', 'manual');
    const watcher = new ConversationWatcher('codex', dir) as any;

    try {
      watcher.stop();
      watcher.stopped = false;
      watcher.spawnTime = 0;
      watcher.noteCodexTerminalInput('/new\r');
      watcher.noteCodexTerminalInput('介绍一下');
      watcher.noteCodexTerminalInput('当前项目\r');

      expect(watcher.findNewCodexSessionFile(dir)).toBe(filePath);
    } finally {
      watcher.stop();
    }
  });

  it('emits native turn boundaries for response-scoped lifecycle tracking', () => {
    const watcher = new ConversationWatcher('codex', '/tmp') as any;
    const started = vi.fn();
    const completed = vi.fn();
    watcher.on('turn-started', started);
    watcher.on('turn-completed', completed);

    watcher.parseTranscriptLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }));
    watcher.parseTranscriptLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' },
    }));
    watcher.stop();

    expect(started).toHaveBeenCalledWith('turn-1');
    expect(completed).toHaveBeenCalledWith('turn-1');
  });

  it('accumulates assistant content deltas into a stable streaming entry', () => {
    const watcher = new ConversationWatcher('codex', '/tmp') as any;
    const first = watcher.parseTranscriptLine(JSON.stringify({
      timestamp: '2026-03-23T16:33:59.840Z',
      type: 'event_msg',
      payload: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: 'Hel' },
    }));
    const second = watcher.parseTranscriptLine(JSON.stringify({
      timestamp: '2026-03-23T16:34:00.840Z',
      type: 'event_msg',
      payload: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: 'lo' },
    }));
    watcher.stop();

    expect(first).toHaveLength(1);
    expect(isStreamingConversationEntry(first[0])).toBe(true);
    expect(first[0]).toMatchObject({ role: 'assistant', content: 'Hel' });
    expect(second[0]).toMatchObject({ id: first[0].id, role: 'assistant', content: 'Hello' });
  });

  it('accumulates reasoning summary deltas but ignores raw reasoning deltas', () => {
    const watcher = new ConversationWatcher('codex', '/tmp') as any;
    const summary = watcher.parseTranscriptLine(JSON.stringify({
      timestamp: '2026-03-23T16:33:59.840Z',
      type: 'event_msg',
      payload: { type: 'reasoning_content_delta', item_id: 'rsn-1', delta: 'Checking files' },
    }));
    const raw = watcher.parseTranscriptLine(JSON.stringify({
      timestamp: '2026-03-23T16:34:00.840Z',
      type: 'event_msg',
      payload: { type: 'reasoning_raw_content_delta', item_id: 'raw-1', delta: 'hidden chain' },
    }));
    watcher.stop();

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ role: 'thinking', content: 'Checking files' });
    expect(raw).toHaveLength(0);
  });
});

describe('parseCopilotEventObject', () => {
  it('parses user.message events', () => {
    const entries = parseCopilotEventObject({
      type: 'user.message',
      data: { content: 'hello from copilot' },
      id: 'msg-1',
      timestamp: '2026-03-23T16:33:59.840Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('hello from copilot');
    expect(entries[0].id).toBe('msg-1');
  });

  it('parses assistant.message events with content', () => {
    const entries = parseCopilotEventObject({
      type: 'assistant.message',
      data: {
        messageId: 'asst-1',
        content: 'Hello! How can I help?',
        toolRequests: [],
        outputTokens: 9,
      },
      id: 'evt-1',
      timestamp: '2026-03-23T17:07:17.298Z',
    }, 'copilot-turn-1');

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('assistant');
    expect(entries[0].content).toBe('Hello! How can I help?');
    expect(entries[0].id).toBe('asst-1');
    expect(entries[0].turnId).toBe('copilot-turn-1');
    expect(entries[0].tokens).toEqual({ input: 0, output: 9, reasoning: 0 });
  });

  it('parses assistant.message events with tool requests', () => {
    const entries = parseCopilotEventObject({
      type: 'assistant.message',
      data: {
        messageId: 'asst-2',
        content: 'Let me check that file.',
        toolRequests: [
          {
            toolCallId: 'tc-1',
            name: 'view',
            arguments: { path: '/src/index.ts' },
            type: 'function',
          },
        ],
      },
      id: 'evt-2',
      timestamp: '2026-03-20T08:31:06.373Z',
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('assistant');
    expect(entries[0].content).toBe('Let me check that file.');
    expect(entries[1].role).toBe('tool');
    expect(entries[1].toolName).toBe('view');
    expect(entries[1].id).toBe('tc-1');
  });

  it('parses tool.execution_complete events', () => {
    const entries = parseCopilotEventObject({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-1',
        success: true,
        result: { content: 'file contents here' },
      },
      id: 'evt-3',
      timestamp: '2026-03-20T08:31:14.793Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool');
    expect(entries[0].toolName).toBe('result');
    expect(entries[0].content).toBe('file contents here');
    expect(entries[0].id).toBe('tc-1');
  });

  it('parses session.error events', () => {
    const entries = parseCopilotEventObject({
      type: 'session.error',
      data: { errorType: 'quota', message: '402 You have no quota', statusCode: 402 },
      id: 'err-1',
      timestamp: '2026-03-23T16:34:00.838Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('system');
    expect(entries[0].content).toBe('402 You have no quota');
  });

  it('ignores non-content events like turn_start/turn_end', () => {
    expect(parseCopilotEventObject({
      type: 'assistant.turn_start',
      data: { turnId: '0' },
      id: 'ts-1',
      timestamp: '2026-03-23T16:33:59.843Z',
    })).toHaveLength(0);

    expect(parseCopilotEventObject({
      type: 'session.start',
      data: { sessionId: 'abc', version: 1 },
      id: 'ss-1',
      timestamp: '2026-03-23T16:33:53.181Z',
    })).toHaveLength(0);
  });

  it('is used by ConversationWatcher for github-copilot-cli profile', () => {
    const watcher = new ConversationWatcher('github-copilot-cli', '/tmp') as any;
    const pendingEntries = watcher.parseTranscriptLine(JSON.stringify({
      type: 'user.message',
      data: { content: 'hello from copilot' },
      id: 'msg-1',
      timestamp: '2026-03-23T16:33:59.840Z',
    }));
    const entries = watcher.parseTranscriptLine(JSON.stringify({
      type: 'assistant.turn_start',
      data: { turnId: 'turn-1' },
      id: 'turn-start-1',
    }));
    watcher.stop();

    expect(pendingEntries).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('hello from copilot');
    expect(entries[0].turnId).toBe('turn-1');
  });
});

describe('non-Codex transcript turn identity', () => {
  it('links Cursor assistant entries to their parent user UUID', () => {
    const user = parseCursorTranscriptObject({
      role: 'user',
      uuid: 'cursor-turn-1',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    const assistant = parseCursorTranscriptObject({
      role: 'assistant',
      uuid: 'cursor-assistant-1',
      parentUuid: 'cursor-turn-1',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });

    expect(user[0].turnId).toBe('cursor-turn-1');
    expect(assistant[0].turnId).toBe('cursor-turn-1');
  });

  it('groups Gemini entries under the preceding user message ID', () => {
    const entries = parseGeminiSessionFile({
      messages: [
        { id: 'gemini-turn-1', type: 'user', content: 'hello' },
        { id: 'gemini-answer-1', type: 'gemini', content: 'hi' },
        { id: 'gemini-turn-2', type: 'user', content: 'next' },
        { id: 'gemini-answer-2', type: 'gemini', content: 'done' },
      ],
    });

    expect(entries.map(entry => entry.turnId)).toEqual([
      'gemini-turn-1',
      'gemini-turn-1',
      'gemini-turn-2',
      'gemini-turn-2',
    ]);
  });

  it('emits Copilot native turn boundaries and scopes assistant entries', () => {
    const watcher = new ConversationWatcher('github-copilot-cli', '/tmp') as any;
    const started = vi.fn();
    const completed = vi.fn();
    watcher.on('turn-started', started);
    watcher.on('turn-completed', completed);

    watcher.parseTranscriptLine(JSON.stringify({
      type: 'assistant.turn_start',
      data: { turnId: 'copilot-turn-1' },
    }));
    const entries = watcher.parseTranscriptLine(JSON.stringify({
      type: 'assistant.message',
      data: { content: 'answer' },
    }));
    watcher.parseTranscriptLine(JSON.stringify({
      type: 'assistant.turn_end',
      data: { turnId: 'copilot-turn-1' },
    }));
    watcher.stop();

    expect(started).toHaveBeenCalledWith('copilot-turn-1');
    expect(entries[0].turnId).toBe('copilot-turn-1');
    expect(completed).toHaveBeenCalledWith('copilot-turn-1');
  });
});

describe('ConversationWatcher JSONL streaming reads', () => {
  it('buffers partial JSONL records instead of dropping them', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'events.jsonl');
    const line = JSON.stringify({
      type: 'user.message',
      data: { content: 'hello from a split jsonl record' },
      id: 'msg-split',
      timestamp: '2026-03-23T16:33:59.840Z',
    });
    const splitAt = Math.floor(line.length / 2);
    const emitted: unknown[] = [];
    const watcher = new ConversationWatcher('github-copilot-cli', dir) as any;

    try {
      watcher.on('entries', (entries: unknown[]) => emitted.push(...entries));
      watcher.sessionFile = filePath;

      fs.writeFileSync(filePath, line.slice(0, splitAt));
      watcher.readJsonlUpdates();
      expect(emitted).toHaveLength(0);

      fs.appendFileSync(filePath, `${line.slice(splitAt)}\n`);
      watcher.readJsonlUpdates();
      expect(emitted).toHaveLength(0);

      fs.appendFileSync(filePath, `${JSON.stringify({
        type: 'assistant.turn_start',
        data: { turnId: 'turn-split' },
      })}\n`);
      watcher.readJsonlUpdates();
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as { content: string }).content).toBe('hello from a split jsonl record');
    } finally {
      watcher.stop();
    }
  });

  it('reads multibyte JSONL records incrementally without duplicating old content', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'events.jsonl');
    const firstLine = JSON.stringify({
      type: 'user.message',
      data: { content: '你好，第一条' },
      id: 'msg-cn-1',
      timestamp: '2026-03-23T16:33:59.840Z',
    });
    const secondLine = JSON.stringify({
      type: 'user.message',
      data: { content: '第二条' },
      id: 'msg-cn-2',
      timestamp: '2026-03-23T16:34:00.840Z',
    });
    const emitted: unknown[] = [];
    const watcher = new ConversationWatcher('github-copilot-cli', dir) as any;

    try {
      watcher.on('entries', (entries: unknown[]) => emitted.push(...entries));
      watcher.sessionFile = filePath;

      fs.writeFileSync(filePath, `${firstLine}\n`);
      watcher.readJsonlUpdates();
      fs.appendFileSync(filePath, `${secondLine}\n`);
      watcher.readJsonlUpdates();
      expect(emitted).toHaveLength(0);

      fs.appendFileSync(filePath, `${JSON.stringify({
        type: 'assistant.turn_start',
        data: { turnId: 'turn-cn' },
      })}\n`);
      watcher.readJsonlUpdates();

      expect(emitted).toHaveLength(2);
      expect(emitted.map(entry => (entry as { id: string }).id)).toEqual(['msg-cn-1', 'msg-cn-2']);
    } finally {
      watcher.stop();
    }
  });

  it('emits reset when the JSONL file is truncated', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'events.jsonl');
    const line = JSON.stringify({
      type: 'user.message',
      data: { content: 'before truncate' },
      id: 'msg-before-truncate',
    });
    const watcher = new ConversationWatcher('github-copilot-cli', dir) as any;
    const resets: Array<{ reason?: string; filePath?: string }> = [];

    try {
      watcher.on('reset', (event: { reason?: string; filePath?: string }) => resets.push(event));
      watcher.sessionFile = filePath;

      fs.writeFileSync(filePath, `${line}\n${line}\n`);
      watcher.readJsonlUpdates();
      fs.writeFileSync(filePath, `${line}\n`);
      watcher.readJsonlUpdates();

      expect(resets).toEqual([{ reason: 'truncate', filePath }]);
    } finally {
      watcher.stop();
    }
  });
});

describe('Claude/OpenClaude JSONL parser', () => {
  it.each(CLAUDE_JSONL_PROFILES)('parses user-embedded tool_result blocks as tool entries for $label', ({ profileId }) => {
    const watcher = new ConversationWatcher(profileId, '/tmp') as any;

    try {
      const entries = watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        uuid: 'user-tool-result',
        timestamp: '2026-07-06T01:00:00.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: [{ type: 'text', text: '工具输出\n第二行' }],
          }],
        },
        toolUseResult: { ok: true },
      }));

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'toolu_123-result',
        role: 'tool',
        toolName: 'result',
        content: '工具输出\n第二行',
      });
    } finally {
      watcher.stop();
    }
  });

  it.each(CLAUDE_JSONL_PROFILES)('does not surface $label meta user messages unless they contain tool results', ({ profileId }) => {
    const watcher = new ConversationWatcher(profileId, '/tmp') as any;

    try {
      expect(watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        uuid: 'meta-user',
        isMeta: true,
        message: {
          role: 'user',
          content: '<system-reminder>hidden</system-reminder>',
        },
      }))).toHaveLength(0);
    } finally {
      watcher.stop();
    }
  });

  it('parses assistant entries identically for Claude Code and OpenClaude', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-jsonl',
      timestamp: '2026-07-06T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should inspect the repository first.' },
          { type: 'text', text: 'Let me check the current state of the repository.' },
          { type: 'tool_use', id: 'toolu_456', name: 'Bash', input: { command: 'git status --short' } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      },
    });
    const parsed = CLAUDE_JSONL_PROFILES.map(({ profileId }) => {
      const watcher = new ConversationWatcher(profileId, '/tmp') as any;
      try {
        return watcher.parseTranscriptLine(line);
      } finally {
        watcher.stop();
      }
    });

    expect(parsed[0]).toEqual(parsed[1]);
    expect((parsed[0] as Array<{ role: string }>).map(entry => entry.role)).toEqual(['thinking', 'assistant', 'tool']);
    expect(parsed[0][2]).toMatchObject({
      id: 'toolu_456',
      role: 'tool',
      toolName: 'Bash',
    });
  });

  it.each(CLAUDE_JSONL_PROFILES)('parses $label AskUserQuestion tool use as a human input entry', ({ profileId }) => {
    const watcher = new ConversationWatcher(profileId, '/tmp') as any;
    try {
      const entries = watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant',
        uuid: 'ask-user-message',
        timestamp: '2026-07-06T23:23:57.951Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call_00_ask',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Which weather data source do you want to use?',
                header: 'API choice',
                options: [
                  { label: 'wttr.in', description: 'Free, no API key required' },
                  { label: 'OpenWeatherMap', description: 'Requires free API key' },
                ],
                multiSelect: false,
              }, {
                question: 'What forecast details do you want?',
                header: 'Data scope',
                options: [
                  { label: 'Basic', description: 'Temperature and conditions' },
                  { label: 'Extended', description: 'Precipitation and UV index' },
                ],
                multiSelect: true,
              }],
            },
          }],
        },
      }));

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'call_00_ask',
        role: 'tool',
        toolName: 'AskUserQuestion',
        itemType: 'AskUserQuestion',
        dedupeKey: 'call_00_ask',
        content: 'Which weather data source do you want to use?\nWhat forecast details do you want?',
        humanInput: {
          callId: 'call_00_ask',
          status: 'pending',
          questions: [{
            id: 'question-1',
            header: 'API choice',
            question: 'Which weather data source do you want to use?',
            options: [
              { label: 'wttr.in', description: 'Free, no API key required' },
              { label: 'OpenWeatherMap', description: 'Requires free API key' },
            ],
          }, {
            id: 'question-2',
            header: 'Data scope',
            question: 'What forecast details do you want?',
            options: [
              { label: 'Basic', description: 'Temperature and conditions' },
              { label: 'Extended', description: 'Precipitation and UV index' },
            ],
            multiSelect: true,
          }],
        },
      });
    } finally {
      watcher.stop();
    }
  });

  it.each(CLAUDE_JSONL_PROFILES)('updates only known $label AskUserQuestion tool results as answered', ({ profileId }) => {
    const watcher = new ConversationWatcher(profileId, '/tmp') as any;
    try {
      watcher.parseTranscriptLine(JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call_00_ask_result',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Choose one',
                options: [{ label: 'A' }],
              }],
            },
          }],
        },
      }));

      const askResult = watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        timestamp: '2026-07-06T23:24:57.951Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_00_ask_result',
            content: '{"answers":{"question-1":{"answers":["A"]}}}',
          }],
        },
      }));
      const normalResult = watcher.parseTranscriptLine(JSON.stringify({
        type: 'user',
        timestamp: '2026-07-06T23:25:57.951Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_00_bash',
            content: 'ordinary output',
          }],
        },
      }));

      expect(askResult).toHaveLength(1);
      expect(askResult[0]).toMatchObject({
        id: 'call_00_ask_result',
        role: 'tool',
        toolName: 'AskUserQuestion',
        itemType: 'AskUserQuestion',
        dedupeKey: 'call_00_ask_result',
        humanInput: {
          callId: 'call_00_ask_result',
          status: 'answered',
          selectedAnswers: {
            'question-1': ['A'],
          },
        },
      });
      expect(normalResult).toHaveLength(1);
      expect(normalResult[0]).toMatchObject({
        id: 'call_00_bash-result',
        role: 'tool',
        toolName: 'result',
        content: 'ordinary output',
      });
      expect(normalResult[0].humanInput).toBeUndefined();
    } finally {
      watcher.stop();
    }
  });

  it.each(CLAUDE_JSONL_PROFILES)('reads multibyte $label JSONL records incrementally without duplication', ({ profileId }) => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'events.jsonl');
    const firstLine = JSON.stringify({
      type: 'user',
      uuid: 'claude-user-1',
      timestamp: '2026-07-06T01:00:00.000Z',
      message: { role: 'user', content: '你好，第一条' },
    });
    const secondLine = JSON.stringify({
      type: 'assistant',
      uuid: 'claude-assistant-1',
      timestamp: '2026-07-06T01:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '第二条回复' }] },
    });
    const emitted: unknown[] = [];
    const watcher = new ConversationWatcher(profileId, dir) as any;

    try {
      watcher.on('entries', (entries: unknown[]) => emitted.push(...entries));
      watcher.sessionFile = filePath;

      fs.writeFileSync(filePath, `${firstLine}\n`);
      watcher.readJsonlUpdates();
      fs.appendFileSync(filePath, `${secondLine}\n`);
      watcher.readJsonlUpdates();

      expect(emitted).toHaveLength(2);
      expect(emitted.map(entry => (entry as { role: string }).role)).toEqual(['user', 'assistant']);
      expect(emitted.map(entry => (entry as { content: string }).content)).toEqual(['你好，第一条', '第二条回复']);
    } finally {
      watcher.stop();
    }
  });

  it.each(CLAUDE_JSONL_PROFILES)('emits reset when $label switches to a different session file', ({ profileId }) => {
    const dir = makeTempDir();
    const fileA = path.join(dir, 'a.jsonl');
    const fileB = path.join(dir, 'b.jsonl');
    fs.writeFileSync(fileA, '');
    fs.writeFileSync(fileB, '');
    const watcher = new ConversationWatcher(profileId, dir) as any;
    const resets: Array<{ reason?: string; filePath?: string }> = [];

    try {
      watcher.on('reset', (event: { reason?: string; filePath?: string }) => resets.push(event));
      watcher.onSessionFileFound(fileA);
      watcher.onSessionFileFound(fileB);

      expect(resets).toEqual([{ reason: 'session_switch', filePath: fileB }]);
    } finally {
      watcher.stop();
    }
  });

  it.each(CLAUDE_JSONL_PROFILES)('uses only the profile storage root as the $label project-dir difference', ({ profileId, configDirName }) => {
    const watcher = new ConversationWatcher(profileId, '/Users/alice/project') as any;

    try {
      expect(watcher.getClaudeProjectDir(configDirName)).toBe(
        `/Users/alice/${configDirName}/projects/-Users-alice-project`,
      );
    } finally {
      watcher.stop();
    }
  });
});

describe('CodeBuddy CLI watcher', () => {
  it('encodes path by replacing slashes only (preserves CJK segment names)', () => {
    expect(encodeCodeBuddyProjectPath('/Users/dywang/Desktop/未命名文件夹')).toBe('Users-dywang-Desktop-未命名文件夹');
  });

  it('resolves CodeBuddy project session dir under ~/.codebuddy/projects', () => {
    expect(getCodeBuddyProjectDir('/Users/dywang/Desktop/未命名文件夹')).toBe(
      '/Users/dywang/.codebuddy/projects/Users-dywang-Desktop-未命名文件夹',
    );
  });

  it('parses CodeBuddy message jsonl lines', () => {
    const watcher = new ConversationWatcher('codebuddy-cli', '/tmp') as any;
    const entries = watcher.parseTranscriptLine(JSON.stringify({
      id: 'be02000b-9ed7-4af7-bea4-0a316ebc0cb3',
      timestamp: 1774869277741,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '你好' }],
      sessionId: '417cb479-9f67-46fa-85d4-f2bf9bdd877a',
      cwd: '/tmp',
    }));
    watcher.stop();
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('你好');
  });
});

describe('Qoder CLI watcher', () => {
  it('resolves Qoder CLI project session dir from the workspace owner home', () => {
    expect(getQoderProjectDir('/Users/alice/my-app')).toBe('/Users/alice/.qoder/projects/-Users-alice-my-app');
  });

  it('preserves trailing slash in Qoder CLI project encoding', () => {
    expect(getQoderProjectDir('/Users/alice/未命名文件夹/')).toBe('/Users/alice/.qoder/projects/-Users-alice--------');
  });
});

describe('Kiro CLI watcher', () => {
  it('resolves Kiro CLI db path from the workspace owner home', () => {
    const p = getKiroCliDbPath('/Users/alice/project');
    expect(p).toMatch(/kiro-cli[/\\]data\.sqlite3$/);
    if (process.platform === 'darwin') {
      expect(p).toBe('/Users/alice/Library/Application Support/kiro-cli/data.sqlite3');
    } else {
      expect(p).toBe('/Users/alice/.local/share/kiro-cli/data.sqlite3');
    }
  });
});

describe('OpenCode watcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves OpenCode db path from the workspace owner home', () => {
    expect(getOpenCodeDbPath('/Users/alice/project')).toBe('/Users/alice/.local/share/opencode/opencode.db');
    expect(getOpenCodeDbPath('/tmp/project')).toMatch(/\/\.local\/share\/opencode\/opencode\.db$/);
  });

  it('links assistant parts to their parent user message turn', () => {
    const watcher = new ConversationWatcher('opencode', '/tmp') as any;
    const user = watcher.parseOpenCodePart(
      { type: 'text', text: 'hello' },
      { id: 'opencode-turn-1', role: 'user' },
      'part-user',
      1,
    );
    const assistant = watcher.parseOpenCodePart(
      { type: 'text', text: 'hi' },
      { id: 'opencode-answer-1', parentID: 'opencode-turn-1', role: 'assistant' },
      'part-assistant',
      2,
    );
    watcher.stop();

    expect(user.turnId).toBe('opencode-turn-1');
    expect(assistant.turnId).toBe('opencode-turn-1');
  });

  it('retries until the OpenCode db appears', () => {
    vi.useFakeTimers();
    const exists = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const onReady = vi.fn();
    const onWaiting = vi.fn();

    const timer = startWhenFileExists('/tmp/opencode.db', onReady, onWaiting, exists, 1000);

    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(timer).not.toBeNull();
  });
});
