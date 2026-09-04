import type { Agent, AgentPresenceState } from '../types';

type AgentSummary = Pick<Agent, 'id' | 'name'>;

export interface AgentPresenceContext {
  runningAgentIds: string[];
  initializingAgentIds?: string[];
  busyAgentIds?: string[];
  streamingAgentNames?: string[];
  agentErrors?: Record<string, string>;
}

const PRESENCE_META: Record<AgentPresenceState, { label: string; dotClass: string; badgeClass: string }> = {
  offline: {
    label: '离线',
    dotClass: 'bg-content-subtle',
    badgeClass: 'bg-content-subtle text-surface shadow-sm',
  },
  online: {
    label: '在线',
    dotClass: 'bg-mint shadow-[0_0_8px_rgba(79,209,197,0.6)]',
    badgeClass: 'bg-mint text-surface shadow-md',
  },
  busy: {
    label: '忙碌中',
    dotClass: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)]',
    badgeClass: 'bg-amber-400 text-surface shadow-md',
  },
  error: {
    label: '异常',
    dotClass: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.55)]',
    badgeClass: 'bg-red-500 text-white shadow-md',
  },
};

export function getPresenceIndicatorClasses(state: AgentPresenceState, kind: 'dot' | 'badge' = 'dot'): string {
  return PRESENCE_META[state][kind === 'dot' ? 'dotClass' : 'badgeClass'];
}

export function getPresenceLabel(state: AgentPresenceState): string {
  return PRESENCE_META[state].label;
}

export function getPresenceTitle(state: AgentPresenceState, detail?: string): string {
  return detail ? `${getPresenceLabel(state)}: ${detail}` : getPresenceLabel(state);
}

export function getAgentPresence(agent: AgentSummary | null | undefined, context: AgentPresenceContext): AgentPresenceState {
  if (!agent) return 'offline';

  const {
    runningAgentIds = [],
    initializingAgentIds = [],
    busyAgentIds = [],
    streamingAgentNames = [],
    agentErrors = {},
  } = context;

  if (agentErrors[agent.id]) return 'error';
  if (initializingAgentIds.includes(agent.id)) return 'busy';
  if (busyAgentIds.includes(agent.id)) return 'busy';
  if (streamingAgentNames.includes(agent.name)) return 'busy';
  if (runningAgentIds.includes(agent.id)) return 'online';
  return 'offline';
}

export function getAgentError(agentId: string | undefined, context: AgentPresenceContext): string | undefined {
  if (!agentId) return undefined;
  return context.agentErrors?.[agentId];
}

export function getGroupPresence(agents: AgentSummary[], context: AgentPresenceContext): AgentPresenceState {
  let hasOnline = false;

  for (const agent of agents) {
    const state = getAgentPresence(agent, context);
    if (state === 'error') return 'error';
    if (state === 'busy') return 'busy';
    if (state === 'online') hasOnline = true;
  }

  return hasOnline ? 'online' : 'offline';
}
