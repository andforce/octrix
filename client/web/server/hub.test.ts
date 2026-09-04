import { describe, expect, it, vi } from 'vitest';
import { bodyFromConversationEntries, Hub } from './hub';
import type { ConversationEntry } from './models.js';
import type { Store } from './store.js';

function makeStore(overrides: Record<string, any> = {}): Store {
  const pmRole = { id: 'role-pm', name: '产品经理', responsibility: '需求' };
  const devRole = { id: 'role-dev', name: '研发', responsibility: '编码' };

  const pmAgent = { id: 'agent-pm', name: 'Claude Code', command: 'claude', platform: 'claude-code', avatarColor: 'blue' };
  const devAgent = { id: 'agent-dev', name: 'Cursor CLI', command: 'cursor', platform: 'cursor-cli', avatarColor: 'green' };

  const group = {
    id: 'g1', name: 'Test', ownerName: '群主',
    members: [
      { id: 'm1', agentId: 'agent-pm', roleId: 'role-pm' },
      { id: 'm2', agentId: 'agent-dev', roleId: 'role-dev' },
    ],
    groupType: 'execution' as const,
    activeTaskSessionId: 'ts-1',
    createdAt: Date.now() / 1000,
  };

  return {
    agents: [pmAgent, devAgent],
    groups: [group],
    roles: [pmRole, devRole],
    groupById: vi.fn((id: string) => id === 'g1' ? group : undefined),
    activeTaskSessionForGroup: vi.fn((id: string) => id === 'g1'
      ? { id: 'ts-1', groupId: 'g1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }
      : undefined),
    agentById: vi.fn((id: string) => {
      if (id === 'agent-pm') return pmAgent;
      if (id === 'agent-dev') return devAgent;
      return undefined;
    }),
    agentByName: vi.fn((name: string) => {
      if (name === 'Claude Code') return pmAgent;
      if (name === 'Cursor CLI') return devAgent;
      return undefined;
    }),
    role: vi.fn((id: string) => {
      if (id === 'role-pm') return pmRole;
      if (id === 'role-dev') return devRole;
      return undefined;
    }),
    ...overrides,
  } as unknown as Store;
}

function entry(role: ConversationEntry['role'], content: string, overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('bodyFromConversationEntries', () => {
  it('uses assistant text when it is available', () => {
    const body = bodyFromConversationEntries([
      entry('thinking', 'checking repository'),
      entry('assistant', 'Here is the result.'),
    ]);

    expect(body).toBe('Here is the result.');
  });

  it('prefers completed assistant text over Codex streaming assistant text', () => {
    const body = bodyFromConversationEntries([
      entry('assistant', 'partial answer', { id: 'codex-stream-assistant-msg-1' }),
      entry('assistant', 'complete answer'),
    ]);

    expect(body).toBe('complete answer');
  });

  it('falls back to real thinking and tool previews before assistant text exists', () => {
    const body = bodyFromConversationEntries([
      entry('user', 'ignored prompt echo'),
      entry('thinking', 'I need to inspect the Codex session stream.'),
      entry('tool', '{"cmd":"rg codex"}', { toolName: 'exec_command' }),
    ]);

    expect(body).toContain('思考：I need to inspect');
    expect(body).toContain('工具 exec_command：{"cmd":"rg codex"}');
    expect(body).not.toContain('ignored prompt echo');
  });
});

describe('Hub.appendOrUpdateAgentEntries', () => {
  it('creates a streaming message with a non-empty preview for pre-answer entries', () => {
    const hub = new Hub(makeStore(), 9800);
    const id = hub.appendOrUpdateAgentEntries(undefined, 'OpenAI Codex CLI', [
      entry('thinking', 'reading the session file'),
    ], 'g1', 'ts-1');

    const message = hub.messages.find(m => m.id === id);
    expect(message?.body).toBe('思考：reading the session file');
    expect(message?.status).toBe('streaming');
    expect(message?.entries).toHaveLength(1);
  });

  it('broadcasts assistant text once the final answer is available', () => {
    const hub = new Hub(makeStore(), 9800);
    const send = vi.fn();
    hub.addWsClient({ readyState: 1, send, on: vi.fn() } as any);

    const id = hub.appendOrUpdateAgentEntries(undefined, 'OpenAI Codex CLI', [
      entry('thinking', 'planning response'),
    ], 'g1', 'ts-1');
    hub.appendOrUpdateAgentEntries(id, 'OpenAI Codex CLI', [
      entry('thinking', 'planning response'),
      entry('assistant', 'Done.'),
    ], 'g1', 'ts-1');

    const update = JSON.parse(send.mock.calls.at(-1)?.[0] as string);
    expect(update.event).toBe('messages:update');
    expect(update.data).toMatchObject({
      id,
      body: 'Done.',
      status: 'streaming',
    });
  });
});

describe('Hub.appendOrUpdateAgentEntries', () => {
  it('merges structured entry updates by id', () => {
    const hub = new Hub(makeStore(), 9800);
    const id = hub.appendOrUpdateAgentEntries(undefined, 'Claude Code', [{
      id: 'entry-1',
      role: 'assistant',
      content: 'partial',
      timestamp: 1,
    }], 'g1', 'ts-1');

    hub.appendOrUpdateAgentEntries(id, 'Claude Code', [{
      id: 'entry-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 2,
    }], 'g1', 'ts-1');

    expect(hub.messages).toHaveLength(1);
    expect(hub.messages[0].body).toBe('partial answer');
    expect(hub.messages[0].entries).toHaveLength(1);
    expect(hub.messages[0].entries?.[0].content).toBe('partial answer');
  });

  it('merges structured entry updates by dedupeKey', () => {
    const hub = new Hub(makeStore(), 9800);
    const id = hub.appendOrUpdateAgentEntries(undefined, 'OpenAI Codex CLI', [{
      id: 'event-entry',
      dedupeKey: 'same-codex-message',
      role: 'assistant',
      content: 'partial',
      timestamp: 1,
    }], 'g1', 'ts-1');

    hub.appendOrUpdateAgentEntries(id, 'OpenAI Codex CLI', [{
      id: 'response-entry',
      dedupeKey: 'same-codex-message',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 2,
    }], 'g1', 'ts-1');

    expect(hub.messages).toHaveLength(1);
    expect(hub.messages[0].body).toBe('partial answer');
    expect(hub.messages[0].entries).toHaveLength(1);
    expect(hub.messages[0].entries?.[0].id).toBe('response-entry');
  });

  it('uses final_answer entries as the visible body when available', () => {
    const hub = new Hub(makeStore(), 9800);
    const id = hub.appendOrUpdateAgentEntries(undefined, 'OpenAI Codex CLI', [{
      id: 'commentary',
      role: 'assistant',
      phase: 'commentary',
      content: 'working on it',
      timestamp: 1,
    }], 'g1', 'ts-1');

    expect(hub.messages[0].body).toBe('working on it');

    hub.appendOrUpdateAgentEntries(id, 'OpenAI Codex CLI', [{
      id: 'final',
      role: 'assistant',
      phase: 'final_answer',
      content: 'done',
      timestamp: 2,
    }], 'g1', 'ts-1');

    expect(hub.messages[0].body).toBe('done');
  });

  it('can append structured entries as complete when there is no active pending response', () => {
    const hub = new Hub(makeStore(), 9800);

    const id = hub.appendOrUpdateAgentEntries(undefined, 'OpenClaude', [{
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
    }], 'g1', 'ts-1', 'complete');

    expect(hub.messages).toHaveLength(1);
    expect(hub.messages[0].id).toBe(id);
    expect(hub.messages[0].status).toBe('complete');
  });
});

describe('Hub realtime events', () => {
  it('broadcasts seq/serverTime envelopes and keeps an event log for catch-up', () => {
    const hub = new Hub(makeStore(), 9800);
    const sent: string[] = [];
    const ws = {
      readyState: 1,
      send: vi.fn((message: string) => sent.push(message)),
      on: vi.fn(),
    };
    hub.addWsClient(ws as any);

    hub.broadcast('messages:update', { id: 'm1', body: 'hello' });

    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]);
    expect(payload).toMatchObject({
      event: 'messages:update',
      data: { id: 'm1', body: 'hello' },
      seq: 1,
    });
    expect(typeof payload.serverTime).toBe('number');
    expect(hub.eventsSince(0, 10).events).toEqual([payload]);
    expect(hub.eventsSince(1, 10).events).toEqual([]);
  });
});

describe('Hub collaboration protocol resilience', () => {
  it('records one consecutive protocol failure per malformed response', () => {
    const recordProtocolFailure = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(3);
    const store = makeStore({
      recordProtocolFailure,
      activeTaskSessionForGroup: vi.fn().mockReturnValue({ id: 'ts-1', kind: 'mission', status: 'active' }),
    });
    const hub = new Hub(store, 9800);
    const malformed = [
      '```octrix-action',
      'action: work.accept',
      'requestId: broken',
      'missionId: ts-1',
      'workItemId: wi-1',
      '```',
    ].join('\n');

    hub.routeCollaborationControlBlocks('Claude Code', malformed, 'g1', 'ts-1');
    hub.routeCollaborationControlBlocks('Claude Code', malformed, 'g1', 'ts-1');
    hub.routeCollaborationControlBlocks('Claude Code', malformed, 'g1', 'ts-1');

    expect(recordProtocolFailure).toHaveBeenCalledTimes(3);
    expect(recordProtocolFailure).toHaveBeenLastCalledWith(
      'g1',
      'ts-1',
      'm1',
      expect.stringContaining('expectedRevision'),
    );
  });
});
