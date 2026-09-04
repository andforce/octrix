import { createContext, useContext, useReducer, type Dispatch } from 'react';
import type {
  Agent,
  AgentGroup,
  AppState,
  CollaborationIssue,
  ConversationEntry,
  Envelope,
  Role,
  TaskSession,
  WorkItem,
} from '../types';
import type { AgentPlatform } from '../agent-platforms';

interface StoreState {
  agents: Agent[];
  groups: AgentGroup[];
  roles: Role[];
  taskSessions: TaskSession[];
  workItems: WorkItem[];
  issues: CollaborationIssue[];
  messages: Envelope[];
  runningAgentIdsByGroup: Record<string, string[]>;
  busyAgentIdsByGroup: Record<string, string[]>;
  initializingByGroup: Record<string, string[]>;
  streamingByGroup: Record<string, string[]>;
  agentErrorsByGroup: Record<string, Record<string, string>>;
  port: number;
  isRunning: boolean;
  platformInstallState: Partial<Record<AgentPlatform, boolean>>;
  selectedGroupId: string | null;
  selectedTaskSessionIdByGroup: Record<string, string>;
  terminalAgentId: string | null;
  terminalGroupId: string | null;
}

export type Action =
  | { type: 'SET_STATE'; payload: AppState }
  | { type: 'ADD_MESSAGE'; payload: Envelope }
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; body: string; entries?: ConversationEntry[]; status?: Envelope['status'] } }
  | { type: 'SET_RUNNING_AGENTS'; payload: { runningAgentIdsByGroup: Record<string, string[]>; busyAgentIdsByGroup?: Record<string, string[]>; agentErrorsByGroup?: Record<string, Record<string, string>> } }
  | { type: 'MARK_AGENT_INITIALIZING'; payload: { groupId: string; agentId: string } }
  | { type: 'CLEAR_AGENT_INITIALIZING'; payload: { groupId: string; agentId: string } }
  | { type: 'SET_AGENT_ERROR'; payload: { groupId: string; agentId: string; message: string } }
  | { type: 'CLEAR_AGENT_ERROR'; payload: { groupId: string; agentId: string } }
  | { type: 'SELECT_GROUP'; payload: string | null }
  | { type: 'SELECT_TASK_SESSION'; payload: { groupId: string; taskSessionId: string } }
  | { type: 'OPEN_TERMINAL'; payload: { agentId: string; groupId: string } }
  | { type: 'CLOSE_TERMINAL' };

function reconcileSelectedTaskSessions(
  previous: Record<string, string>,
  groups: AgentGroup[],
  taskSessions: TaskSession[],
): Record<string, string> {
  const sessionsByGroup = new Map<string, TaskSession[]>();
  for (const session of taskSessions) {
    const list = sessionsByGroup.get(session.groupId) ?? [];
    list.push(session);
    sessionsByGroup.set(session.groupId, list);
  }

  const next: Record<string, string> = {};
  for (const group of groups) {
    const sessions = sessionsByGroup.get(group.id) ?? [];
    const existing = previous[group.id];
    if (existing && sessions.some(session => session.id === existing)) {
      next[group.id] = existing;
      continue;
    }
    if (group.activeTaskSessionId && sessions.some(session => session.id === group.activeTaskSessionId)) {
      next[group.id] = group.activeTaskSessionId;
      continue;
    }
    if (sessions[0]) next[group.id] = sessions[0].id;
  }
  return next;
}

function sanitizeErrorsByGroup(
  errors: Record<string, Record<string, string>> | undefined,
  runningByGroup: Record<string, string[]>,
): Record<string, Record<string, string>> {
  if (!errors) return {};
  const result: Record<string, Record<string, string>> = {};
  for (const [groupId, groupErrors] of Object.entries(errors)) {
    const running = new Set(runningByGroup[groupId] ?? []);
    const filtered = Object.fromEntries(
      Object.entries(groupErrors).filter(([agentId, message]) => !running.has(agentId) && !!message),
    );
    if (Object.keys(filtered).length > 0) result[groupId] = filtered;
  }
  return result;
}

function addStreamingToGroup(
  byGroup: Record<string, string[]>,
  groupId: string | undefined,
  sender: string | undefined,
): Record<string, string[]> {
  if (!sender || sender === 'user' || sender === 'system' || !groupId) return byGroup;
  const list = byGroup[groupId] ?? [];
  if (list.includes(sender)) return byGroup;
  return { ...byGroup, [groupId]: [...list, sender] };
}

function removeStreamingFromGroup(
  byGroup: Record<string, string[]>,
  groupId: string | undefined,
  sender: string | undefined,
): Record<string, string[]> {
  if (!sender || !groupId) return byGroup;
  const list = byGroup[groupId];
  if (!list) return byGroup;
  const filtered = list.filter(name => name !== sender);
  if (filtered.length === list.length) return byGroup;
  if (filtered.length === 0) {
    const { [groupId]: _, ...rest } = byGroup;
    return rest;
  }
  return { ...byGroup, [groupId]: filtered };
}

function filterStreamingByRunning(
  streamingByGroup: Record<string, string[]>,
  agents: Agent[],
  runningByGroup: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [groupId, names] of Object.entries(streamingByGroup)) {
    const runningIds = runningByGroup[groupId] ?? [];
    const runningNames = new Set(
      agents.filter(a => runningIds.includes(a.id)).map(a => a.name),
    );
    const filtered = names.filter(name => runningNames.has(name));
    if (filtered.length > 0) result[groupId] = filtered;
  }
  return result;
}

function removeInitializing(
  byGroup: Record<string, string[]>,
  groupId: string,
  agentId: string,
): Record<string, string[]> {
  const list = byGroup[groupId];
  if (!list) return byGroup;
  const filtered = list.filter(id => id !== agentId);
  if (filtered.length === list.length) return byGroup;
  if (filtered.length === 0) {
    const { [groupId]: _, ...rest } = byGroup;
    return rest;
  }
  return { ...byGroup, [groupId]: filtered };
}

function clearInitializingForStopped(
  initByGroup: Record<string, string[]>,
  runningByGroup: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [groupId, ids] of Object.entries(initByGroup)) {
    const running = runningByGroup[groupId] ?? [];
    const kept = ids.filter(id => running.includes(id));
    if (kept.length > 0) result[groupId] = kept;
  }
  return result;
}

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case 'SET_STATE':
      return {
        ...state,
        agents: action.payload.agents,
        groups: action.payload.groups,
        roles: action.payload.roles,
        taskSessions: action.payload.taskSessions,
        workItems: action.payload.workItems ?? [],
        issues: action.payload.issues ?? [],
        messages: action.payload.messages,
        runningAgentIdsByGroup: action.payload.runningAgentIdsByGroup,
        busyAgentIdsByGroup: action.payload.busyAgentIdsByGroup ?? {},
        initializingByGroup: {},
        streamingByGroup: filterStreamingByRunning(
          state.streamingByGroup,
          action.payload.agents,
          action.payload.runningAgentIdsByGroup,
        ),
        agentErrorsByGroup: sanitizeErrorsByGroup(
          action.payload.agentErrorsByGroup,
          action.payload.runningAgentIdsByGroup,
        ),
        port: action.payload.port,
        isRunning: action.payload.isRunning,
        platformInstallState: action.payload.platformInstallState ?? {},
        selectedTaskSessionIdByGroup: reconcileSelectedTaskSessions(
          state.selectedTaskSessionIdByGroup,
          action.payload.groups,
          action.payload.taskSessions,
        ),
      };
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.payload],
        streamingByGroup: action.payload.status === 'streaming'
          ? addStreamingToGroup(state.streamingByGroup, action.payload.groupId, action.payload.from)
          : state.streamingByGroup,
      };
    case 'UPDATE_MESSAGE': {
      const existingMessage = state.messages.find(m => m.id === action.payload.id);
      const sender = existingMessage?.from;
      const msgGroupId = existingMessage?.groupId;
      const newStatus = action.payload.status;
      let nextStreaming = state.streamingByGroup;
      let nextInit = state.initializingByGroup;
      if (newStatus === 'complete') {
        nextStreaming = removeStreamingFromGroup(nextStreaming, msgGroupId, sender);
        if (msgGroupId && sender) {
          const agent = state.agents.find(a => a.name === sender);
          if (agent && nextInit[msgGroupId]?.includes(agent.id)) {
            nextInit = removeInitializing(nextInit, msgGroupId, agent.id);
          }
        }
      } else if (newStatus === 'streaming') {
        nextStreaming = addStreamingToGroup(nextStreaming, msgGroupId, sender);
      }
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.payload.id
            ? {
              ...m,
              body: action.payload.body,
              entries: action.payload.entries ?? m.entries,
              status: action.payload.status ?? m.status,
            }
            : m,
        ),
        initializingByGroup: nextInit,
        streamingByGroup: nextStreaming,
      };
    }
    case 'SET_RUNNING_AGENTS': {
      const nextInit = clearInitializingForStopped(
        state.initializingByGroup,
        action.payload.runningAgentIdsByGroup,
      );
      return {
        ...state,
        runningAgentIdsByGroup: action.payload.runningAgentIdsByGroup,
        busyAgentIdsByGroup: action.payload.busyAgentIdsByGroup ?? {},
        initializingByGroup: nextInit,
        streamingByGroup: filterStreamingByRunning(
          state.streamingByGroup,
          state.agents,
          action.payload.runningAgentIdsByGroup,
        ),
        agentErrorsByGroup: sanitizeErrorsByGroup(
          action.payload.agentErrorsByGroup ?? state.agentErrorsByGroup,
          action.payload.runningAgentIdsByGroup,
        ),
      };
    }
    case 'MARK_AGENT_INITIALIZING': {
      const { groupId, agentId } = action.payload;
      const list = state.initializingByGroup[groupId] ?? [];
      const newErrorsByGroup = { ...state.agentErrorsByGroup };
      if (newErrorsByGroup[groupId]) {
        const { [agentId]: _, ...rest } = newErrorsByGroup[groupId];
        if (Object.keys(rest).length > 0) {
          newErrorsByGroup[groupId] = rest;
        } else {
          delete newErrorsByGroup[groupId];
        }
      }
      return {
        ...state,
        initializingByGroup: list.includes(agentId)
          ? state.initializingByGroup
          : { ...state.initializingByGroup, [groupId]: [...list, agentId] },
        agentErrorsByGroup: newErrorsByGroup,
      };
    }
    case 'CLEAR_AGENT_INITIALIZING':
      return {
        ...state,
        initializingByGroup: removeInitializing(
          state.initializingByGroup,
          action.payload.groupId,
          action.payload.agentId,
        ),
      };
    case 'SET_AGENT_ERROR': {
      const { groupId, agentId, message } = action.payload;
      return {
        ...state,
        initializingByGroup: removeInitializing(state.initializingByGroup, groupId, agentId),
        agentErrorsByGroup: {
          ...state.agentErrorsByGroup,
          [groupId]: { ...(state.agentErrorsByGroup[groupId] ?? {}), [agentId]: message },
        },
      };
    }
    case 'CLEAR_AGENT_ERROR': {
      const { groupId, agentId } = action.payload;
      const groupErrors = state.agentErrorsByGroup[groupId];
      if (!groupErrors) return state;
      const { [agentId]: _, ...rest } = groupErrors;
      const newErrors = { ...state.agentErrorsByGroup };
      if (Object.keys(rest).length > 0) {
        newErrors[groupId] = rest;
      } else {
        delete newErrors[groupId];
      }
      return { ...state, agentErrorsByGroup: newErrors };
    }
    case 'SELECT_GROUP':
      return { ...state, selectedGroupId: action.payload };
    case 'SELECT_TASK_SESSION':
      return {
        ...state,
        selectedTaskSessionIdByGroup: {
          ...state.selectedTaskSessionIdByGroup,
          [action.payload.groupId]: action.payload.taskSessionId,
        },
      };
    case 'OPEN_TERMINAL':
      return { ...state, terminalAgentId: action.payload.agentId, terminalGroupId: action.payload.groupId };
    case 'CLOSE_TERMINAL':
      return { ...state, terminalAgentId: null, terminalGroupId: null };
    default:
      return state;
  }
}

const initialState: StoreState = {
  agents: [], groups: [], roles: [], taskSessions: [], workItems: [], issues: [], messages: [],
  runningAgentIdsByGroup: {}, busyAgentIdsByGroup: {}, initializingByGroup: {}, streamingByGroup: {}, agentErrorsByGroup: {},
  port: 39800, isRunning: false,
  platformInstallState: {},
  selectedGroupId: null, selectedTaskSessionIdByGroup: {}, terminalAgentId: null, terminalGroupId: null,
};

export const StoreContext = createContext<StoreState>(initialState);
export const DispatchContext = createContext<Dispatch<Action>>(() => {});

export function useAppStore() { return useContext(StoreContext); }
export function useAppDispatch() { return useContext(DispatchContext); }
export function useStoreReducer() { return useReducer(reducer, initialState); }
