import type {
  Agent,
  AgentStartupPrompt,
  AgentStartupPromptAction,
  AgentGroup,
  GroupMember,
  AppState,
  FileEntry,
  GitChangeKind,
  GitChangeSection,
  GitDiffView,
  GitWorkspaceStatus,
  CliCommandItem,
  SkillListItem,
  TaskSession,
  WorkItem,
  CollaborationIssue,
  GeneratedMissionDraft,
  MissionQualityPolicy,
  MissionTemplate,
  MissingRoleResolution,
  OctrixCliStatus,
  RelayConfig,
  RelayStatus,
} from '../types';
import type { AgentPlatform } from '../agent-platforms';

const BASE = '';

type LegacyWorkspaceTrustPrompt = Omit<AgentStartupPrompt, 'kind'>;

function normalizeWorkspaceTrustPrompts(
  prompts: LegacyWorkspaceTrustPrompt[],
): AgentStartupPrompt[] {
  return prompts.map(prompt => ({ ...prompt, kind: 'workspace-trust' }));
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? text;
        } catch {
          message = text;
        }
      }
    } else if (typeof res.json === 'function') {
      try {
        const parsed = await res.json() as { error?: string; message?: string };
        message = parsed.error ?? parsed.message ?? message;
      } catch {
        // Fall back to the HTTP status text when the response body cannot be parsed.
      }
    }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  rollbackGitPaths: (groupId: string, paths: string[]) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/git/rollback-paths`, { paths }),
  rollbackAllGitChanges: (groupId: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/git/rollback-all`),
  getState: () => request<AppState>('GET', '/api/state'),

  getRelayConfig: () => request<RelayConfig>('GET', '/api/relay/config'),

  getRelayStatus: () => request<RelayStatus>('GET', '/api/relay/status'),

  startRelayAuthorization: (mode: 'browser' | 'device_code') =>
    request<{ authorizationState: 'pending'; verificationUri: string; userCode?: string; expiresAt: string }>(
      'POST', '/api/relay/auth/start', { mode },
    ),

  logoutRelay: () => request<{ ok: boolean; status: RelayStatus }>('POST', '/api/relay/logout'),

  getOctrixCliStatus: () => request<OctrixCliStatus>('GET', '/api/relay/cli/status'),

  installOctrixCli: () => request<{ ok: boolean } & OctrixCliStatus>('POST', '/api/relay/cli/install'),

  pickDirectory: () => request<{ path?: string; canceled?: boolean; message?: string }>('POST', '/api/system/pick-directory'),

  addAgent: (platform: AgentPlatform, avatarColor: string, displayName?: string) =>
    request<Agent>('POST', '/api/agents', { platform, avatarColor, displayName }),

  updateAgent: (id: string, data: Partial<Agent>) =>
    request<Agent>('PUT', `/api/agents/${id}`, data),

  removeAgent: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/agents/${id}`),

  createGroup: (data: {
    name: string;
    ownerName: string;
    members: { agentId: string; roleId: string | null }[];
    workingDirectory?: string;
    groupType?: string;
    roleLeaders?: Record<string, string>;
  }) => request<AgentGroup>('POST', '/api/groups', data),

  removeGroup: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/groups/${id}`),

  getAgentStartupPrompts: (groupId?: string) =>
    request<{ ok: boolean; prompts: AgentStartupPrompt[] }>(
      'GET',
      groupId
        ? `/api/groups/${groupId}/agent-startup-prompts`
        : '/api/agent-startup-prompts',
    ),

  getWorkspaceTrustPrompts: async (groupId: string) => {
    const response = await request<{ ok: boolean; prompts: LegacyWorkspaceTrustPrompt[] }>(
      'GET',
      `/api/groups/${groupId}/workspace-trust`,
    );
    return { ...response, prompts: normalizeWorkspaceTrustPrompts(response.prompts) };
  },

  resolveAgentStartupPrompts: (
    groupId: string,
    action: AgentStartupPromptAction,
    agentIds?: string[],
  ) => request<{ ok: boolean; resolved: number; prompts: AgentStartupPrompt[] }>(
    'POST',
    `/api/groups/${groupId}/agent-startup-prompts/resolve`,
    { action, agentIds },
  ),

  confirmWorkspaceTrust: async (groupId: string, agentIds?: string[]) => {
    const response = await request<{
      ok: boolean;
      confirmed: number;
      prompts: LegacyWorkspaceTrustPrompt[];
    }>(
      'POST',
      `/api/groups/${groupId}/workspace-trust/confirm`,
      { agentIds },
    );
    return {
      ok: response.ok,
      resolved: response.confirmed,
      prompts: normalizeWorkspaceTrustPrompts(response.prompts),
    };
  },

  archiveGroup: (id: string) =>
    request<{ ok: boolean; group: AgentGroup }>('POST', `/api/groups/${id}/archive`),

  unarchiveGroup: (id: string) =>
    request<{ ok: boolean; group: AgentGroup }>('POST', `/api/groups/${id}/unarchive`),

  listTaskSessions: (groupId: string) =>
    request<{ ok: boolean; tasks: TaskSession[]; activeTaskSessionId: string | null }>('GET', `/api/groups/${groupId}/tasks`),

  createTaskSession: (groupId: string, title: string) =>
    request<{ ok: boolean; taskSession: TaskSession; activeTaskSessionId: string | null }>('POST', `/api/groups/${groupId}/tasks`, { title }),

  listMissions: (groupId: string) =>
    request<{ ok: boolean; missions: TaskSession[]; activeMissionId: string | null }>(
      'GET',
      `/api/groups/${groupId}/missions`,
    ),

  getMission: (groupId: string, missionId: string) =>
    request<{
      ok: boolean;
      mission: TaskSession;
      workItems: WorkItem[];
      issues: CollaborationIssue[];
    }>('GET', `/api/groups/${groupId}/missions/${missionId}`),

  createMission: (groupId: string, data: {
    title: string;
    objective: string;
    template: MissionTemplate;
    acceptanceCriteria: string[];
    initialOwnerMemberId?: string;
    qualityPolicy?: MissionQualityPolicy;
  }) => request<{ ok: boolean; mission: TaskSession }>(
    'POST',
    `/api/groups/${groupId}/missions`,
    data,
  ),

  previewMission: (groupId: string, goal: string) => request<{
    ok: boolean;
    draft: GeneratedMissionDraft;
  }>('POST', `/api/groups/${groupId}/missions/preview`, { goal }),

  updateMissionCharter: (groupId: string, missionId: string, data: {
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    qualityPolicy: MissionQualityPolicy;
  }) => request<{ ok: boolean; mission: TaskSession }>(
    'PUT',
    `/api/groups/${groupId}/missions/${missionId}/charter`,
    data,
  ),

  resolveMissingRole: (
    groupId: string,
    missionId: string,
    roleId: string,
    resolution: MissingRoleResolution,
    note: string,
  ) => request<{ ok: boolean; mission: TaskSession }>(
    'POST',
    `/api/groups/${groupId}/missions/${missionId}/missing-roles/${roleId}`,
    { resolution, note },
  ),

  startMission: (groupId: string, missionId: string) =>
    request<{ ok: boolean; mission: TaskSession; workItem?: WorkItem; collaborationWorkItems: WorkItem[] }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/start`,
    ),

  updateMissionPlan: (
    groupId: string,
    missionId: string,
    roleIds: string[],
    autoMergeAuthorized: boolean,
  ) => request<{ ok: boolean; mission: TaskSession }>(
    'PUT',
    `/api/groups/${groupId}/missions/${missionId}/plan`,
    { roleIds, autoMergeAuthorized },
  ),

  pauseMission: (groupId: string, missionId: string, note: string) =>
    request<{ ok: boolean; mission: TaskSession }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/pause`,
      { note },
    ),

  requestMissionChanges: (groupId: string, missionId: string, note: string) =>
    request<{ ok: boolean; mission: TaskSession; workItem: WorkItem }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/request-changes`,
      { note },
    ),

  acceptMissionRisk: (groupId: string, missionId: string, issueIds: string[], note: string) =>
    request<{ ok: boolean; mission: TaskSession; workItem?: WorkItem }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/accept-risk`,
      { issueIds, note },
    ),

  extendMissionRework: (
    groupId: string,
    missionId: string,
    additionalRounds: number,
    note: string,
  ) => request<{ ok: boolean; mission: TaskSession; workItem: WorkItem }>(
    'POST',
    `/api/groups/${groupId}/missions/${missionId}/extend-rework`,
    { additionalRounds, note },
  ),

  reassignMissionWorkItem: (
    groupId: string,
    missionId: string,
    workItemId: string,
    targetMemberId: string,
    note: string,
  ) => request<{ ok: boolean; mission: TaskSession; workItem: WorkItem }>(
    'POST',
    `/api/groups/${groupId}/missions/${missionId}/work-items/${workItemId}/reassign`,
    { targetMemberId, note },
  ),

  resolveMissionExternalChanges: (
    groupId: string,
    missionId: string,
    decision: 'incorporate' | 'discard',
    note: string,
  ) => request<{ ok: boolean; mission: TaskSession; workItem?: WorkItem }>(
    'POST',
    `/api/groups/${groupId}/missions/${missionId}/external-changes`,
    { decision, note },
  ),

  importMissionExternalImplementation: (
    groupId: string,
    missionId: string,
    note: string,
  ) => request<{ ok: boolean; mission: TaskSession; workItem?: WorkItem }>(
    'POST',
    `/api/groups/${groupId}/missions/${missionId}/external-implementation`,
    { note },
  ),

  resumeMission: (groupId: string, missionId: string, note: string) =>
    request<{ ok: boolean; mission: TaskSession }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/resume`,
      { note },
    ),

  cancelMission: (groupId: string, missionId: string, note: string) =>
    request<{ ok: boolean; mission: TaskSession }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/cancel`,
      { note },
    ),

  completeMission: (groupId: string, missionId: string, note: string) =>
    request<{ ok: boolean; mission: TaskSession }>(
      'POST',
      `/api/groups/${groupId}/missions/${missionId}/complete`,
      { note },
    ),

  setMissionRoleLeader: (groupId: string, missionId: string, roleId: string, memberId: string) =>
    request<{ ok: boolean; mission: TaskSession }>(
      'PUT',
      `/api/groups/${groupId}/missions/${missionId}/leaders/${roleId}`,
      { memberId },
    ),

  addMember: (groupId: string, agentId: string, roleId: string | null, makeLeader = false) =>
    request<GroupMember>('POST', `/api/groups/${groupId}/members`, { agentId, roleId, makeLeader }),

  removeMember: (groupId: string, memberId: string) =>
    request<{ ok: boolean }>('DELETE', `/api/groups/${groupId}/members/${memberId}`),

  setGroupRoleLeader: (groupId: string, roleId: string, memberId: string) =>
    request<{ ok: boolean; group: AgentGroup }>(
      'PUT',
      `/api/groups/${groupId}/role-leaders/${roleId}`,
      { memberId },
    ),

  goOnline: (groupId: string, memberId: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/members/${memberId}/online`),

  goOffline: (groupId: string, memberId: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/members/${memberId}/offline`),

  openTerminal: (groupId: string, memberId: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/members/${memberId}/terminal`),

  sendMessage: (body: string, groupId: string, taskSessionId: string | undefined, to: string, agentIds: string[]) =>
    request<{ ok: boolean }>('POST', '/api/messages', { body, groupId, taskSessionId, to, agentIds }),

  listGroupFiles: (groupId: string, subpath?: string) => {
    const qs = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
    return request<{ path: string; files: FileEntry[] }>('GET', `/api/groups/${groupId}/files${qs}`);
  },

  writeFile: (groupId: string, path: string, content: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/files/write`, { path, content }),

  importWorkspaceFiles: async (
    groupId: string,
    items: Array<{ relativePath: string; file: File }>,
    targetSubpath?: string,
  ) => {
    const form = new FormData();
    const safeTargetSubpath = targetSubpath?.replace(/\\/g, '/').replace(/^[/]+/, '').trim();
    if (safeTargetSubpath) {
      form.append('targetSubpath', safeTargetSubpath);
    }
    for (const { relativePath, file } of items) {
      const safe = relativePath.replace(/\\/g, '/').replace(/^[/]+/, '');
      if (!safe) continue;
      form.append('files', file, safe);
    }
    const res = await fetch(`${BASE}/api/groups/${groupId}/files/import`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const text = await res.text();
        if (text) {
          try {
            const parsed = JSON.parse(text) as { error?: string; message?: string };
            message = parsed.error ?? parsed.message ?? text;
          } catch {
            message = text;
          }
        }
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    return res.json() as Promise<{ ok: boolean; imported: number }>;
  },

  importWorkspaceFromPaths: (groupId: string, paths: string[], targetSubpath?: string) =>
    request<{ ok: boolean; imported: number }>(
      'POST',
      `/api/groups/${groupId}/files/import-from-paths`,
      { paths, targetSubpath },
    ),

  getGitStatus: (groupId: string) =>
    request<GitWorkspaceStatus>('GET', `/api/groups/${groupId}/git/status`),

  getGitDiff: (groupId: string, path: string, section: GitChangeSection, kind: GitChangeKind) =>
    request<GitDiffView>(
      'GET',
      `/api/groups/${groupId}/git/diff?path=${encodeURIComponent(path)}&section=${section}&kind=${kind}`,
    ),

  stageGitPath: (groupId: string, path: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/git/stage`, { path }),

  unstageGitPath: (groupId: string, path: string) =>
    request<{ ok: boolean }>('POST', `/api/groups/${groupId}/git/unstage`, { path }),

  openFile: (filePath: string) =>
    request<{ ok: boolean }>('POST', '/api/system/open-file', { filePath }),

  revealInFinder: (filePath: string) =>
    request<{ ok: boolean }>('POST', '/api/system/reveal-in-finder', { filePath }),

  listSkills: (refresh?: boolean) => {
    const qs = refresh ? '?refresh=1' : '';
    return request<{ ok: boolean; skills: SkillListItem[]; error?: string }>('GET', `/api/skills${qs}`);
  },

  listCliCommands: (platform: AgentPlatform) =>
    request<{ ok: boolean; commands: CliCommandItem[]; error?: string }>(
      'GET',
      `/api/cli-commands?platform=${encodeURIComponent(platform)}`,
    ),
};
