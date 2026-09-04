import { describe, expect, it } from 'vitest';
import { getAgentPresence, getGroupPresence } from './agentStatus';
import type { Agent } from '../types';

const agent: Agent = {
  id: 'agent-1',
  platform: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  avatarColor: 'blue',
};

describe('agentStatus', () => {
  it('derives error, busy (initializing), busy (streaming), online, and offline in priority order', () => {
    const base = {
      runningAgentIds: [] as string[],
      initializingAgentIds: [] as string[],
      busyAgentIds: [] as string[],
      streamingAgentNames: [] as string[],
      agentErrors: {} as Record<string, string>,
    };

    expect(getAgentPresence(agent, {
      ...base,
      agentErrors: { 'agent-1': 'Token 已用尽' },
      runningAgentIds: ['agent-1'],
    })).toBe('error');

    expect(getAgentPresence(agent, {
      ...base,
      initializingAgentIds: ['agent-1'],
      runningAgentIds: ['agent-1'],
    })).toBe('busy');

    expect(getAgentPresence(agent, {
      ...base,
      busyAgentIds: ['agent-1'],
      runningAgentIds: ['agent-1'],
    })).toBe('busy');

    expect(getAgentPresence(agent, {
      ...base,
      streamingAgentNames: ['Claude Code'],
      runningAgentIds: ['agent-1'],
    })).toBe('busy');

    expect(getAgentPresence(agent, {
      ...base,
      runningAgentIds: ['agent-1'],
    })).toBe('online');

    expect(getAgentPresence(agent, base)).toBe('offline');
  });

  it('returns offline for null agent', () => {
    expect(getAgentPresence(null, { runningAgentIds: [] })).toBe('offline');
  });

  it('aggregates group presence by the highest-priority member state', () => {
    const secondAgent: Agent = { ...agent, id: 'agent-2', name: 'Gemini CLI' };

    expect(getGroupPresence([agent, secondAgent], {
      runningAgentIds: ['agent-1'],
      initializingAgentIds: [],
      streamingAgentNames: [],
      agentErrors: { 'agent-2': '服务不可用' },
    })).toBe('error');

    expect(getGroupPresence([agent, secondAgent], {
      runningAgentIds: ['agent-1'],
      initializingAgentIds: [],
      streamingAgentNames: ['Claude Code'],
      agentErrors: {},
    })).toBe('busy');

    expect(getGroupPresence([agent, secondAgent], {
      runningAgentIds: ['agent-1'],
      initializingAgentIds: [],
      streamingAgentNames: [],
      agentErrors: {},
    })).toBe('online');

    expect(getGroupPresence([agent, secondAgent], {
      runningAgentIds: [],
      initializingAgentIds: [],
      streamingAgentNames: [],
      agentErrors: {},
    })).toBe('offline');
  });
});
