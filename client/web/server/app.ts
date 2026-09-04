import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';
import type { Hub } from './hub.js';
import {
  ENABLED_AGENT_PLATFORMS,
  isEnabledAgentPlatform,
  isSupportedAgentPlatform,
} from '../src/agent-platforms.js';
import { detectPlatformInstallState } from './agent-installation.js';
import {
  captureImplementationRevision,
  ensureMissionGitRepository,
  getGitDiffForPath,
  getGitWorkspaceStatus,
  nextImplementationRevisionNumber,
  prepareMissionGitBranch,
  stageGitPath,
  unstageGitPath,
  rollbackAllGitChanges,
} from './git.js';
import { listCliCommands, normalizeCliInputForPlatform } from './cli-commands.js';
import {
  createAgent, createAgentGroup, createGroupMember, groupMemberIds, roleById,
} from './models.js';
import type {
  GroupMember,
  GroupType,
  IssueSeverity,
  MissionQualityPolicy,
  MissionTemplate,
  MissingRoleResolution,
} from './models.js';
import type { ProcessManager } from './process-manager.js';
import type { AgentStartupPromptAction, ModelPickerInputAction, ModelPickerMode } from './process-manager.js';
import type { RelayClient } from './relay-client.js';
import type { Store } from './store.js';
import { WORKSPACE_DATA_VERSION } from './store.js';
import { decodeMultipartFilename } from './multipart-filename.js';
import { getCachedSkills } from './skills.js';
import { generateMissionDraft } from './mission-draft.js';
import { getOctrixCliStatus, installOctrixCli } from './octrix-cli.js';

interface AppDependencies {
  store: Store;
  hub: Hub;
  pm: ProcessManager;
  port: number;
  relay?: RelayClient;
  octrixCliHome?: string;
  protectedFolderHome?: string;
}

const execFileAsync = promisify(execFile);
const ISSUE_SEVERITIES = new Set<IssueSeverity>(['blocker', 'major', 'minor', 'suggestion']);

function parseMissionQualityPolicy(value: unknown): MissionQualityPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('qualityPolicy must be an object');
  }
  const severities = (value as { blockingSeverities?: unknown }).blockingSeverities;
  if (
    !Array.isArray(severities)
    || !severities.every(item => typeof item === 'string' && ISSUE_SEVERITIES.has(item as IssueSeverity))
  ) {
    throw new Error('qualityPolicy.blockingSeverities must be a valid severity array');
  }
  return {
    blockingSeverities: severities as IssueSeverity[],
    sharedStateTestExecution: 'serial',
  };
}
const MAX_FILE_PREVIEW_BYTES = 512 * 1024;
const MODEL_PICKER_PLATFORMS = new Set(['claude-code', 'openclaude', 'openai-codex-cli', 'github-copilot-cli']);
const MODEL_SWITCH_BUSY_ERROR = 'AI 正在工作，暂时不能切换模型，请等待当前任务完成后再试';

function rejectBusyModelSwitch(res: express.Response) {
  res.status(409).json({ error: MODEL_SWITCH_BUSY_ERROR });
}

function normalizeGroupType(value: unknown): GroupType {
  return value === 'direct' ? 'direct' : 'collaboration';
}

function resolveImportBase(root: string, targetSubpathRaw: unknown): string | null {
  if (typeof targetSubpathRaw !== 'string' || !targetSubpathRaw.trim()) {
    return root;
  }
  const targetSubpath = normalize(targetSubpathRaw).replace(/^[/\\]+/, '');
  const importBase = resolve(root, targetSubpath);
  if (importBase !== root && !importBase.startsWith(`${root}${sep}`)) {
    return null;
  }
  return importBase;
}

function resolveWorkspacePath(root: string, relativePathRaw: unknown): string | null {
  if (typeof relativePathRaw !== 'string' || !relativePathRaw.trim()) {
    return null;
  }
  const relativePath = normalize(relativePathRaw).replace(/^[/\\]+/, '');
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(`${root}${sep}`) ? target : null;
}

function directoryParentPath(directory: string): string | null {
  const parent = dirname(directory);
  return parent === directory ? null : parent;
}

function directoryStatus(error: unknown): number {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 404;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  return 500;
}

function stripLeadingCliMentions(body: string): string {
  let remaining = body.trimStart();
  let stripped = false;
  const leadingMentionPattern = /^@[^\s()]+(?:\([^)]+\)-\d+)?(?=\s|$)/u;

  while (remaining.startsWith('@')) {
    const match = remaining.match(leadingMentionPattern);
    if (!match) break;
    stripped = true;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return stripped ? remaining : body;
}

export function createApp({
  store,
  hub,
  pm,
  port,
  relay,
  octrixCliHome,
  protectedFolderHome = homedir(),
}: AppDependencies) {
  function getFullState() {
    return {
      agents: store.agents,
      groups: store.groups,
      roles: store.roles,
      taskSessions: store.taskSessions,
      workItems: store.taskCards,
      issues: store.issues,
      messages: hub.messages,
      runningAgentIdsByGroup: pm.getRunningAgentIdsByGroup(),
      busyAgentIdsByGroup: pm.getBusyAgentIdsByGroup(),
      agentErrorsByGroup: pm.getRecentAgentErrorsByGroup(),
      port: hub.port,
      isRunning: hub.isRunning,
      platformInstallState: detectPlatformInstallState(),
      enabledAgentPlatforms: [...ENABLED_AGENT_PLATFORMS],
      workspaceDataVersion: WORKSPACE_DATA_VERSION,
    };
  }

  function getMobileState() {
    return {
      agents: store.agents,
      groups: store.groups,
      roles: store.roles,
      taskSessions: store.taskSessions,
      workItems: store.taskCards,
      issues: store.issues,
      runningAgentIdsByGroup: pm.getRunningAgentIdsByGroup(),
      busyAgentIdsByGroup: pm.getBusyAgentIdsByGroup(),
      agentErrorsByGroup: pm.getRecentAgentErrorsByGroup(),
      port: hub.port,
      isRunning: hub.isRunning,
      platformInstallState: detectPlatformInstallState(),
      enabledAgentPlatforms: [...ENABLED_AGENT_PLATFORMS],
      workspaceDataVersion: WORKSPACE_DATA_VERSION,
    };
  }

  function requiresStablePty(platform: string | undefined): boolean {
    return platform === 'openai-codex-cli'
      || platform === 'github-copilot-cli'
      || platform === 'gemini-cli';
  }

  function resolveActiveTaskSessionId(
    groupId: string,
    requestedTaskSessionId: unknown,
    res: express.Response,
    options: { fallbackToActive: boolean; mismatchError: string },
  ): string | undefined {
    const activeTaskSessionId = store.activeTaskSessionForGroup(groupId)?.id;
    const taskSessionId = typeof requestedTaskSessionId === 'string' && requestedTaskSessionId
      ? requestedTaskSessionId
      : options.fallbackToActive ? activeTaskSessionId : undefined;
    if (!taskSessionId) {
      res.status(400).json({ error: 'taskSessionId required' });
      return undefined;
    }
    if (!activeTaskSessionId || taskSessionId !== activeTaskSessionId) {
      res.status(409).json({ error: options.mismatchError });
      return undefined;
    }
    return taskSessionId;
  }

  function modelPickerTarget(
    agentId: unknown,
    groupId: unknown,
    res: express.Response,
  ): { agent: NonNullable<ReturnType<Store['agentById']>>, group: NonNullable<ReturnType<Store['groupById']>> } | null {
    if (typeof agentId !== 'string' || typeof groupId !== 'string' || !agentId || !groupId) {
      res.status(400).json({ error: 'agentId and groupId required' });
      return null;
    }
    const agent = store.agentById(agentId);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return null;
    }
    const group = store.groupById(groupId);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return null;
    }
    if (group.archivedAt) {
      res.status(409).json({ error: '会话已归档，请恢复后再切换模型' });
      return null;
    }
    if (!groupMemberIds(group).includes(agent.id)) {
      res.status(400).json({ error: 'agent is not a member of the group' });
      return null;
    }
    if (!MODEL_PICKER_PLATFORMS.has(agent.platform)) {
      res.status(400).json({ error: '该 CLI 暂不支持原生模型切换' });
      return null;
    }
    if (!pm.isAgentRunning(agent.id, group.id)) {
      res.status(409).json({ error: 'AI 当前离线，请先上线' });
      return null;
    }
    return { agent, group };
  }

  function reinitializeMemberRolePrompt(
    group: NonNullable<ReturnType<Store['groupById']>>,
    member: GroupMember,
  ) {
    const filename = store.roleFileName(member);
    if (!filename) return;
    const agent = store.agentById(member.agentId);
    if (!agent) return;
    const text = roleInitPrompt(filename);
    pm.waitForPtyReady(member.agentId, {
      waitForStable: requiresStablePty(agent.platform),
      groupId: group.id,
    }).then(ready => {
      if (ready) pm.sendKeys(member.agentId, text, group.id);
    });
  }

  async function relaunchGroupAgents(
    group: NonNullable<ReturnType<Store['groupById']>>,
    requiredMemberIds?: string[],
  ): Promise<string | undefined> {
    const uniqueAgentIds = [...new Set(group.members.map(member => member.agentId))];
    const requiredMembers = new Set(requiredMemberIds ?? group.members.map(member => member.id));
    const requiredAgentIds = new Set(
      group.members.filter(member => requiredMembers.has(member.id)).map(member => member.agentId),
    );

    for (const agentId of uniqueAgentIds) {
      pm.killAgent(agentId, group.id);
    }

    for (const agentId of uniqueAgentIds) {
      const agent = store.agentById(agentId);
      if (!agent) {
        if (requiredAgentIds.has(agentId)) return `必需 AI ${agentId} 不存在`;
        continue;
      }
      const launchError = pm.launchAgent(agent, port, group.workingDirectory, group.id);
      if (launchError && requiredAgentIds.has(agentId)) return launchError;
    }

    for (const agentId of uniqueAgentIds) {
      const agent = store.agentById(agentId);
      if (!agent) continue;
      const startupError = await pm.waitForAgentStartup(agent.id, undefined, group.id);
      if (startupError && requiredAgentIds.has(agentId)) return startupError;
    }

    if (group.groupType !== 'direct') {
      store.writeTeamFiles(group);
      for (const member of group.members) {
        reinitializeMemberRolePrompt(group, member);
      }
    }
    return undefined;
  }

  const app = express();
  app.use(express.json());

  const workspaceImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024, files: 500 },
  });

  app.post('/api/system/pick-directory', async (_req, res) => {
    if (process.platform !== 'darwin') {
      res.status(501).json({ error: `directory picker is not supported on ${process.platform}` });
      return;
    }

    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'try',
        '-e',
        'set chosenFolder to choose folder',
        '-e',
        'POSIX path of chosenFolder',
        '-e',
        'on error number -128',
        '-e',
        'return ""',
        '-e',
        'end try',
      ]);
      const directory = stdout.trim();
      res.json(directory ? { path: directory } : { canceled: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/system/permissions/files', (_req, res) => {
    const folders = ['Desktop', 'Documents', 'Downloads'].map(name => {
      try {
        // 必须由长期运行的 Host 进程实际访问，macOS 才会把授权归给后台 Host，
        // 而不是执行安装脚本的 Terminal。
        readdirSync(resolve(protectedFolderHome, name));
        return { name, granted: true };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'UNKNOWN';
        return { name, granted: false, error: code };
      }
    });
    res.json({ ok: folders.every(folder => folder.granted), folders });
  });

  app.get('/api/system/directories', (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const targetPath = requestedPath ? resolve(requestedPath) : homedir();

    try {
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'path is not a directory' });
        return;
      }

      const entries = readdirSync(targetPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({
          name: entry.name,
          path: resolve(targetPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        path: targetPath,
        parentPath: directoryParentPath(targetPath),
        entries,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(directoryStatus(error)).json({ error: message });
    }
  });

  app.post('/v1/emit', (req, res) => {
    const { from, to, body, groupId, taskSessionId } = req.body;
    if (!from || !body) {
      res.status(400).json({ error: 'need json with from, body' });
      return;
    }
    const envelopes = hub.emit({ from, to, body, groupId, taskSessionId });
    res.json({ ok: true, ids: envelopes.map(e => e.id) });
  });

  app.get('/v1/inbox', (req, res) => {
    const peer = req.query.peer as string;
    if (!peer) { res.status(400).json({ error: 'peer param required' }); return; }
    const after = req.query.after ? parseFloat(req.query.after as string) : undefined;
    res.json(hub.inbox(peer, after));
  });

  app.get('/v1/peers', (_req, res) => {
    res.json(hub.allPeers());
  });

  app.get('/v1/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/state', (_req, res) => {
    res.json(getFullState());
  });

  app.get('/api/state/mobile', (_req, res) => {
    res.json(getMobileState());
  });

  app.get('/api/events', (req, res) => {
    const since = typeof req.query.since === 'string' ? Number(req.query.since) : 0;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 500;
    res.json({ ok: true, ...hub.eventsSince(since, limit) });
  });

  app.get('/api/skills', (req, res) => {
    try {
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const skills = getCachedSkills(refresh);
      res.json({ ok: true, skills });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, skills: [], error: message });
    }
  });

  app.get('/api/cli-commands', (req, res) => {
    try {
      const platform = req.query.platform;
      if (!isSupportedAgentPlatform(platform)) {
        res.status(400).json({ ok: false, commands: [], error: 'supported platform required' });
        return;
      }
      const commands = listCliCommands(platform);
      res.json({ ok: true, commands });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, commands: [], error: message });
    }
  });

  app.post('/api/agents/:agentId/model-picker/start', (req, res) => {
    const target = modelPickerTarget(req.params.agentId, req.body.groupId, res);
    if (!target) return;
    const requestedMode = req.body.mode;
    if (requestedMode !== undefined && requestedMode !== 'model' && requestedMode !== 'effort') {
      res.status(400).json({ error: 'mode must be model or effort' });
      return;
    }
    const busyAgentIds = pm.getBusyAgentIdsByGroup()[target.group.id] ?? [];
    if (busyAgentIds.includes(target.agent.id)) {
      rejectBusyModelSwitch(res);
      return;
    }
    const mode: ModelPickerMode = requestedMode === 'effort' ? 'effort' : 'model';
    const picker = pm.startModelPicker(target.agent.id, target.group.id, mode);
    if (!picker) {
      res.status(409).json({ error: 'AI 当前离线，请先上线' });
      return;
    }
    res.json({ ok: true, picker });
  });

  app.get('/api/agents/:agentId/model-picker', (req, res) => {
    const target = modelPickerTarget(req.params.agentId, req.query.groupId, res);
    if (!target) return;
    const picker = pm.getModelPicker(target.agent.id, target.group.id);
    if (!picker) {
      res.status(404).json({ error: 'model picker not started' });
      return;
    }
    res.json({ ok: true, picker });
  });

  app.post('/api/agents/:agentId/model-picker/choose', (req, res) => {
    const target = modelPickerTarget(req.params.agentId, req.body.groupId, res);
    if (!target) return;
    const optionIndex = req.body.optionIndex;
    if (!Number.isInteger(optionIndex)) {
      res.status(400).json({ error: 'optionIndex must be an integer' });
      return;
    }
    if (pm.hasPendingAgentResponse(target.agent.id, target.group.id)) {
      rejectBusyModelSwitch(res);
      return;
    }
    const picker = pm.chooseModelPickerOption(target.agent.id, target.group.id, optionIndex);
    if (!picker) {
      res.status(404).json({ error: 'model picker not started' });
      return;
    }
    res.json({ ok: true, picker });
  });

  app.post('/api/agents/:agentId/model-picker/input', (req, res) => {
    const target = modelPickerTarget(req.params.agentId, req.body.groupId, res);
    if (!target) return;
    const action = req.body.action as ModelPickerInputAction;
    if (action !== 'up' && action !== 'down' && action !== 'enter' && action !== 'escape') {
      res.status(400).json({ error: 'action must be up, down, enter, or escape' });
      return;
    }
    if (action === 'enter' && pm.hasPendingAgentResponse(target.agent.id, target.group.id)) {
      rejectBusyModelSwitch(res);
      return;
    }
    const picker = pm.sendModelPickerInput(target.agent.id, target.group.id, action);
    if (!picker) {
      res.status(404).json({ error: 'model picker not started' });
      return;
    }
    res.json({ ok: true, picker });
  });

  app.post('/api/agents', (req, res) => {
    const {
      platform, avatarColor, displayName,
    } = req.body;
    if (!isEnabledAgentPlatform(platform)) {
      res.status(400).json({ error: 'enabled platform required' });
      return;
    }
    const uniqueName = displayName ?? store.nextAgentName(platform);
    if (store.agentByName(uniqueName)) {
      res.status(409).json({ error: `agent name "${uniqueName}" already exists` });
      return;
    }
    const agent = createAgent(platform, avatarColor, uniqueName);
    store.addAgent(agent);
    res.json(agent);
  });

  app.put('/api/agents/:id', (req, res) => {
    const agent = store.agentById(req.params.id);
    if (!agent) { res.status(404).json({ error: 'not found' }); return; }
    if (
      req.body.platform !== undefined
      || req.body.name !== undefined
      || req.body.command !== undefined
    ) {
      res.status(400).json({ error: 'platform, name and command are immutable' });
      return;
    }
    const updated = {
      ...agent,
      ...(req.body.avatarColor !== undefined ? { avatarColor: req.body.avatarColor } : {}),
      id: agent.id,
    };
    store.updateAgent(updated);
    res.json(updated);
  });

  app.delete('/api/agents/:id', (req, res) => {
    store.removeAgent(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/groups', (req, res) => {
    const { name, ownerName, members, workingDirectory, groupType, roleLeaders } = req.body;
    const resolvedGroupType = normalizeGroupType(groupType);
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    if (resolvedGroupType === 'direct') {
      if (!Array.isArray(members) || members.length !== 1) {
        res.status(400).json({ error: 'direct group requires exactly one member' });
        return;
      }
      if (!workingDirectory || typeof workingDirectory !== 'string') {
        res.status(400).json({ error: 'workingDirectory required' });
        return;
      }
    } else if (!Array.isArray(members) || members.length < 2) {
      res.status(400).json({ error: '群聊至少需要两个 AI；一个 AI 请创建单聊' });
      return;
    } else if (new Set(members.map((member: { agentId?: unknown }) => member.agentId)).size !== members.length) {
      res.status(400).json({ error: '一个 AI 在同一群内只能拥有一个角色' });
      return;
    } else if (members.some((member: { roleId?: unknown }) => (
      typeof member.roleId !== 'string' || !roleById(member.roleId)
    ))) {
      res.status(400).json({ error: '群聊中的每个 AI 都必须且只能分配一个基础角色' });
      return;
    } else if (members.filter((member: { roleId?: unknown }) => member.roleId === 'role-committer').length > 1) {
      res.status(400).json({ error: '每个群最多只能有一个提交专员' });
      return;
    }
    if (resolvedGroupType !== 'direct') {
      const membersByRole = new Map<string, Array<{ agentId: string; roleId: string }>>();
      for (const member of members as Array<{ agentId: string; roleId: string }>) {
        const roleMembers = membersByRole.get(member.roleId) ?? [];
        roleMembers.push(member);
        membersByRole.set(member.roleId, roleMembers);
      }
      for (const [roleId, roleMembers] of membersByRole) {
        if (roleMembers.length < 2) continue;
        const leaderAgentId = roleLeaders?.[roleId];
        if (
          typeof leaderAgentId !== 'string'
          || !roleMembers.some(member => member.agentId === leaderAgentId)
        ) {
          const roleName = roleById(roleId)?.name ?? roleId;
          res.status(400).json({ error: `角色「${roleName}」有多名成员，请指定一个 Leader` });
          return;
        }
      }
    }
    if (resolvedGroupType === 'collaboration' && workingDirectory && typeof workingDirectory === 'string') {
      const existing = store.groupByResolvedWorkingDirectory(workingDirectory, 'collaboration');
      if (existing) {
        res.status(409).json({ error: `工作目录已被协作群「${existing.name}」使用` });
        return;
      }
    }
    const groupMembers = (members ?? []).map(
      (m: { agentId: string; roleId: string | null }) => createGroupMember(
        m.agentId,
        resolvedGroupType === 'direct' ? null : m.roleId,
      ),
    );
    const resolvedRoleLeaders: Record<string, string> = {};
    if (resolvedGroupType !== 'direct') {
      const roleIds = [...new Set(groupMembers.map(member => member.roleId).filter((id): id is string => !!id))];
      for (const roleId of roleIds) {
        const roleMembers = groupMembers.filter(member => member.roleId === roleId);
        const leaderAgentId = roleMembers.length === 1
          ? roleMembers[0].agentId
          : roleLeaders[roleId];
        const leader = roleMembers.find(member => member.agentId === leaderAgentId);
        if (leader) resolvedRoleLeaders[roleId] = leader.id;
      }
    }
    const group = createAgentGroup(
      name,
      ownerName,
      groupMembers,
      workingDirectory,
      resolvedGroupType,
      resolvedRoleLeaders,
    );
    store.addGroup(group);
    if (group.groupType !== 'direct') store.writeTeamFiles(group);

    if (group.groupType === 'direct') {
      const member = groupMembers[0];
      const agent = member ? store.agentById(member.agentId) : undefined;
      if (agent) pm.launchAgent(agent, port, workingDirectory, group.id);
    }

    res.json(group);
  });

  app.delete('/api/groups/:id', (req, res) => {
    const group = store.groupById(req.params.id);
    if (group) {
      for (const agentId of groupMemberIds(group)) {
        pm.killAgent(agentId, group.id);
      }
    }
    hub.deleteGroupMessages(req.params.id);
    store.removeGroup(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/agent-startup-prompts', (_req, res) => {
    res.json({ ok: true, prompts: pm.getAgentStartupPrompts() });
  });

  app.get('/api/groups/:id/agent-startup-prompts', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    res.json({ ok: true, prompts: pm.getAgentStartupPrompts(group.id) });
  });

  app.post('/api/groups/:id/agent-startup-prompts/resolve', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }

    const action = req.body?.action as AgentStartupPromptAction;
    if (action !== 'accept' && action !== 'decline') {
      res.status(400).json({ error: 'action must be accept or decline' });
      return;
    }

    let agentIds: string[] | undefined;
    if (req.body?.agentIds !== undefined) {
      if (
        !Array.isArray(req.body.agentIds)
        || req.body.agentIds.length === 0
        || !req.body.agentIds.every((id: unknown) => typeof id === 'string' && id)
      ) {
        res.status(400).json({ error: 'agentIds must be a non-empty string array' });
        return;
      }
      agentIds = [...new Set(req.body.agentIds as string[])];
      const memberIds = new Set(groupMemberIds(group));
      if (agentIds.some(agentId => !memberIds.has(agentId))) {
        res.status(400).json({ error: 'agent is not a member of the group' });
        return;
      }
    }

    const result = pm.resolveAgentStartupPrompts(group.id, action, agentIds);
    res.json({ ok: true, ...result });
  });

  app.get('/api/groups/:id/workspace-trust', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    res.json({ ok: true, prompts: pm.getWorkspaceTrustPrompts(group.id) });
  });

  app.post('/api/groups/:id/workspace-trust/confirm', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }

    let agentIds: string[] | undefined;
    if (req.body?.agentIds !== undefined) {
      if (
        !Array.isArray(req.body.agentIds)
        || req.body.agentIds.length === 0
        || !req.body.agentIds.every((id: unknown) => typeof id === 'string' && id)
      ) {
        res.status(400).json({ error: 'agentIds must be a non-empty string array' });
        return;
      }
      agentIds = [...new Set(req.body.agentIds as string[])];
      const memberIds = new Set(groupMemberIds(group));
      const invalidAgentId = agentIds.find(agentId => !memberIds.has(agentId));
      if (invalidAgentId) {
        res.status(400).json({ error: 'agent is not a member of the group' });
        return;
      }
    }

    const result = pm.confirmWorkspaceTrustPrompts(group.id, agentIds);
    res.json({ ok: true, ...result });
  });

  app.post('/api/groups/:id/archive', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    for (const agentId of groupMemberIds(group)) {
      pm.killAgent(agentId, group.id);
    }
    const archived = store.archiveGroup(group.id);
    res.json({ ok: true, group: archived });
  });

  app.post('/api/groups/:id/unarchive', (req, res) => {
    const group = store.unarchiveGroup(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    res.json({ ok: true, group });
  });

  app.get('/api/groups/:id/tasks', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (group.groupType === 'direct') {
      res.status(400).json({ error: '单聊不支持任务会话' });
      return;
    }
    res.status(410).json({ error: '旧任务会话接口已移除，请使用 /missions' });
  });

  app.get('/api/groups/:id/missions', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (group.groupType === 'direct') {
      res.status(400).json({ error: '单聊不支持主任务' });
      return;
    }
    res.json({
      ok: true,
      missions: store.taskSessionsForGroup(group.id),
      activeMissionId: group.activeTaskSessionId ?? null,
    });
  });

  app.get('/api/groups/:id/missions/:missionId', (req, res) => {
    const group = store.groupById(req.params.id);
    const mission = store.taskSessionById(req.params.missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    res.json({
      ok: true,
      mission,
      workItems: store.taskCards.filter(workItem => workItem.taskSessionId === mission.id),
      issues: store.issues.filter(issue => issue.missionId === mission.id),
    });
  });

  app.post('/api/groups/:id/missions/preview', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group || group.groupType === 'direct') {
      res.status(group ? 400 : 404).json({ error: group ? '单聊不支持主任务' : 'group not found' });
      return;
    }
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    if (!goal) {
      res.status(400).json({ error: 'goal required' });
      return;
    }
    try {
      res.json({ ok: true, draft: generateMissionDraft(goal, group) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/groups/:id/missions', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
    const template = req.body?.template as MissionTemplate | undefined;
    const validTemplates = new Set<MissionTemplate>([
      'feature',
      'bugfix',
      'refactor',
      'discussion',
      'review',
      'test',
      'documentation',
      'submission',
      'generic',
    ]);
    const acceptanceCriteria = Array.isArray(req.body?.acceptanceCriteria)
      ? req.body.acceptanceCriteria
      : [];
    if (!title || !objective) {
      res.status(400).json({ error: 'title and objective required' });
      return;
    }
    if (!template || !validTemplates.has(template)) {
      res.status(400).json({ error: 'invalid mission template' });
      return;
    }
    if (!acceptanceCriteria.every((item: unknown) => typeof item === 'string')) {
      res.status(400).json({ error: 'acceptanceCriteria must be a string array' });
      return;
    }

    try {
      const qualityPolicy = parseMissionQualityPolicy(req.body?.qualityPolicy);
      const mission = store.createMission(group.id, {
        title,
        objective,
        template,
        acceptanceCriteria,
        initialOwnerMemberId: typeof req.body?.initialOwnerMemberId === 'string'
          ? req.body.initialOwnerMemberId
          : undefined,
        qualityPolicy,
      });
      res.status(201).json({ ok: true, mission });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/groups/:id/missions/:missionId/charter', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
    const acceptanceCriteria = Array.isArray(req.body?.acceptanceCriteria)
      ? req.body.acceptanceCriteria
      : [];
    if (
      !title
      || !objective
      || acceptanceCriteria.length === 0
      || !acceptanceCriteria.every((item: unknown) => typeof item === 'string')
    ) {
      res.status(400).json({ error: 'title, objective and acceptanceCriteria required' });
      return;
    }
    try {
      const mission = store.updateMissionCharter(req.params.id, req.params.missionId, {
        title,
        objective,
        acceptanceCriteria,
        qualityPolicy: parseMissionQualityPolicy(req.body?.qualityPolicy),
      });
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/start', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    const mission = store.taskSessionById(req.params.missionId);
    if (!mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    const missing = (mission.phases ?? []).filter(phase => phase.required && phase.status === 'missing');
    if (missing.length > 0) {
      res.status(409).json({
        error: `缺岗决策未完成：${missing.map(phase => phase.name).join('、')}`,
        missingRoleIds: missing.map(phase => phase.roleId),
      });
      return;
    }
    try {
      store.beginMissionPreparation(group.id, mission.id);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const abortPreparation = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      store.abortMissionPreparation(group.id, mission.id, message);
      return message;
    };
    if (group.workingDirectory) {
      const competingWorkspace = store.activeMissionForWorkspace(
        group.workingDirectory,
        mission.id,
      );
      if (competingWorkspace) {
        const error = `同一工作目录已有活跃协作任务「${competingWorkspace.title}」`;
        abortPreparation(error);
        res.status(409).json({
          error,
          conflictingMissionId: competingWorkspace.id,
        });
        return;
      }
    }

    let missionRepositoryRoot = mission.gitBaseline?.repositoryRoot;
    const gitTemplates = ['feature', 'bugfix', 'refactor', 'documentation', 'review', 'test', 'submission', 'generic'];
    const requiresGit = ['feature', 'bugfix', 'refactor', 'review', 'test', 'submission', 'generic']
      .includes(mission.template ?? '');
    if (requiresGit && !group.workingDirectory) {
      const error = '代码实现、审查、测试、提交与 PR 任务必须使用 Git 工作目录';
      abortPreparation(error);
      res.status(409).json({ error });
      return;
    }
    if (group.workingDirectory && gitTemplates.includes(mission.template ?? '')) {
      try {
        if (!missionRepositoryRoot) {
          const gitStatus = await getGitWorkspaceStatus(group.workingDirectory);
          missionRepositoryRoot = gitStatus.repositoryRoot ?? undefined;
        }
        if (requiresGit && !missionRepositoryRoot) {
          missionRepositoryRoot = await ensureMissionGitRepository(group.workingDirectory);
        }
        if (missionRepositoryRoot) {
          const competingMission = store.activeMissionForRepository(
            missionRepositoryRoot,
            mission.id,
          );
          if (competingMission) {
            abortPreparation(`同一 Git 仓库已有活跃协作任务「${competingMission.title}」`);
            res.status(409).json({
              error: `同一 Git 仓库已有活跃协作任务「${competingMission.title}」`,
              conflictingMissionId: competingMission.id,
            });
            return;
          }
        }
        if (missionRepositoryRoot && !mission.gitBaseline) {
          const baseline = await prepareMissionGitBranch(
            group.workingDirectory,
            mission.id,
            mission.title,
          );
          store.setMissionGitBaseline(group.id, mission.id, baseline);
          missionRepositoryRoot = baseline.repositoryRoot;
        }
        if (
          mission.gitBaseline
          && ['review', 'test'].includes(mission.template ?? '')
          && !mission.currentImplementationRevisionId
        ) {
          store.recordBaselineImplementationRevision(group.id, mission.id);
        }
      } catch (error) {
        res.status(409).json({ error: abortPreparation(error) });
        return;
      }
    }

    if (missionRepositoryRoot) {
      const directGroupsToPause: string[] = [];
      for (const candidate of store.groups) {
        if (
          candidate.groupType !== 'direct'
          || !candidate.workingDirectory
          || candidate.archivedAt
          || candidate.pausedByMissionId === mission.id
        ) {
          continue;
        }
        try {
          const candidateStatus = await getGitWorkspaceStatus(candidate.workingDirectory);
          if (candidateStatus.repositoryRoot !== missionRepositoryRoot) continue;
          directGroupsToPause.push(candidate.id);
          for (const agentId of groupMemberIds(candidate)) pm.killAgent(agentId, candidate.id);
        } catch {
          // A broken direct-chat workspace cannot block the collaboration mission.
        }
      }
      store.pauseGroupsForMission(directGroupsToPause, mission.id);
    }

    const relaunchError = await relaunchGroupAgents(group, mission.requiredMemberIds);
    if (relaunchError) {
      abortPreparation(relaunchError);
      res.status(500).json({ error: relaunchError });
      return;
    }

    try {
      const result = store.startMission(group.id, mission.id, true);
      for (const offeredWorkItem of [
        ...(result.workItem ? [result.workItem] : []),
        ...result.collaborationWorkItems,
      ]) {
        if (offeredWorkItem.status !== 'offered') continue;
        const ownerMember = group.members.find(member => member.id === offeredWorkItem.ownerMemberId);
        if (!ownerMember) continue;
        const inboxPath = `.ai-team/tasks/${mission.id}/work-items/${offeredWorkItem.id}/inbox/offer-001.md`;
        pm.sendKeys(
          ownerMember.agentId,
          `[新工作项]\n请读取 ${inboxPath} 并使用 octrix-action 控制块回执。`,
          group.id,
          mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: abortPreparation(error) });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/missing-roles/:roleId', (req, res) => {
    const resolution = typeof req.body?.resolution === 'string'
      ? req.body.resolution as MissingRoleResolution
      : undefined;
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    if (!resolution) {
      res.status(400).json({ error: 'resolution required' });
      return;
    }
    try {
      const mission = store.resolveMissingRole(
        req.params.id,
        req.params.missionId,
        req.params.roleId,
        resolution,
        note,
      );
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.put('/api/groups/:id/missions/:missionId/leaders/:roleId', (req, res) => {
    const memberId = typeof req.body?.memberId === 'string' ? req.body.memberId : '';
    try {
      const mission = store.setMissionRoleLeader(
        req.params.id,
        req.params.missionId,
        req.params.roleId,
        memberId,
      );
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.put('/api/groups/:id/missions/:missionId/plan', (req, res) => {
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : undefined;
    if (!roleIds || !roleIds.every((roleId: unknown) => typeof roleId === 'string')) {
      res.status(400).json({ error: 'roleIds must be a string array' });
      return;
    }
    if (
      req.body?.autoMergeAuthorized !== undefined
      && typeof req.body.autoMergeAuthorized !== 'boolean'
    ) {
      res.status(400).json({ error: 'autoMergeAuthorized must be a boolean' });
      return;
    }
    try {
      const mission = store.updateMissionPlan(
        req.params.id,
        req.params.missionId,
        roleIds,
        req.body?.autoMergeAuthorized === true,
      );
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/revisions', async (req, res) => {
    const group = store.groupById(req.params.id);
    const mission = store.taskSessionById(req.params.missionId);
    const workItemId = typeof req.body?.workItemId === 'string' ? req.body.workItemId : '';
    const actorAgentId = typeof req.body?.actorAgentId === 'string' ? req.body.actorAgentId : '';
    if (!group || !mission || mission.groupId !== group.id) {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    if (!group.workingDirectory || !mission.gitBaseline) {
      res.status(409).json({ error: '当前任务尚未准备 Git 基线' });
      return;
    }
    if (!workItemId || !actorAgentId) {
      res.status(400).json({ error: 'workItemId and actorAgentId required' });
      return;
    }
    try {
      const snapshot = await captureImplementationRevision(
        group.workingDirectory,
        mission.gitBaseline,
        nextImplementationRevisionNumber(mission.implementationRevisions ?? []),
      );
      const result = store.recordImplementationRevision(
        group.id,
        mission.id,
        workItemId,
        actorAgentId,
        snapshot,
      );
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/pause', (req, res) => {
    const group = store.groupById(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const mission = store.pauseMission(group.id, req.params.missionId, note);
      for (const agentId of groupMemberIds(group)) pm.killAgent(agentId, group.id);
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/request-changes', (req, res) => {
    const group = store.groupById(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const result = store.requestMissionChanges(group.id, req.params.missionId, note);
      const owner = result.workItem?.ownerMemberId
        ? group.members.find(member => member.id === result.workItem?.ownerMemberId)
        : undefined;
      if (owner && result.workItem) {
        pm.sendKeys(
          owner.agentId,
          `[群主要求修改]\n请读取 .ai-team/tasks/${result.mission.id}/work-items/${result.workItem.id}/inbox/offer-001.md 并回执。`,
          group.id,
          result.mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/accept-risk', (req, res) => {
    const group = store.groupById(req.params.id);
    const issueIds = Array.isArray(req.body?.issueIds) ? req.body.issueIds : undefined;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (!issueIds || !issueIds.every((issueId: unknown) => typeof issueId === 'string')) {
      res.status(400).json({ error: 'issueIds must be a string array' });
      return;
    }
    try {
      const result = store.acceptMissionRisk(group.id, req.params.missionId, issueIds, note);
      for (const offered of [
        ...(result.workItem ? [result.workItem] : []),
        ...(result.collaborationWorkItems ?? []),
      ]) {
        const owner = group.members.find(member => member.id === offered.ownerMemberId);
        if (!owner) continue;
        pm.sendKeys(
          owner.agentId,
          `[群主风险决策后的新工作项]\n请读取 .ai-team/tasks/${result.mission.id}/work-items/${offered.id}/inbox/offer-001.md 并回执。`,
          group.id,
          result.mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/extend-rework', (req, res) => {
    const group = store.groupById(req.params.id);
    const additionalRounds = Number(req.body?.additionalRounds);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const result = store.extendMissionRework(
        group.id,
        req.params.missionId,
        additionalRounds,
        note,
      );
      const owner = result.workItem?.ownerMemberId
        ? group.members.find(member => member.id === result.workItem?.ownerMemberId)
        : undefined;
      if (owner && result.workItem) {
        pm.sendKeys(
          owner.agentId,
          `[群主追加返工轮次]\n请读取 .ai-team/tasks/${result.mission.id}/work-items/${result.workItem.id}/inbox/offer-001.md 并回执。`,
          group.id,
          result.mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/work-items/:workItemId/reassign', (req, res) => {
    const group = store.groupById(req.params.id);
    const targetMemberId = typeof req.body?.targetMemberId === 'string'
      ? req.body.targetMemberId
      : '';
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const result = store.reassignMissionWorkItem(
        group.id,
        req.params.missionId,
        req.params.workItemId,
        targetMemberId,
        note,
      );
      const owner = result.workItem?.ownerMemberId
        ? group.members.find(member => member.id === result.workItem?.ownerMemberId)
        : undefined;
      if (owner && result.workItem) {
        pm.sendKeys(
          owner.agentId,
          `[群主改派工作项]\n请读取 .ai-team/tasks/${result.mission.id}/work-items/${result.workItem.id}/inbox/offer-001.md 并回执。`,
          group.id,
          result.mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/external-implementation', async (req, res) => {
    const group = store.groupById(req.params.id);
    const mission = store.taskSessionById(req.params.missionId);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    if (!group.workingDirectory || !mission.gitBaseline) {
      res.status(409).json({ error: '外部实现导入需要已准备的 Git 基线' });
      return;
    }
    if (!note) {
      res.status(400).json({ error: 'note required' });
      return;
    }
    try {
      const snapshot = await captureImplementationRevision(
        group.workingDirectory,
        mission.gitBaseline,
        nextImplementationRevisionNumber(mission.implementationRevisions ?? []),
      );
      const result = store.recordExternalImplementationRevision(
        group.id,
        mission.id,
        note,
        snapshot,
      );
      const relaunchError = await relaunchGroupAgents(group, mission.requiredMemberIds);
      if (relaunchError) {
        res.status(500).json({ error: relaunchError, ...result });
        return;
      }
      for (const offered of [
        ...(result.workItem ? [result.workItem] : []),
        ...(result.collaborationWorkItems ?? []),
      ]) {
        if (offered.status !== 'offered') continue;
        const owner = group.members.find(member => member.id === offered.ownerMemberId);
        if (!owner) continue;
        pm.sendKeys(
          owner.agentId,
          `[群主已导入外部实现 ${result.revision.id}]\n请读取 .ai-team/tasks/${mission.id}/work-items/${offered.id}/inbox/offer-001.md 并按当前版本回执。`,
          group.id,
          mission.id,
        );
      }
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/external-changes', async (req, res) => {
    const group = store.groupById(req.params.id);
    const mission = store.taskSessionById(req.params.missionId);
    const decision = req.body?.decision;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    if (!['incorporate', 'discard'].includes(decision)) {
      res.status(400).json({ error: 'decision must be incorporate or discard' });
      return;
    }
    try {
      const result = store.resolveExternalChanges(group.id, mission.id, decision, note);
      const relaunchError = await relaunchGroupAgents(group, mission.requiredMemberIds);
      if (relaunchError) {
        res.status(500).json({ error: relaunchError, ...result });
        return;
      }
      const pendingItems = result.workItem
        ? [result.workItem]
        : store.taskCards.filter(item => (
          item.taskSessionId === mission.id
          && ['offered', 'accepted', 'active', 'submitted'].includes(item.status)
        ));
      for (const workItem of pendingItems) {
        const owner = group.members.find(member => member.id === workItem.ownerMemberId);
        if (!owner) continue;
        pm.sendKeys(
          owner.agentId,
          decision === 'incorporate'
            ? `[群主决定纳入外部变更]\n请读取 .ai-team/tasks/${mission.id}/work-items/${workItem.id}/brief.md，核对完整 diff 并生成新实现修订。`
            : `[群主决定移除外部变更]\n已恢复批准修订，请重新读取 .ai-team/tasks/${mission.id}/work-items/${workItem.id}/brief.md 后继续。`,
          group.id,
          mission.id,
        );
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 409).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/resume', async (req, res) => {
    const group = store.groupById(req.params.id);
    const mission = store.taskSessionById(req.params.missionId);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      res.status(404).json({ error: 'mission not found' });
      return;
    }
    if (!note) {
      res.status(400).json({ error: 'note required' });
      return;
    }
    const relaunchError = await relaunchGroupAgents(group, mission.requiredMemberIds);
    if (relaunchError) {
      res.status(500).json({ error: relaunchError });
      return;
    }
    try {
      const resumed = store.resumeMission(group.id, mission.id, note);
      for (const workItem of store.taskCards.filter(item => (
        item.taskSessionId === mission.id
        && ['offered', 'accepted', 'active', 'waiting_dependency'].includes(item.status)
      ))) {
        const owner = group.members.find(member => member.id === workItem.ownerMemberId);
        if (!owner) continue;
        pm.sendKeys(
          owner.agentId,
          `[任务恢复]\n请重新读取 .ai-team/tasks/${mission.id}/work-items/${workItem.id}/brief.md，并从当前结构化状态继续。`,
          group.id,
          mission.id,
        );
      }
      res.json({ ok: true, mission: resumed });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/cancel', (req, res) => {
    const group = store.groupById(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const mission = store.cancelMission(group.id, req.params.missionId, note);
      for (const agentId of groupMemberIds(group)) pm.killAgent(agentId, group.id);
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.post('/api/groups/:id/missions/:missionId/complete', (req, res) => {
    const group = store.groupById(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    try {
      const mission = store.completeMission(group.id, req.params.missionId, note);
      for (const agentId of groupMemberIds(group)) pm.killAgent(agentId, group.id);
      res.json({ ok: true, mission });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'mission not found' ? 404 : 400).json({ error: message });
    }
  });

  app.post('/api/groups/:id/tasks', async (req, res) => {
    res.status(410).json({ error: '旧任务会话接口已移除，请使用 /missions' });
  });

  app.post('/api/groups/:id/worker-tasks', async (req, res) => {
    res.status(410).json({ error: '多 Worktree Worker Thread 已移除；每个任务只允许技术 Leader 在本机任务分支实施' });
  });

  app.post('/api/groups/:id/members', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (group.groupType === 'direct') {
      res.status(400).json({ error: '单聊不支持添加成员' });
      return;
    }

    const { agentId, roleId, makeLeader } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
    const member = createGroupMember(agentId, roleId ?? null);
    try {
      store.addMember(member, req.params.id, makeLeader === true);
      res.json(member);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.endsWith('not found') ? 404 : 400).json({ error: message });
    }
  });

  app.delete('/api/groups/:id/members/:memberId', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const member = group.members.find(m => m.id === req.params.memberId);
    if (!member) { res.status(404).json({ error: 'member not found' }); return; }
    const replacementLeaderMemberId = typeof req.body?.replacementLeaderMemberId === 'string'
      ? req.body.replacementLeaderMemberId
      : typeof req.query.replacementLeaderMemberId === 'string'
        ? req.query.replacementLeaderMemberId
        : undefined;
    try {
      store.removeMember(member, req.params.id, replacementLeaderMemberId);
      pm.killAgent(member.agentId, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/groups/:id/role-leaders/:roleId', (req, res) => {
    const memberId = typeof req.body?.memberId === 'string' ? req.body.memberId : '';
    try {
      const group = store.setGroupRoleLeader(req.params.id, req.params.roleId, memberId);
      res.json({ ok: true, group });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'group not found' ? 404 : 400).json({ error: message });
    }
  });

  app.post('/api/groups/:id/members/:memberId/online', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const member = group.members.find(m => m.id === req.params.memberId);
    if (!member) { res.status(404).json({ error: 'member not found' }); return; }
    const agent = store.agentById(member.agentId);
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }

    const groupId = req.params.id;
    const launchError = pm.launchAgent(agent, port, group.workingDirectory, groupId);
    if (launchError) {
      res.status(500).json({ error: launchError });
      return;
    }

    const startupError = await pm.waitForAgentStartup(agent.id, undefined, groupId);
    if (startupError) {
      res.status(500).json({ error: startupError });
      return;
    }

    if (group.groupType !== 'direct') {
      store.writeTeamFiles(group);
      reinitializeMemberRolePrompt(group, member);
    }
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/members/:memberId/offline', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const member = group.members.find(m => m.id === req.params.memberId);
    if (!member) { res.status(404).json({ error: 'member not found' }); return; }
    store.markRequiredMemberOffline(group.id, member.id);
    pm.killAgent(member.agentId, req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/groups/:id/members/:memberId/terminal', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const member = group.members.find(m => m.id === req.params.memberId);
    if (!member) { res.status(404).json({ error: 'member not found' }); return; }
    pm.attachTerminal(member.agentId, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/groups/:id/files', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.json({ path: '', files: [] }); return; }

    const subpath = typeof req.query.subpath === 'string' ? req.query.subpath : '';
    const targetDir = subpath
      ? resolve(group.workingDirectory, subpath)
      : group.workingDirectory;

    if (!targetDir.startsWith(resolve(group.workingDirectory))) {
      res.status(403).json({ error: 'path traversal not allowed' });
      return;
    }

    try {
      const entries = readdirSync(targetDir, { withFileTypes: true });
      const files = entries
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ path: targetDir, files });
    } catch {
      res.json({ path: targetDir, files: [] });
    }
  });

  app.get('/api/groups/:id/files/read', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const root = resolve(group.workingDirectory);
    const target = resolveWorkspacePath(root, req.query.path);
    if (!target) {
      res.status(400).json({ error: 'path required' });
      return;
    }

    try {
      const stat = statSync(target);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'file required' });
        return;
      }

      const previewSize = Math.min(stat.size, MAX_FILE_PREVIEW_BYTES);
      const preview = Buffer.alloc(previewSize);
      const fd = openSync(target, 'r');
      try {
        readSync(fd, preview, 0, previewSize, 0);
      } finally {
        closeSync(fd);
      }
      const isBinary = preview.includes(0);
      res.json({
        path: target,
        content: isBinary ? '' : preview.toString('utf8'),
        isBinary,
        size: stat.size,
        truncated: stat.size > preview.length,
      });
    } catch (error) {
      res.status(directoryStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/groups/:id/files/write', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const { path: relativePath, content } = req.body;
    if (!relativePath || typeof relativePath !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content required' });
      return;
    }

    const { resolve, sep } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');

    const root = resolve(group.workingDirectory);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      res.status(403).json({ error: 'path traversal not allowed' });
      return;
    }

    try {
      await writeFile(target, content, 'utf8');
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post(
    '/api/groups/:id/files/import',
    workspaceImportUpload.array('files', 500),
    async (req, res) => {
      const groupId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
      if (!groupId) { res.status(400).json({ error: 'bad id' }); return; }
      const group = store.groupById(groupId);
      if (!group) { res.status(404).json({ error: 'group not found' }); return; }
      if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) { res.status(400).json({ error: 'no files' }); return; }

      const { mkdir, writeFile } = await import('node:fs/promises');

      const root = resolve(group.workingDirectory);
      const importBase = resolveImportBase(root, req.body?.targetSubpath);
      if (!importBase) {
        res.status(403).json({ error: 'path traversal not allowed' });
        return;
      }
      let imported = 0;

      try {
        for (const f of files) {
          const raw = decodeMultipartFilename((f.originalname ?? '').replace(/\0/g, ''));
          const rel = normalize(raw).replace(/^[/\\]+/, '');
          if (!rel) {
            res.status(400).json({ error: 'invalid path' });
            return;
          }
          const target = resolve(importBase, rel);
          if (target !== root && !target.startsWith(`${root}${sep}`)) {
            res.status(403).json({ error: 'path traversal not allowed' });
            return;
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.buffer);
          imported++;
        }
        res.json({ ok: true, imported });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    },
  );

  app.post('/api/groups/:id/files/import-from-paths', async (req, res) => {
    const groupId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    if (!groupId) { res.status(400).json({ error: 'bad id' }); return; }
    const group = store.groupById(groupId);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((p: unknown) => typeof p === 'string')) {
      res.status(400).json({ error: 'paths array required' });
      return;
    }

    const { cp } = await import('node:fs/promises');

    const root = resolve(group.workingDirectory);
    const importBase = resolveImportBase(root, req.body?.targetSubpath);
    if (!importBase) {
      res.status(403).json({ error: 'path traversal not allowed' });
      return;
    }
    let imported = 0;

    try {
      if (importBase !== root) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(importBase, { recursive: true });
      }
      for (const src of paths as string[]) {
        if (!src.trim()) continue;
        const resolvedSrc = resolve(src);
        if (!existsSync(resolvedSrc)) continue;
        const base = basename(resolvedSrc);
        if (!base) continue;
        const dest = resolve(importBase, base);
        const relToRoot = relative(root, dest);
        if (!relToRoot || relToRoot.startsWith(`..${sep}`) || relToRoot === '..') {
          res.status(403).json({ error: 'path traversal not allowed' });
          return;
        }
        await cp(resolvedSrc, dest, { recursive: true, force: true });
        imported++;
      }
      res.json({ ok: true, imported });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/groups/:id/git/status', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) {
      res.json({
        isGitRepository: false,
        branch: null,
        repositoryRoot: null,
        entries: [],
      });
      return;
    }

    try {
      const status = await getGitWorkspaceStatus(group.workingDirectory);
      res.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/groups/:id/git/diff', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const section = typeof req.query.section === 'string' ? req.query.section : '';
    const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
    if (!path || !['staged', 'unstaged', 'untracked'].includes(section)) {
      res.status(400).json({ error: 'path and valid section required' });
      return;
    }
    if (!['added', 'modified', 'deleted'].includes(kind)) {
      res.status(400).json({ error: 'valid kind required' });
      return;
    }

    try {
      const diff = await getGitDiffForPath(group.workingDirectory, {
        path,
        section: section as 'staged' | 'unstaged' | 'untracked',
        kind: kind as 'added' | 'modified' | 'deleted',
      });
      res.json(diff);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('path traversal') || message.includes('path required') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  app.post('/api/groups/:id/git/stage', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const path = typeof req.body.path === 'string' ? req.body.path : '';
    if (!path) { res.status(400).json({ error: 'path required' }); return; }

    try {
      await stageGitPath(group.workingDirectory, path);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('path traversal') || message.includes('path required') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  app.post('/api/groups/:id/git/unstage', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const path = typeof req.body.path === 'string' ? req.body.path : '';
    if (!path) { res.status(400).json({ error: 'path required' }); return; }

    try {
      await unstageGitPath(group.workingDirectory, path);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('path traversal') || message.includes('path required') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  app.post('/api/groups/:id/git/rollback-paths', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    const paths = req.body.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'paths array required' });
      return;
    }

    try {
      const { resolve, sep } = await import('node:path');
      const root = resolve(group.workingDirectory);
      
      const safePaths = paths.map(p => {
        const pathStr = String(p).replace(/\\/g, '/').replace(/^\.\/+/, '');
        const target = resolve(root, pathStr);
        if (target !== root && !target.startsWith(`${root}${sep}`)) {
          throw new Error('path traversal not allowed');
        }
        return pathStr;
      });

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      
      // Rollback specific paths
      await execFileAsync('git', ['restore', '--staged', '--', ...safePaths], { cwd: group.workingDirectory });
      await execFileAsync('git', ['restore', '--', ...safePaths], { cwd: group.workingDirectory });
      
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('path traversal') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  app.post('/api/groups/:id/git/rollback-all', async (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (!group.workingDirectory) { res.status(400).json({ error: 'working directory required' }); return; }

    try {
      await rollbackAllGitChanges(group.workingDirectory);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/system/open-file', async (req, res) => {
    const { filePath } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'filePath required' });
      return;
    }
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';

    try {
      await execFileAsync(cmd, [filePath]);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  /** 在系统文件管理器中定位并选中该路径（macOS：Finder 的「显示」） */
  app.post('/api/system/reveal-in-finder', async (req, res) => {
    const { filePath } = req.body as { filePath?: string };
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'filePath required' });
      return;
    }
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    try {
      if (process.platform === 'darwin') {
        await execFileAsync('open', ['-R', filePath]);
      } else if (process.platform === 'win32') {
        await execFileAsync('explorer.exe', ['/select,', filePath]);
      } else {
        await execFileAsync('xdg-open', [dirname(filePath)]);
      }
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  if (relay) {
    app.get('/api/relay/config', (_req, res) => {
      res.json(relay.getConfig());
    });

    app.get('/api/relay/status', (_req, res) => {
      res.json(relay.getStatus());
    });

    app.put('/api/relay/config', (req, res) => {
      const { enabled, url, deviceName, token } = req.body ?? {};
      if (token !== undefined) {
        res.status(400).json({ error: '不再接受明文 token，请使用 Octrix 登录授权' });
        return;
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      for (const [key, value] of Object.entries({ url, deviceName })) {
        if (value !== undefined && typeof value !== 'string') {
          res.status(400).json({ error: `${key} must be a string` });
          return;
        }
      }
      try {
        const status = relay.updateConfig({ enabled, url, deviceName });
        res.json({ ok: true, config: relay.getConfig(), status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    });

    app.post('/api/relay/auth/start', async (req, res) => {
      const mode = req.body?.mode === 'device_code' ? 'device_code' : 'browser';
      try {
        res.status(201).json(await relay.beginAuthorization(mode));
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : '无法连接 Octrix 授权中心' });
      }
    });

    app.post('/api/relay/logout', async (_req, res) => {
      res.json({ ok: true, status: await relay.logout() });
    });

    app.get('/api/relay/cli/status', (_req, res) => {
      res.json(getOctrixCliStatus(octrixCliHome));
    });

    app.post('/api/relay/cli/install', (_req, res) => {
      try {
        installOctrixCli(octrixCliHome);
        res.json({ ok: true, ...getOctrixCliStatus(octrixCliHome) });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : '终端命令安装失败' });
      }
    });
  }

  app.get('/api/messages/:id', (req, res) => {
    const msg = hub.messages.find(m => m.id === req.params.id);
    if (!msg) { res.status(404).json({ error: 'message not found' }); return; }
    res.json(msg);
  });

  app.get('/api/groups/:groupId/messages', (req, res) => {
    const taskSessionId = typeof req.query.taskSessionId === 'string' && req.query.taskSessionId
      ? req.query.taskSessionId
      : undefined;
    const before = typeof req.query.before === 'string' ? Number(req.query.before) : undefined;
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 200));
    let messages = hub.messages
      .filter(m => m.groupId === req.params.groupId)
      .filter(m => taskSessionId === undefined || m.taskSessionId === taskSessionId)
      .sort((a, b) => a.ts - b.ts);
    if (before !== undefined && Number.isFinite(before)) {
      messages = messages.filter(m => m.ts < before);
    }
    const page = messages.slice(-limit);
    res.json({
      ok: true,
      messages: page,
      hasMore: messages.length > page.length,
      nextBefore: page[0]?.ts,
    });
  });

  app.post('/api/groups/:id/interrupt', (req, res) => {
    const group = store.groupById(req.params.id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    if (group.archivedAt) {
      res.status(409).json({ error: '会话已归档，无法停止当前回复' });
      return;
    }

    const { targets } = req.body;
    const taskSessionId = resolveActiveTaskSessionId(group.id, req.body.taskSessionId, res, {
      fallbackToActive: false,
      mismatchError: '当前任务已归档，无法停止旧任务中的回复',
    });
    if (!taskSessionId) return;
    if (
      !Array.isArray(targets)
      || targets.some(target => (
        !target
        || typeof target.agentId !== 'string'
        || !target.agentId
        || typeof target.responseId !== 'string'
        || !target.responseId
      ))
    ) {
      res.status(400).json({ error: 'targets must contain agentId and responseId strings' });
      return;
    }

    const memberAgentIds = groupMemberIds(group);
    const memberAgentIdSet = new Set(memberAgentIds);
    const requestedTargets = [...new Map(
      (targets as Array<{ agentId: string; responseId: string }>)
        .map(target => [target.agentId, target]),
    ).values()];
    if (requestedTargets.some(target => !memberAgentIdSet.has(target.agentId))) {
      res.status(400).json({ error: 'target agents must belong to the group' });
      return;
    }

    const interruptedAgentIds = requestedTargets
      .filter(target => pm.interruptAgent(
        target.agentId,
        group.id,
        taskSessionId,
        target.responseId,
      ))
      .map(target => target.agentId);
    res.json({ ok: true, interruptedAgentIds });
  });

  app.post('/api/messages', (req, res) => {
    const { body, groupId, taskSessionId, to, agentIds, clientMsgId } = req.body;
    if (!body || !groupId) { res.status(400).json({ error: 'body and groupId required' }); return; }
    if (clientMsgId !== undefined && typeof clientMsgId !== 'string') {
      res.status(400).json({ error: 'clientMsgId must be a string' });
      return;
    }
    const group = store.groupById(groupId);
    if (!group) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    if (group?.archivedAt) {
      res.status(409).json({ error: '会话已归档，请恢复后继续对话' });
      return;
    }
    if (group.pausedByMissionId) {
      res.status(409).json({ error: `同仓库协作任务 ${group.pausedByMissionId} 运行中，本会话已暂停` });
      return;
    }
    if (agentIds !== undefined && (
      !Array.isArray(agentIds)
      || !agentIds.every((agentId: unknown) => typeof agentId === 'string')
    )) {
      res.status(400).json({ error: 'agentIds must be a string array' });
      return;
    }
    const groupAgentIds = new Set(groupMemberIds(group));
    const requestedAgentIds = [...new Set((agentIds ?? []) as string[])];
    if (requestedAgentIds.some(agentId => !groupAgentIds.has(agentId))) {
      res.status(400).json({ error: 'target agents must belong to the group' });
      return;
    }
    const activeTaskSession = store.activeTaskSessionForGroup(groupId);
    const isCollaborationLobby = group.groupType === 'collaboration'
      && !activeTaskSession
      && (taskSessionId === undefined || taskSessionId === null || taskSessionId === '');
    const requestedTaskSessionId = isCollaborationLobby
      ? undefined
      : resolveActiveTaskSessionId(groupId, taskSessionId, res, {
        fallbackToActive: true,
        mismatchError: '当前任务已归档，请创建新任务后继续对话',
      });
    if (!isCollaborationLobby && !requestedTaskSessionId) return;
    if (clientMsgId) {
      hub.sendUserMessage(body, groupId, requestedTaskSessionId, to ?? '', clientMsgId);
    } else {
      hub.sendUserMessage(body, groupId, requestedTaskSessionId, to ?? '');
    }

    if (!body.startsWith('/wf ')) {
      let effectiveAgentIds = requestedAgentIds;
      if (group.groupType === 'direct') {
        effectiveAgentIds = groupMemberIds(group);
      } else if (body.includes('@所有人')) {
        effectiveAgentIds = groupMemberIds(group);
      } else if (!body.includes('@')) {
        if (isCollaborationLobby) {
          effectiveAgentIds = [];
          hub.addSystemNotice(
            group.id,
            undefined,
            '这条消息已记录在群聊大厅。要让团队正式协作，请创建主任务；也可以先 @具体成员 或 @角色进行定向沟通。',
          );
        } else {
          const mission = requestedTaskSessionId
            ? store.taskSessionById(requestedTaskSessionId)
            : undefined;
          const currentPhase = mission?.phases?.find(phase => phase.id === mission.currentPhaseId);
          const leaderMemberId = currentPhase?.roleId
            ? mission?.leaderSnapshot?.[currentPhase.roleId]
            : undefined;
          const leader = group.members.find(member => member.id === leaderMemberId);
          effectiveAgentIds = leader ? [leader.agentId] : [];
        }
      } else if (effectiveAgentIds.length === 0) {
        const mission = requestedTaskSessionId
          ? store.taskSessionById(requestedTaskSessionId)
          : undefined;
        const mentionedRole = store.roles.find(role => body.includes(`@${role.name}`));
        const leaderMemberId = mentionedRole
          ? mission?.leaderSnapshot?.[mentionedRole.id] ?? group.roleLeaders[mentionedRole.id]
          : undefined;
        const leader = group.members.find(member => member.id === leaderMemberId);
        effectiveAgentIds = leader ? [leader.agentId] : [];
      }
      const cliBody = stripLeadingCliMentions(body);
      const bodyForCli = cliBody.trim() ? cliBody : body;
      for (const agentId of effectiveAgentIds) {
        if (!pm.isAgentRunning(agentId, groupId)) continue;
        const agent = store.agentById(agentId);
        if (!agent) continue;
        const roleName = group ? store.roleName(agent.name, group) : undefined;
        const normalizedBodyForCli = normalizeCliInputForPlatform(agent.platform, bodyForCli);
        const wrapped = roleName
          ? `[角色: ${roleName} | 正式状态变更仅使用 octrix-action 控制块]\n${normalizedBodyForCli}`
          : normalizedBodyForCli;
        if (clientMsgId) {
          // The dispatch message ID is the stable response handle used by the
          // mobile client until the first streamed envelope has been created.
          const responseId = clientMsgId;
          pm.sendKeys(agentId, wrapped, groupId, requestedTaskSessionId, responseId);
        } else {
          pm.sendKeys(agentId, wrapped, groupId, requestedTaskSessionId);
        }
      }
    }
    res.json({ ok: true });
  });

  return app;
}

function roleInitPrompt(roleFileName: string): string {
  return `请按顺序阅读以下文件了解你的协作制度：
1. .ai-team/context.md（入口引导）
2. .ai-team/group.md（群目标与门禁规则）
3. .ai-team/members.md（成员名册）
4. .ai-team/dispatch.md（调度规则）
5. .ai-team/${roleFileName}（你的角色职责）

阅读完成后请简要确认你的角色，然后等待群主下发任务。`;
}
