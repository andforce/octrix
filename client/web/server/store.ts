import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  type Agent, type AgentGroup, type CollaborationIssue, type GroupMember, type Role,
  type TaskCard, type TaskSession,
  type MissionPhase, type MissionTemplate, type MissingRoleResolution,
  type ImplementationRevision, type IssueSeverity, type MissionGitBaseline,
  type MissionOwnerDecision, type MissionQualityPolicy, type OwnerAttentionReason,
  type WorkflowDefinition, type WorkflowRun,
  ALL_ROLES, roleById, roleMarkdownTemplate, groupMemberIds, createTaskSession,
  createMissionSession, createMissionWorkItem, isTaskTerminal,
} from './models.js';
import { type AgentPlatform, getSupportedAgent, isSupportedAgentPlatform } from '../src/agent-platforms.js';
import type { CollaborationControlAction } from './collaboration-protocol.js';
import { nextImplementationRevisionNumber, type GitRevisionSnapshot } from './git.js';
import { validateQualityEvidence } from './collaboration-evidence.js';
import { appendRecoverySnapshot, parseRecoverySnapshot } from './collaboration-recovery.js';
import { defaultMissionQualityPolicy, missionTemplateRoleIds } from './mission-draft.js';

export const WORKSPACE_DATA_VERSION = 1;

interface StorageData {
  workspaceDataVersion?: number;
  collaborationSchemaVersion?: number;
  agents: Agent[];
  groups: AgentGroup[];
  roles?: { id: string; name: string }[];
  taskCards?: TaskCard[];
  taskSessions?: TaskSession[];
  issues?: CollaborationIssue[];
}

interface WorkflowStorageData {
  workflows: WorkflowDefinition[];
  runs: WorkflowRun[];
}

export interface CreateMissionInput {
  title: string;
  objective: string;
  template: MissionTemplate;
  acceptanceCriteria: string[];
  initialOwnerMemberId?: string;
  qualityPolicy?: MissionQualityPolicy;
}

export interface UpdateMissionCharterInput {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  qualityPolicy?: MissionQualityPolicy;
}

export interface MissionOwnerActionResult {
  mission: TaskSession;
  workItem?: TaskCard;
  collaborationWorkItems?: TaskCard[];
}

export type ExternalChangeDecision = 'incorporate' | 'discard';

export interface CollaborationTimeoutResult {
  unresponsive: TaskCard[];
  progressReminders: TaskCard[];
  stalled: TaskCard[];
}

const MISSING_ROLE_RESOLUTIONS: Record<string, MissingRoleResolution[]> = {
  'role-product-manager': ['owner_supplies', 'remove_irrelevant'],
  'role-developer': ['external_implementation', 'remove_irrelevant'],
  'role-code-reviewer': ['waive', 'remove_irrelevant'],
  'role-tester': ['waive', 'remove_irrelevant'],
  'role-committer': ['owner_handles', 'remove_irrelevant'],
};

function normalizeMissionQualityPolicy(policy?: MissionQualityPolicy): MissionQualityPolicy {
  const allowed = new Set<IssueSeverity>(['blocker', 'major', 'minor', 'suggestion']);
  const requested = (policy?.blockingSeverities ?? defaultMissionQualityPolicy().blockingSeverities)
    .filter((severity): severity is IssueSeverity => allowed.has(severity));
  return {
    blockingSeverities: [
      'blocker',
      ...requested.filter(severity => severity !== 'blocker'),
    ].filter((severity, index, all) => all.indexOf(severity) === index) as IssueSeverity[],
    sharedStateTestExecution: 'serial',
  };
}

export class Store {
  static readonly WORKSPACE_DATA_VERSION = WORKSPACE_DATA_VERSION;
  static readonly COLLABORATION_SCHEMA_VERSION = 2;

  agents: Agent[] = [];
  groups: AgentGroup[] = [];
  taskCards: TaskCard[] = [];
  taskSessions: TaskSession[] = [];
  issues: CollaborationIssue[] = [];
  workflows: WorkflowDefinition[] = [];
  workflowRuns: WorkflowRun[] = [];
  removedLegacyGroupIds: string[] = [];
  didResetWorkData = false;

  private configPath: string;
  private workflowPath: string;
  private onChange?: () => void;

  get roles(): Role[] { return ALL_ROLES; }

  constructor(directory?: string) {
    const dir = directory ?? path.join(os.homedir(), '.cli-bridge');
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'config.json');
    this.workflowPath = path.join(dir, 'workflows.json');
    this.load();
    this.loadWorkflows();
  }

  setOnChange(fn: () => void) { this.onChange = fn; }

  // MARK: - Agent CRUD

  addAgent(agent: Agent) {
    this.agents.push(agent);
    this.save();
  }

  updateAgent(agent: Agent) {
    const idx = this.agents.findIndex(a => a.id === agent.id);
    if (idx < 0) return;
    this.agents[idx] = agent;
    this.save();
  }

  removeAgent(id: string) {
    this.agents = this.agents.filter(a => a.id !== id);
    for (const g of this.groups) {
      g.members = g.members.filter(m => m.agentId !== id);
    }
    this.save();
  }

  agentById(id: string): Agent | undefined {
    return this.agents.find(a => a.id === id);
  }

  agentByName(name: string): Agent | undefined {
    return this.agents.find(a => a.name === name);
  }

  agentsByPlatform(platform: string): Agent[] {
    return this.agents.filter(a => a.platform === platform);
  }

  nextAgentName(platform: AgentPlatform): string {
    const supported = getSupportedAgent(platform);
    const baseName = supported.name;
    const count = this.agentsByPlatform(platform).length;
    if (count === 0) return baseName;
    return `${baseName}-${count + 1}`;
  }

  // MARK: - AgentGroup CRUD

  addGroup(group: AgentGroup) {
    this.groups.push(group);
    if (group.groupType === 'direct') this.ensureTaskSessionForGroup(group, '单聊');
    this.save();
  }

  removeGroup(id: string) {
    const group = this.groupById(id);
    const missionIds = this.taskSessions
      .filter(session => session.groupId === id && session.kind === 'mission')
      .map(session => session.id);
    this.groups = this.groups.filter(g => g.id !== id);
    this.taskSessions = this.taskSessions.filter(session => session.groupId !== id);
    this.taskCards = this.taskCards.filter(workItem => workItem.groupId !== id);
    this.issues = this.issues.filter(issue => issue.groupId !== id);
    if (group?.groupType === 'collaboration' && group.workingDirectory) {
      fs.rmSync(path.join(group.workingDirectory, '.ai-team'), { recursive: true, force: true });
    }
    for (const missionId of missionIds) {
      for (const paused of this.groups) {
        if (paused.pausedByMissionId === missionId) delete paused.pausedByMissionId;
      }
    }
    this.save();
  }

  archiveGroup(id: string): AgentGroup | undefined {
    const group = this.groupById(id);
    if (!group) return undefined;
    if (!group.archivedAt) {
      group.archivedAt = Date.now() / 1000;
      this.save();
    }
    return group;
  }

  unarchiveGroup(id: string): AgentGroup | undefined {
    const group = this.groupById(id);
    if (!group) return undefined;
    if (group.archivedAt) {
      delete group.archivedAt;
      this.save();
    }
    return group;
  }

  addMember(member: GroupMember, groupId: string, makeLeader = false): GroupMember {
    const group = this.groups.find(g => g.id === groupId);
    if (!group) throw new Error('group not found');
    if (group.groupType === 'direct') throw new Error('单聊不支持添加成员');
    if (!this.agentById(member.agentId)) throw new Error('agent not found');
    if (group.members.some(m => m.agentId === member.agentId)) {
      throw new Error('一个 AI 在同一群内只能拥有一个角色');
    }
    if (!member.roleId || !roleById(member.roleId)) throw new Error('必须分配有效的基础角色');
    if (
      member.roleId === 'role-committer'
      && group.members.some(existing => existing.roleId === 'role-committer')
    ) {
      throw new Error('每个群最多只能有一个提交专员');
    }
    group.members.push(member);
    const roleMembers = group.members.filter(item => item.roleId === member.roleId);
    if (roleMembers.length === 1 || makeLeader) group.roleLeaders[member.roleId] = member.id;
    group.compositionStatus = group.members.length >= 2 ? 'active' : 'composition_insufficient';
    this.writeTeamFiles(group);
    this.save();
    return member;
  }

  removeMember(member: GroupMember, groupId: string, replacementLeaderMemberId?: string): GroupMember {
    const group = this.groups.find(g => g.id === groupId);
    if (!group) throw new Error('group not found');
    if (!group.members.some(item => item.id === member.id)) throw new Error('member not found');
    const wasLeader = !!member.roleId && group.roleLeaders[member.roleId] === member.id;
    const remainingRoleMembers = group.members.filter(item => (
      item.id !== member.id && item.roleId === member.roleId
    ));
    if (wasLeader && remainingRoleMembers.length > 1) {
      const replacement = remainingRoleMembers.find(item => item.id === replacementLeaderMemberId);
      if (!replacement) throw new Error('移除多成员角色的 Leader 前必须指定继任 Leader');
    }
    group.members = group.members.filter(m => m.id !== member.id);
    if (member.roleId && wasLeader) {
      if (remainingRoleMembers.length === 0) delete group.roleLeaders[member.roleId];
      else if (remainingRoleMembers.length === 1) group.roleLeaders[member.roleId] = remainingRoleMembers[0].id;
      else group.roleLeaders[member.roleId] = replacementLeaderMemberId!;
    }
    group.compositionStatus = group.members.length >= 2 ? 'active' : 'composition_insufficient';

    const activeMission = this.activeTaskSessionForGroup(group.id);
    if (
      activeMission?.kind === 'mission'
      && !['completed', 'cancelled', 'archived'].includes(activeMission.status)
      && (
        activeMission.requiredMemberIds?.includes(member.id)
        || Object.values(activeMission.leaderSnapshot ?? {}).includes(member.id)
      )
    ) {
      const now = Date.now() / 1000;
      activeMission.status = 'waiting_human';
      activeMission.interruptionReason = `required_member_removed:${member.id}`;
      activeMission.interruptedAt = now;
      activeMission.updatedAt = now;
      activeMission.revision = (activeMission.revision ?? 0) + 1;
      for (const workItem of this.taskCards.filter(item => (
        item.taskSessionId === activeMission.id
        && item.ownerMemberId === member.id
        && !isTaskTerminal(item)
      ))) {
        workItem.interruptedFromStatus = workItem.status;
        workItem.status = 'interrupted';
        workItem.updatedAt = now;
        workItem.revision = (workItem.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, activeMission, workItem);
      }
      this.writeMissionFiles(group, activeMission);
      this.appendMissionEvent(
        group,
        activeMission,
        'mission.required_member_removed',
        `member=${member.id}`,
      );
    }
    this.writeTeamFiles(group);
    this.save();
    return member;
  }

  markRequiredMemberOffline(groupId: string, memberId: string): TaskSession | undefined {
    const group = this.groupById(groupId);
    const member = group?.members.find(item => item.id === memberId);
    const mission = group ? this.activeTaskSessionForGroup(group.id) : undefined;
    if (
      !group
      || !member
      || !mission
      || mission.kind !== 'mission'
      || !mission.requiredMemberIds?.includes(member.id)
      || ['completed', 'cancelled', 'archived', 'ready_for_owner'].includes(mission.status)
    ) {
      return mission;
    }
    const now = Date.now() / 1000;
    mission.status = 'waiting_human';
    mission.interruptionReason = `required_member_offline:${member.id}`;
    mission.interruptedAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    for (const workItem of this.taskCards.filter(item => (
      item.taskSessionId === mission.id
      && ['offered', 'accepted', 'active', 'waiting_dependency', 'waiting_collab'].includes(item.status)
    ))) {
      workItem.interruptedFromStatus = workItem.status;
      workItem.status = 'interrupted';
      workItem.updatedAt = now;
      workItem.revision = (workItem.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, workItem);
    }
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.required_member_offline', `member=${member.id}`);
    this.save();
    return mission;
  }

  setGroupRoleLeader(groupId: string, roleId: string, memberId: string): AgentGroup {
    const group = this.groupById(groupId);
    if (!group) throw new Error('group not found');
    const member = group.members.find(item => item.id === memberId && item.roleId === roleId);
    if (!member) throw new Error('Leader 必须是该角色的群成员');
    group.roleLeaders[roleId] = member.id;
    this.writeTeamFiles(group);
    this.save();
    return group;
  }

  setMissionRoleLeader(
    groupId: string,
    missionId: string,
    roleId: string,
    memberId: string,
  ): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'draft') throw new Error('只有草稿任务可以覆盖任务 Leader');
    const member = group.members.find(item => item.id === memberId && item.roleId === roleId);
    const phase = (mission.phases ?? []).find(item => item.roleId === roleId);
    if (!member || !phase) throw new Error('Leader 必须是任务阶段对应角色的群成员');
    const previousLeader = phase.leaderMemberId;
    phase.leaderMemberId = member.id;
    phase.status = 'planned';
    mission.leaderSnapshot = { ...(mission.leaderSnapshot ?? {}), [roleId]: member.id };
    const requiredRoleIds = new Set(
      (mission.phases ?? []).filter(item => item.required).map(item => item.roleId),
    );
    mission.requiredMemberIds = group.members
      .filter(item => requiredRoleIds.has(item.roleId ?? ''))
      .map(item => item.id);
    if (mission.initialOwnerMemberId === previousLeader) mission.initialOwnerMemberId = member.id;
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.leader_overridden', `role=${roleId} member=${member.id}`);
    this.save();
    return mission;
  }

  updateMissionCharter(
    groupId: string,
    missionId: string,
    input: UpdateMissionCharterInput,
  ): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'draft') throw new Error('只有草稿任务可以修改任务章程');
    const title = input.title.trim();
    const objective = input.objective.trim();
    const acceptanceCriteria = input.acceptanceCriteria.map(item => item.trim()).filter(Boolean);
    if (!title || !objective || acceptanceCriteria.length === 0) {
      throw new Error('任务标题、目标和至少一条验收标准不能为空');
    }
    mission.title = title;
    mission.objective = objective;
    mission.acceptanceCriteria = acceptanceCriteria;
    mission.qualityPolicy = normalizeMissionQualityPolicy(input.qualityPolicy);
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.charter_updated',
      `blocking=${mission.qualityPolicy.blockingSeverities.join(',')}`,
    );
    this.save();
    return mission;
  }

  updateMissionPlan(
    groupId: string,
    missionId: string,
    roleIds: string[],
    autoMergeAuthorized = false,
  ): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'draft') throw new Error('只有草稿任务可以调整阶段计划');
    if (roleIds.length === 0) throw new Error('阶段计划至少需要一个角色');
    if (new Set(roleIds).size !== roleIds.length) throw new Error('阶段计划中的角色不能重复');
    if (roleIds.some(roleId => !roleById(roleId))) throw new Error('阶段计划包含未知基础角色');
    if (autoMergeAuthorized && !roleIds.includes('role-committer')) {
      throw new Error('自动合并预授权必须保留提交专员阶段');
    }

    const previousByRole = new Map((mission.phases ?? []).map(phase => [phase.roleId, phase]));
    const phases: MissionPhase[] = roleIds.map((roleId, index) => {
      const previous = previousByRole.get(roleId);
      const previousLeader = previous?.leaderMemberId
        ? group.members.find(member => member.id === previous.leaderMemberId && member.roleId === roleId)
        : undefined;
      const leaderMemberId = previousLeader?.id ?? group.roleLeaders[roleId];
      const keepsWaiver = previous?.status === 'waived';
      return {
        id: `phase-${index + 1}-${roleId.replace(/^role-/, '')}`,
        name: roleById(roleId)?.name ?? roleId,
        roleId,
        leaderMemberId,
        status: keepsWaiver ? 'waived' : leaderMemberId ? 'planned' : 'missing',
        required: !keepsWaiver,
        order: index + 1,
      };
    });
    const leaderSnapshot = Object.fromEntries(
      phases
        .filter(phase => phase.leaderMemberId)
        .map(phase => [phase.roleId, phase.leaderMemberId!]),
    );
    mission.phases = phases;
    mission.leaderSnapshot = leaderSnapshot;
    const requiredRoleIds = new Set(phases.filter(phase => phase.required).map(phase => phase.roleId));
    mission.requiredMemberIds = group.members
      .filter(member => requiredRoleIds.has(member.roleId ?? ''))
      .map(member => member.id);
    mission.missingRoleDecisions = (mission.missingRoleDecisions ?? [])
      .filter(decision => roleIds.includes(decision.roleId));
    mission.initialOwnerMemberId = phases.find(phase => phase.leaderMemberId)?.leaderMemberId;
    mission.autoMergeAuthorized = autoMergeAuthorized;
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.plan_updated',
      `roles=${roleIds.join(',')} autoMerge=${autoMergeAuthorized}`,
    );
    this.save();
    return mission;
  }

  groupById(id: string): AgentGroup | undefined {
    return this.groups.find(g => g.id === id);
  }

  taskSessionById(id: string): TaskSession | undefined {
    return this.taskSessions.find(session => session.id === id);
  }

  taskSessionsForGroup(groupId: string): TaskSession[] {
    return this.taskSessions
      .filter(session => session.groupId === groupId)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  activeMissionForRepository(repositoryRoot: string, excludingMissionId?: string): TaskSession | undefined {
    const normalizedRoot = path.resolve(repositoryRoot);
    return this.taskSessions.find(mission => (
      mission.kind === 'mission'
      && mission.id !== excludingMissionId
      && !!mission.gitBaseline
      && path.resolve(mission.gitBaseline.repositoryRoot) === normalizedRoot
      && mission.status !== 'draft'
      && !['completed', 'cancelled', 'archived'].includes(mission.status)
    ));
  }

  activeMissionForWorkspace(workingDirectory: string, excludingMissionId?: string): TaskSession | undefined {
    const normalizedWorkspace = path.resolve(workingDirectory.trim());
    return this.taskSessions.find(mission => {
      if (
        mission.kind !== 'mission'
        || mission.id === excludingMissionId
        || mission.status === 'draft'
        || ['completed', 'cancelled', 'archived'].includes(mission.status)
      ) {
        return false;
      }
      const group = this.groupById(mission.groupId);
      return !!group?.workingDirectory
        && path.resolve(group.workingDirectory) === normalizedWorkspace;
    });
  }

  pauseGroupsForMission(groupIds: string[], missionId: string) {
    let changed = false;
    for (const group of this.groups) {
      if (!groupIds.includes(group.id) || group.pausedByMissionId === missionId) continue;
      group.pausedByMissionId = missionId;
      changed = true;
    }
    if (changed) this.save();
  }

  releaseGroupsPausedByMission(missionId: string) {
    let changed = false;
    for (const group of this.groups) {
      if (group.pausedByMissionId !== missionId) continue;
      delete group.pausedByMissionId;
      changed = true;
    }
    if (changed) this.save();
  }

  activeTaskSessionForGroup(groupId: string): TaskSession | undefined {
    const group = this.groupById(groupId);
    if (!group?.activeTaskSessionId) return undefined;
    return this.taskSessionById(group.activeTaskSessionId);
  }

  ensureTaskSessionForGroup(group: AgentGroup, title = '初始任务'): TaskSession {
    const currentActive = group.activeTaskSessionId
      ? this.taskSessionById(group.activeTaskSessionId)
      : undefined;
    if (currentActive?.groupId === group.id && currentActive.status === 'active') {
      return currentActive;
    }

    const existingActive = this.taskSessions.find(
      session => session.groupId === group.id && session.status === 'active',
    );
    if (existingActive) {
      group.activeTaskSessionId = existingActive.id;
      return existingActive;
    }

    const fallback = this.taskSessions
      .filter(session => session.groupId === group.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (fallback) {
      fallback.status = 'active';
      delete fallback.archivedAt;
      group.activeTaskSessionId = fallback.id;
      return fallback;
    }

    const session = createTaskSession(group.id, title);
    this.taskSessions.push(session);
    group.activeTaskSessionId = session.id;
    return session;
  }

  ensureTaskSessionsForGroups(): boolean {
    let changed = false;
    for (const group of this.groups) {
      if (group.groupType !== 'direct') continue;
      const before = group.activeTaskSessionId;
      const countBefore = this.taskSessions.length;
      const session = this.ensureTaskSessionForGroup(group, '单聊');
      if (before !== group.activeTaskSessionId || countBefore !== this.taskSessions.length || session.status !== 'active') {
        changed = true;
      }
    }
    return changed;
  }

  createTaskSession(groupId: string, title: string): TaskSession {
    const group = this.groupById(groupId);
    if (!group) throw new Error('group not found');
    const trimmedTitle = title.trim();
    if (!trimmedTitle) throw new Error('title required');

    const current = this.activeTaskSessionForGroup(groupId);
    if (current) {
      current.status = 'archived';
      current.archivedAt = Date.now() / 1000;
    }

    const session = createTaskSession(groupId, trimmedTitle);
    this.taskSessions.push(session);
    group.activeTaskSessionId = session.id;
    this.save();
    return session;
  }

  createMission(groupId: string, input: CreateMissionInput): TaskSession {
    const group = this.groupById(groupId);
    if (!group) throw new Error('group not found');
    if (group.groupType === 'direct') throw new Error('单聊不支持主任务');
    if (group.compositionStatus !== 'active' || group.members.length < 2) {
      throw new Error('群聊至少需要两个 AI 才能创建任务');
    }
    const activeMission = this.activeTaskSessionForGroup(groupId);
    if (activeMission && !['completed', 'cancelled', 'archived'].includes(activeMission.status)) {
      throw new Error('当前群已有未完成的主任务');
    }

    const roleIds = missionTemplateRoleIds(input.template);
    const phases: MissionPhase[] = roleIds.map((roleId, index) => ({
      id: `phase-${index + 1}-${roleId.replace(/^role-/, '')}`,
      name: roleById(roleId)?.name ?? roleId,
      roleId,
      leaderMemberId: group.roleLeaders[roleId],
      status: group.roleLeaders[roleId] ? 'planned' : 'missing',
      required: true,
      order: index + 1,
    }));
    const leaderSnapshot = Object.fromEntries(
      Object.entries(group.roleLeaders).filter(([roleId]) => roleIds.includes(roleId)),
    );
    const firstAvailableLeader = phases.find(phase => phase.leaderMemberId)?.leaderMemberId;
    const initialOwnerMemberId = input.initialOwnerMemberId ?? firstAvailableLeader;
    if (
      initialOwnerMemberId
      && !group.members.some(member => member.id === initialOwnerMemberId)
    ) {
      throw new Error('首位负责人必须是当前群成员');
    }

    const mission = createMissionSession(
      group.id,
      input.title.trim(),
      input.objective.trim(),
      input.template,
      input.acceptanceCriteria.map(item => item.trim()).filter(Boolean),
      phases,
      leaderSnapshot,
      initialOwnerMemberId,
      normalizeMissionQualityPolicy(input.qualityPolicy),
    );
    mission.requiredMemberIds = group.members
      .filter(member => roleIds.includes(member.roleId ?? ''))
      .map(member => member.id);
    this.taskSessions.push(mission);
    group.activeTaskSessionId = mission.id;
    this.writeMissionFiles(group, mission);
    this.save();
    return mission;
  }

  beginMissionPreparation(groupId: string, missionId: string): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'draft') throw new Error('只有草稿任务可以进入准备阶段');
    const missing = (mission.phases ?? []).filter(phase => phase.required && phase.status === 'missing');
    if (missing.length > 0) throw new Error('缺岗决策未完成，不能准备任务');
    mission.status = 'preparing';
    mission.updatedAt = Date.now() / 1000;
    mission.revision = (mission.revision ?? 0) + 1;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.preparing');
    this.save();
    return mission;
  }

  abortMissionPreparation(groupId: string, missionId: string, reason: string): TaskSession | undefined {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') return undefined;
    if (mission.status !== 'preparing') return mission;
    mission.status = 'draft';
    mission.updatedAt = Date.now() / 1000;
    mission.revision = (mission.revision ?? 0) + 1;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.preparation_failed',
      reason.replace(/\s+/g, ' ').slice(0, 500),
    );
    for (const paused of this.groups) {
      if (paused.pausedByMissionId === mission.id) delete paused.pausedByMissionId;
    }
    this.save();
    return mission;
  }

  startMission(groupId: string, missionId: string): {
    mission: TaskSession;
    workItem: TaskCard;
    collaborationWorkItems: TaskCard[];
  };
  startMission(groupId: string, missionId: string, allowOwnerOnly: boolean): {
    mission: TaskSession;
    workItem?: TaskCard;
    collaborationWorkItems: TaskCard[];
  };
  startMission(groupId: string, missionId: string, allowOwnerOnly = false): {
    mission: TaskSession;
    workItem?: TaskCard;
    collaborationWorkItems: TaskCard[];
  } {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (!['draft', 'preparing'].includes(mission.status)) throw new Error('只有草稿或准备中的任务可以启动');
    const missing = (mission.phases ?? []).filter(phase => phase.required && phase.status === 'missing');
    if (missing.length > 0) {
      throw new Error(`缺岗决策未完成：${missing.map(phase => phase.name).join('、')}`);
    }
    const firstPhase = (mission.phases ?? [])
      .filter(phase => phase.status === 'planned')
      .slice()
      .sort((a, b) => a.order - b.order)[0];
    if (!firstPhase) {
      if (!(mission.phases ?? []).every(phase => phase.status === 'waived')) {
        throw new Error('首个阶段没有可用 Leader');
      }
      if (!allowOwnerOnly) throw new Error('任务没有 AI 工作阶段，必须由群主入口启动');
      const now = Date.now() / 1000;
      if (!mission.currentRequirementsRevision && group.workingDirectory) {
        this.freezeOwnerRequirements(group, mission);
      }
      const awaitsExternalImplementation = (mission.missingRoleDecisions ?? []).some(decision => (
        decision.roleId === 'role-developer' && decision.resolution === 'external_implementation'
      )) && !mission.currentImplementationRevisionId;
      mission.status = awaitsExternalImplementation ? 'waiting_human' : 'ready_for_owner';
      mission.startedAt = now;
      mission.updatedAt = now;
      mission.revision = (mission.revision ?? 0) + 1;
      if (awaitsExternalImplementation) {
        mission.interruptionReason = 'awaiting_external_implementation';
        mission.interruptedAt = now;
      }
      this.writeMissionFiles(group, mission);
      this.appendMissionEvent(
        group,
        mission,
        awaitsExternalImplementation
          ? 'mission.awaiting_external_implementation'
          : 'mission.all_phases_waived',
      );
      this.save();
      return { mission, collaborationWorkItems: [] };
    }
    if (!firstPhase.leaderMemberId) throw new Error('首个阶段没有可用 Leader');
    const ownerMemberId = mission.initialOwnerMemberId ?? firstPhase.leaderMemberId;
    const ownerMember = group.members.find(member => member.id === ownerMemberId);
    if (!ownerMember || ownerMember.roleId !== firstPhase.roleId) {
      throw new Error('首位负责人必须是首个阶段角色的成员');
    }
    const ownerAgent = this.agentById(ownerMember.agentId);
    if (!ownerAgent) throw new Error('首位负责人对应的 AI 不存在');

    const now = Date.now() / 1000;
    if (!mission.currentRequirementsRevision && group.workingDirectory) {
      this.freezeOwnerRequirements(group, mission);
    }
    firstPhase.status = 'active';
    mission.status = 'active';
    mission.currentPhaseId = firstPhase.id;
    mission.startedAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    const workItem = createMissionWorkItem(mission, firstPhase, ownerMember, ownerAgent.id);
    if (mission.currentRequirementsRevision) {
      workItem.requirementsRevision = mission.currentRequirementsRevision;
    }
    workItem.implementationRevisionId = mission.currentImplementationRevisionId;
    this.taskCards.push(workItem);
    const collaborationWorkItems = this.createPhaseCollaborationWorkItems(
      group,
      mission,
      firstPhase,
      workItem,
    );
    const externalDeveloperPhase = (mission.phases ?? []).find(phase => (
      phase.roleId === 'role-developer'
      && phase.status === 'waived'
      && (mission.missingRoleDecisions ?? []).some(decision => (
        decision.roleId === phase.roleId && decision.resolution === 'external_implementation'
      ))
    ));
    if (
      externalDeveloperPhase
      && externalDeveloperPhase.order < firstPhase.order
      && !mission.currentImplementationRevisionId
    ) {
      for (const item of [workItem, ...collaborationWorkItems]) {
        item.resumeStatus = 'offered';
        item.status = 'waiting_human';
      }
      mission.status = 'waiting_human';
      mission.interruptionReason = 'awaiting_external_implementation';
      mission.interruptedAt = now;
    }
    this.writeMissionFiles(group, mission);
    this.writeWorkItemFiles(group, mission, workItem);
    for (const collaborationWorkItem of collaborationWorkItems) {
      this.writeWorkItemFiles(group, mission, collaborationWorkItem);
    }
    this.appendMissionEvent(group, mission, 'mission.started', `workItem=${workItem.id}`);
    this.save();
    return { mission, workItem, collaborationWorkItems };
  }

  pauseMission(groupId: string, missionId: string, note: string): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'active') throw new Error('只有自治运行中的任务可以暂停');
    if (!trimmedNote) throw new Error('暂停任务必须说明原因');
    const now = Date.now() / 1000;
    for (const workItem of this.taskCards.filter(item => (
      item.taskSessionId === mission.id
      && ['offered', 'accepted', 'active', 'waiting_dependency', 'waiting_collab'].includes(item.status)
    ))) {
      workItem.resumeStatus = workItem.status;
      workItem.status = 'waiting_human';
      workItem.updatedAt = now;
      workItem.revision = (workItem.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, workItem);
    }
    mission.status = 'waiting_human';
    mission.interruptionReason = 'owner_paused';
    mission.interruptedAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    this.recordOwnerDecision(mission, 'pause', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.paused', trimmedNote);
    this.save();
    return mission;
  }

  recordProtocolFailure(
    groupId: string,
    missionId: string,
    memberId: string,
    detail: string,
  ): number {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') return 0;
    if (!group.members.some(member => member.id === memberId)) return 0;
    if (['completed', 'cancelled', 'archived'].includes(mission.status)) return 0;
    const count = (mission.protocolFailureCounts?.[memberId] ?? 0) + 1;
    mission.protocolFailureCounts = {
      ...(mission.protocolFailureCounts ?? {}),
      [memberId]: count,
    };
    const now = Date.now() / 1000;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    this.appendMissionEvent(
      group,
      mission,
      'protocol.failure',
      `member=${memberId} consecutive=${count} detail=${detail.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
    if (count >= 3) {
      mission.status = 'protocol_error';
      mission.protocolErrorMemberId = memberId;
      mission.interruptionReason = `protocol_error:${memberId}`;
      mission.interruptedAt = now;
      for (const workItem of this.taskCards.filter(item => (
        item.taskSessionId === mission.id
        && ['offered', 'accepted', 'active', 'waiting_dependency', 'waiting_collab'].includes(item.status)
      ))) {
        workItem.interruptedFromStatus = workItem.status;
        workItem.status = 'interrupted';
        workItem.updatedAt = now;
        workItem.revision = (workItem.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, mission, workItem);
      }
      this.appendMissionEvent(group, mission, 'mission.protocol_error', `member=${memberId}`);
    }
    this.writeMissionFiles(group, mission);
    this.save();
    return count;
  }

  clearProtocolFailures(groupId: string, missionId: string, memberId: string) {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') return;
    if (!mission.protocolFailureCounts?.[memberId]) return;
    mission.protocolFailureCounts = { ...mission.protocolFailureCounts, [memberId]: 0 };
    mission.updatedAt = Date.now() / 1000;
    this.appendMissionEvent(group, mission, 'protocol.recovered', `member=${memberId}`);
    this.writeMissionFiles(group, mission);
    this.save();
  }

  requestMissionChanges(
    groupId: string,
    missionId: string,
    note: string,
  ): MissionOwnerActionResult {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'ready_for_owner') {
      throw new Error('只有等待群主处理的任务可以要求修改');
    }
    if (!trimmedNote) throw new Error('要求修改必须说明范围和验收预期');
    const developerPhase = (mission.phases ?? []).find(phase => phase.roleId === 'role-developer');
    const developerMember = developerPhase?.leaderMemberId
      ? group.members.find(member => member.id === developerPhase.leaderMemberId)
      : undefined;
    if (!developerPhase || !developerMember) throw new Error('任务没有可用的技术 Leader，无法进入修改闭环');
    const now = Date.now() / 1000;
    for (const phase of mission.phases ?? []) {
      if (phase.status === 'waived' || phase.status === 'missing') continue;
      if (phase.id === developerPhase.id) phase.status = 'active';
      else if (phase.order > developerPhase.order) phase.status = 'planned';
    }
    const previous = this.taskCards
      .filter(item => item.taskSessionId === mission.id)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (group.workingDirectory) {
      this.writeRequirementsRevision(group, mission, Buffer.from([
        `# ${mission.title}`,
        '',
        '## 当前目标',
        '',
        mission.objective ?? '',
        '',
        '## 原验收标准',
        '',
        ...(mission.acceptanceCriteria ?? []).map(item => `- ${item}`),
        '',
        '## 群主本轮修改要求',
        '',
        trimmedNote,
        '',
      ].join('\n')));
    }
    const workItem = createMissionWorkItem(mission, developerPhase, developerMember, developerMember.agentId);
    workItem.kind = 'rework';
    workItem.requirementsRevision = mission.currentRequirementsRevision;
    workItem.implementationRevisionId = mission.currentImplementationRevisionId;
    workItem.description = `群主要求修改：${trimmedNote}`;
    if (previous) workItem.dependsOn = [previous.id];
    this.taskCards.push(workItem);
    mission.status = 'active';
    mission.currentPhaseId = developerPhase.id;
    mission.reworkRound = (mission.reworkRound ?? 0) + 1;
    if ((mission.reworkRound ?? 0) > (mission.maxReworkRounds ?? 3)) {
      mission.maxReworkRounds = mission.reworkRound;
    }
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    this.recordOwnerDecision(mission, 'request_changes', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.writeWorkItemFiles(group, mission, workItem);
    this.appendMissionEvent(group, mission, 'mission.changes_requested', `workItem=${workItem.id} ${trimmedNote}`);
    this.save();
    return { mission, workItem };
  }

  reassignMissionWorkItem(
    groupId: string,
    missionId: string,
    workItemId: string,
    targetMemberId: string,
    note: string,
  ): MissionOwnerActionResult {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const source = this.taskCardById(workItemId);
    const trimmedNote = note.trim();
    if (
      !group
      || !mission
      || !source
      || mission.groupId !== group.id
      || source.taskSessionId !== mission.id
      || mission.kind !== 'mission'
    ) {
      throw new Error('mission or work item not found');
    }
    if (['completed', 'cancelled', 'archived'].includes(mission.status) || isTaskTerminal(source)) {
      throw new Error('已结束的任务或工作项不能改派');
    }
    if (!trimmedNote) throw new Error('改派必须说明原因和交接要求');
    const target = group.members.find(member => member.id === targetMemberId);
    if (!target || target.roleId !== source.roleId) throw new Error('工作项只能改派给同一角色成员');
    if (target.id === source.ownerMemberId) throw new Error('新负责人必须与当前负责人不同');
    const phase = (mission.phases ?? []).find(item => item.id === source.phaseId);
    if (!phase) throw new Error('工作项对应的阶段不存在');
    const now = Date.now() / 1000;
    const workItem = createMissionWorkItem(mission, phase, target, target.agentId);
    workItem.title = source.title;
    workItem.description = `${source.description}\n\n群主改派说明：${trimmedNote}`;
    workItem.kind = source.kind;
    workItem.dependsOn = [...new Set([...(source.dependsOn ?? []), source.id])];
    workItem.parentWorkItemId = source.parentWorkItemId;
    workItem.returnIssueId = source.returnIssueId;
    workItem.returnToPhaseId = source.returnToPhaseId;
    workItem.implementationRevisionId = source.implementationRevisionId;
    workItem.requirementsRevision = source.requirementsRevision;
    workItem.discussionRound = source.discussionRound;
    workItem.discussionStage = source.discussionStage;
    workItem.reassignedFromWorkItemId = source.id;
    source.status = 'cancelled';
    source.completedAt = now;
    source.updatedAt = now;
    source.reassignedToWorkItemId = workItem.id;
    source.revision = (source.revision ?? 0) + 1;
    for (const child of this.taskCards.filter(item => item.parentWorkItemId === source.id)) {
      child.parentWorkItemId = workItem.id;
      child.updatedAt = now;
      child.revision = (child.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, child);
    }
    this.taskCards.push(workItem);
    if (source.ownerMemberId === mission.leaderSnapshot?.[source.roleId ?? '']) {
      phase.leaderMemberId = target.id;
      mission.leaderSnapshot = { ...(mission.leaderSnapshot ?? {}), [source.roleId!]: target.id };
    }
    mission.status = 'active';
    mission.currentPhaseId = phase.id;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    this.recordOwnerDecision(mission, 'reassign', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.writeWorkItemFiles(group, mission, source);
    this.writeWorkItemFiles(group, mission, workItem);
    this.appendMissionEvent(
      group,
      mission,
      'work.reassigned',
      `from=${source.id} to=${workItem.id} member=${target.id} ${trimmedNote}`,
    );
    this.save();
    return { mission, workItem };
  }

  acceptMissionRisk(
    groupId: string,
    missionId: string,
    issueIds: string[],
    note: string,
  ): MissionOwnerActionResult {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (!['waiting_human', 'ready_for_owner'].includes(mission.status)) {
      throw new Error('只有等待群主决策的任务可以接受风险');
    }
    if (!trimmedNote) throw new Error('接受风险必须记录依据和后续安排');
    const uniqueIds = [...new Set(issueIds.map(id => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) throw new Error('至少选择一个待处理问题');
    const selected = uniqueIds.map(issueId => {
      const issue = this.issues.find(item => item.missionId === mission.id && item.id === issueId);
      if (!issue) throw new Error(`质量问题 ${issueId} 不存在`);
      if (!['open', 'reopened'].includes(issue.status)) {
        throw new Error(`质量问题 ${issueId} 当前不能接受风险`);
      }
      return issue;
    });
    const now = Date.now() / 1000;
    for (const issue of selected) {
      issue.status = 'accepted_risk';
      issue.revision = (issue.revision ?? 1) + 1;
      issue.resolution = trimmedNote;
      issue.resolvedAt = now;
      issue.updatedAt = now;
      this.writeIssueFile(group, mission, issue);
    }

    let workItem: TaskCard | undefined;
    let collaborationWorkItems: TaskCard[] | undefined;
    const blockingSeverities = new Set(
      mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major'],
    );
    const remainingBlockers = this.issues.filter(issue => (
      issue.missionId === mission.id
      && blockingSeverities.has(issue.severity)
      && ['open', 'reopened'].includes(issue.status)
    ));
    if (mission.status === 'waiting_human' && remainingBlockers.length === 0) {
      const checkpoint = this.taskCards
        .filter(item => (
          item.taskSessionId === mission.id
          && item.status === 'changes_requested'
          && ['role-code-reviewer', 'role-tester'].includes(item.roleId ?? '')
        ))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const checkpointPhase = checkpoint?.phaseId
        ? (mission.phases ?? []).find(phase => phase.id === checkpoint.phaseId)
        : undefined;
      if (checkpoint && checkpointPhase) {
        checkpoint.status = 'completed';
        checkpoint.completedAt = now;
        checkpoint.updatedAt = now;
        checkpoint.revision = (checkpoint.revision ?? 0) + 1;
        checkpointPhase.status = 'passed';
        this.writeWorkItemFiles(group, mission, checkpoint);
        const nextPhase = (mission.phases ?? [])
          .filter(phase => phase.status === 'planned' && phase.order > checkpointPhase.order)
          .sort((a, b) => a.order - b.order)[0];
        const nextMember = nextPhase?.leaderMemberId
          ? group.members.find(member => member.id === nextPhase.leaderMemberId)
          : undefined;
        if (nextPhase && nextMember) {
          workItem = createMissionWorkItem(mission, nextPhase, nextMember, nextMember.agentId);
          workItem.dependsOn = [checkpoint.id];
          this.taskCards.push(workItem);
          collaborationWorkItems = this.createPhaseCollaborationWorkItems(
            group,
            mission,
            nextPhase,
            workItem,
          );
          mission.status = 'active';
          mission.currentPhaseId = checkpointPhase.id;
          this.writeWorkItemFiles(group, mission, workItem);
          for (const collaboration of collaborationWorkItems) {
            this.writeWorkItemFiles(group, mission, collaboration);
          }
        } else {
          mission.status = 'ready_for_owner';
        }
      }
    }
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    this.recordOwnerDecision(mission, 'accept_risk', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.risk_accepted',
      `issues=${uniqueIds.join(',')} ${trimmedNote}`,
    );
    this.save();
    return { mission, workItem, collaborationWorkItems };
  }

  extendMissionRework(
    groupId: string,
    missionId: string,
    additionalRounds: number,
    note: string,
  ): MissionOwnerActionResult {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'waiting_human' || !mission.interruptionReason?.includes('fuse')) {
      throw new Error('只有触发返工熔断的任务可以追加轮次');
    }
    if (!Number.isInteger(additionalRounds) || additionalRounds < 1 || additionalRounds > 10) {
      throw new Error('追加返工轮次必须是 1 到 10 的整数');
    }
    if (!trimmedNote) throw new Error('追加返工轮次必须说明理由和收敛条件');
    const checkpoint = this.taskCards
      .filter(item => (
        item.taskSessionId === mission.id
        && item.status === 'changes_requested'
        && ['role-code-reviewer', 'role-tester'].includes(item.roleId ?? '')
      ))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const issue = checkpoint
      ? this.issues.find(item => (
        item.missionId === mission.id
        && item.workItemId === checkpoint.id
        && ['open', 'reopened'].includes(item.status)
      ))
      : undefined;
    const qualityPhase = checkpoint?.phaseId
      ? (mission.phases ?? []).find(phase => phase.id === checkpoint.phaseId)
      : undefined;
    const developerPhase = (mission.phases ?? []).find(phase => phase.roleId === 'role-developer');
    const developerMember = developerPhase?.leaderMemberId
      ? group.members.find(member => member.id === developerPhase.leaderMemberId)
      : undefined;
    if (!checkpoint || !issue || !qualityPhase || !developerPhase || !developerMember) {
      throw new Error('返工熔断现场不完整，无法自动追加轮次');
    }
    const now = Date.now() / 1000;
    mission.maxReworkRounds = (mission.maxReworkRounds ?? 3) + additionalRounds;
    mission.reworkRound = (mission.reworkRound ?? 0) + 1;
    developerPhase.status = 'active';
    qualityPhase.status = 'blocked';
    const workItem = createMissionWorkItem(mission, developerPhase, developerMember, developerMember.agentId);
    workItem.kind = 'rework';
    workItem.requirementsRevision = mission.currentRequirementsRevision;
    workItem.implementationRevisionId = mission.currentImplementationRevisionId;
    workItem.parentWorkItemId = checkpoint.id;
    workItem.returnIssueId = issue.id;
    workItem.returnToPhaseId = qualityPhase.id;
    workItem.dependsOn = [checkpoint.id];
    workItem.description = `${workItem.description}\n\n群主追加返工：${trimmedNote}`;
    this.taskCards.push(workItem);
    mission.status = 'active';
    mission.currentPhaseId = developerPhase.id;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    this.recordOwnerDecision(mission, 'extend_rework', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.writeWorkItemFiles(group, mission, workItem);
    this.appendMissionEvent(
      group,
      mission,
      'mission.rework_extended',
      `additional=${additionalRounds} workItem=${workItem.id} ${trimmedNote}`,
    );
    this.save();
    return { mission, workItem };
  }

  resolveExternalChanges(
    groupId: string,
    missionId: string,
    decision: ExternalChangeDecision,
    note: string,
  ): MissionOwnerActionResult {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'external_change_detected') {
      throw new Error('只有检测到外部变更的任务可以执行该决策');
    }
    if (!trimmedNote) throw new Error('外部变更决策必须记录核对结果和理由');
    if (!mission.gitBaseline || !mission.currentImplementationRevisionId) {
      throw new Error('外部变更现场缺少已批准实现修订');
    }

    const now = Date.now() / 1000;
    if (decision === 'discard') {
      this.restoreApprovedImplementationRevision(group, mission);
      for (const workItem of this.taskCards.filter(item => item.taskSessionId === mission.id)) {
        if (workItem.status !== 'interrupted') continue;
        workItem.status = workItem.interruptedFromStatus ?? 'offered';
        delete workItem.interruptedFromStatus;
        workItem.updatedAt = now;
        workItem.revision = (workItem.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, mission, workItem);
      }
      mission.status = 'active';
      mission.updatedAt = now;
      mission.revision = (mission.revision ?? 0) + 1;
      delete mission.interruptionReason;
      delete mission.interruptedAt;
      this.recordOwnerDecision(mission, 'discard_external_changes', trimmedNote, now);
      this.writeMissionFiles(group, mission);
      this.appendMissionEvent(group, mission, 'mission.external_changes_discarded', trimmedNote);
      this.save();
      return { mission };
    }

    const developerPhase = (mission.phases ?? []).find(phase => phase.roleId === 'role-developer');
    const developerMember = developerPhase?.leaderMemberId
      ? group.members.find(member => member.id === developerPhase.leaderMemberId)
      : undefined;
    if (!developerPhase || !developerMember) {
      throw new Error('当前任务没有技术 Leader，不能纳入外部变更；请选择移除变更或取消任务');
    }
    const checkpoint = this.taskCards
      .filter(item => (
        item.taskSessionId === mission.id
        && item.phaseId !== developerPhase.id
        && !isTaskTerminal(item)
        && (!item.roleId || mission.leaderSnapshot?.[item.roleId] === item.ownerMemberId)
      ))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!checkpoint?.phaseId) throw new Error('外部变更现场缺少可返回的下游工作项');
    const checkpointPhase = (mission.phases ?? []).find(phase => phase.id === checkpoint.phaseId);
    if (!checkpointPhase) throw new Error('外部变更现场缺少下游阶段');

    for (const item of this.taskCards.filter(candidate => (
      candidate.taskSessionId === mission.id
      && candidate.phaseId === checkpointPhase.id
      && candidate.id !== checkpoint.id
      && !isTaskTerminal(candidate)
    ))) {
      item.status = 'cancelled';
      delete item.interruptedFromStatus;
      item.updatedAt = now;
      item.revision = (item.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, item);
    }
    checkpoint.status = 'changes_requested';
    delete checkpoint.interruptedFromStatus;
    checkpoint.updatedAt = now;
    checkpoint.revision = (checkpoint.revision ?? 0) + 1;
    checkpointPhase.status = 'blocked';
    developerPhase.status = 'active';
    const workItem = createMissionWorkItem(mission, developerPhase, developerMember, developerMember.agentId);
    workItem.kind = 'rework';
    workItem.parentWorkItemId = checkpoint.id;
    workItem.returnToPhaseId = checkpointPhase.id;
    workItem.dependsOn = [checkpoint.id];
    workItem.requirementsRevision = mission.currentRequirementsRevision;
    workItem.implementationRevisionId = mission.currentImplementationRevisionId;
    workItem.description = [
      workItem.description,
      '',
      '群主选择纳入外部变更。技术 Leader 必须先核对完整 diff，再生成新的不可覆盖实现修订；不得直接沿用旧修订。',
      '',
      `群主说明：${trimmedNote}`,
    ].join('\n');
    this.taskCards.push(workItem);
    mission.status = 'active';
    mission.currentPhaseId = developerPhase.id;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    this.recordOwnerDecision(mission, 'incorporate_external_changes', trimmedNote, now);
    this.writeWorkItemFiles(group, mission, checkpoint);
    this.writeWorkItemFiles(group, mission, workItem);
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.external_changes_incorporation_requested',
      `workItem=${workItem.id} returnTo=${checkpoint.id} ${trimmedNote}`,
    );
    this.save();
    return { mission, workItem };
  }

  resumeMission(groupId: string, missionId: string, note: string): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status === 'external_change_detected') {
      throw new Error('检测到外部变更时必须明确选择纳入变更、移除变更或取消任务，不能直接恢复');
    }
    const ownerPaused = mission.status === 'waiting_human' && mission.interruptionReason === 'owner_paused';
    const requiredMemberOffline = mission.status === 'waiting_human'
      && mission.interruptionReason?.startsWith('required_member_offline:');
    const ownerAttention = mission.status === 'waiting_human'
      && mission.interruptionReason?.startsWith('owner_attention:');
    if (
      !ownerPaused
      && !requiredMemberOffline
      && !ownerAttention
      && !['interrupted', 'stalled', 'protocol_error'].includes(mission.status)
    ) {
      throw new Error('只有已暂停、中断、停滞或协议异常的任务可以恢复');
    }
    if (!trimmedNote) throw new Error('恢复任务必须记录工作区与外部状态核对结果');
    const now = Date.now() / 1000;
    for (const workItem of this.taskCards.filter(item => item.taskSessionId === mission.id)) {
      if (![
        'interrupted',
        'stalled',
        'waiting_human',
        'pending_human_verification',
      ].includes(workItem.status)) continue;
      workItem.status = workItem.resumeStatus ?? workItem.interruptedFromStatus ?? 'offered';
      delete workItem.resumeStatus;
      delete workItem.interruptedFromStatus;
      workItem.updatedAt = now;
      workItem.revision = (workItem.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, workItem);
    }
    mission.status = 'active';
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    if (mission.protocolErrorMemberId) {
      mission.protocolFailureCounts = {
        ...(mission.protocolFailureCounts ?? {}),
        [mission.protocolErrorMemberId]: 0,
      };
      delete mission.protocolErrorMemberId;
    }
    this.recordOwnerDecision(mission, 'resume', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.resumed', trimmedNote);
    this.save();
    return mission;
  }

  cancelMission(groupId: string, missionId: string, note: string): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (['completed', 'cancelled', 'archived'].includes(mission.status)) {
      throw new Error('任务已经结束');
    }
    if (!trimmedNote) throw new Error('取消任务必须说明原因');
    const now = Date.now() / 1000;
    for (const workItem of this.taskCards.filter(item => (
      item.taskSessionId === mission.id && !isTaskTerminal(item)
    ))) {
      workItem.status = 'cancelled';
      workItem.updatedAt = now;
      workItem.completedAt = now;
      workItem.revision = (workItem.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, workItem);
    }
    mission.status = 'cancelled';
    mission.cancelledAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    this.recordOwnerDecision(mission, 'cancel', trimmedNote, now);
    if (group.activeTaskSessionId === mission.id) delete group.activeTaskSessionId;
    for (const paused of this.groups) {
      if (paused.pausedByMissionId === mission.id) delete paused.pausedByMissionId;
    }
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.cancelled', trimmedNote);
    this.save();
    return mission;
  }

  completeMission(groupId: string, missionId: string, note: string): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'ready_for_owner') {
      throw new Error('只有等待群主处理的任务可以完成');
    }
    if (!trimmedNote) throw new Error('完成任务必须记录验收、合并或接受结论');
    const now = Date.now() / 1000;
    mission.status = 'completed';
    mission.completedAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    this.recordOwnerDecision(mission, 'complete', trimmedNote, now);
    if (group.activeTaskSessionId === mission.id) delete group.activeTaskSessionId;
    for (const paused of this.groups) {
      if (paused.pausedByMissionId === mission.id) delete paused.pausedByMissionId;
    }
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(group, mission, 'mission.completed', trimmedNote);
    this.save();
    return mission;
  }

  evaluateCollaborationTimeouts(now = Date.now() / 1000): CollaborationTimeoutResult {
    const result: CollaborationTimeoutResult = {
      unresponsive: [],
      progressReminders: [],
      stalled: [],
    };
    const changedMissions = new Set<string>();
    for (const workItem of this.taskCards) {
      const mission = workItem.taskSessionId ? this.taskSessionById(workItem.taskSessionId) : undefined;
      const group = mission ? this.groupById(mission.groupId) : undefined;
      if (!mission || !group || mission.kind !== 'mission' || mission.status !== 'active') continue;
      let changed = false;
      if (
        workItem.status === 'offered'
        && workItem.offeredAt
        && now - workItem.offeredAt >= 3 * 60
        && !workItem.unresponsiveAt
      ) {
        workItem.unresponsiveAt = now;
        result.unresponsive.push(workItem);
        this.appendMissionEvent(group, mission, 'work.unresponsive', `workItem=${workItem.id}`);
        changed = true;
      }
      if (workItem.status === 'active') {
        const progressBase = workItem.lastProgressAt ?? workItem.startedAt ?? workItem.updatedAt;
        const idleSeconds = now - progressBase;
        if (idleSeconds >= 15 * 60 && !workItem.progressReminderAt) {
          workItem.progressReminderAt = now;
          result.progressReminders.push(workItem);
          this.appendMissionEvent(group, mission, 'work.progress_reminder', `workItem=${workItem.id}`);
          changed = true;
        }
        if (idleSeconds >= 30 * 60 && !workItem.stalledAt) {
          workItem.stalledAt = now;
          workItem.interruptedFromStatus = 'active';
          workItem.status = 'stalled';
          mission.status = 'stalled';
          mission.interruptionReason = `work_item_stalled:${workItem.id}`;
          mission.interruptedAt = now;
          result.stalled.push(workItem);
          this.appendMissionEvent(group, mission, 'work.stalled', `workItem=${workItem.id}`);
          changed = true;
        }
      }
      if (changed) {
        workItem.updatedAt = now;
        workItem.revision = (workItem.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, mission, workItem);
        changedMissions.add(mission.id);
      }
    }
    for (const missionId of changedMissions) {
      const mission = this.taskSessionById(missionId);
      const group = mission ? this.groupById(mission.groupId) : undefined;
      if (!mission || !group) continue;
      mission.updatedAt = now;
      mission.revision = (mission.revision ?? 0) + 1;
      this.writeMissionFiles(group, mission);
    }
    if (changedMissions.size > 0) this.save();
    return result;
  }

  private recordOwnerDecision(
    mission: TaskSession,
    action: MissionOwnerDecision['action'],
    note: string,
    decidedAt: number,
  ) {
    mission.ownerDecisionHistory = [
      ...(mission.ownerDecisionHistory ?? []),
      { action, note, decidedAt },
    ];
  }

  resolveMissingRole(
    groupId: string,
    missionId: string,
    roleId: string,
    resolution: MissingRoleResolution,
    note: string,
  ): TaskSession {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (mission.status !== 'draft') throw new Error('只有草稿任务可以处理缺岗');
    const phase = (mission.phases ?? []).find(item => item.roleId === roleId);
    if (!phase || phase.status !== 'missing') throw new Error('该角色当前不是缺岗状态');
    if (!MISSING_ROLE_RESOLUTIONS[roleId]?.includes(resolution)) {
      throw new Error(`角色「${roleById(roleId)?.name ?? roleId}」不允许使用该缺岗处理方式`);
    }
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new Error('缺岗决策必须说明原因和风险');

    const now = Date.now() / 1000;
    phase.status = 'waived';
    phase.required = false;
    mission.missingRoleDecisions = [
      ...(mission.missingRoleDecisions ?? []).filter(decision => decision.roleId !== roleId),
      { roleId, resolution, note: trimmedNote, decidedAt: now },
    ];
    if (roleId === 'role-product-manager' && resolution === 'owner_supplies') {
      this.freezeOwnerRequirements(group, mission);
    }
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = now;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.missing_role_resolved',
      `roleId=${roleId} resolution=${resolution}`,
    );
    this.save();
    return mission;
  }

  setMissionGitBaseline(groupId: string, missionId: string, baseline: MissionGitBaseline) {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (!['draft', 'preparing'].includes(mission.status)) throw new Error('只能为草稿或准备中的任务准备 Git 分支');
    mission.gitBaseline = baseline;
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.git_prepared',
      `branch=${baseline.taskBranch} base=${baseline.baseCommit}`,
    );
    this.save();
    return mission;
  }

  recordBaselineImplementationRevision(groupId: string, missionId: string) {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    if (!['draft', 'preparing'].includes(mission.status)) {
      throw new Error('只能在任务启动前冻结基线实现修订');
    }
    if (!mission.gitBaseline || !group.workingDirectory) throw new Error('任务缺少 Git 基线');
    if (mission.currentImplementationRevisionId) {
      const existing = (mission.implementationRevisions ?? []).find(
        revision => revision.id === mission.currentImplementationRevisionId,
      );
      if (!existing) throw new Error('当前实现修订引用无效');
      return { mission, revision: existing };
    }
    if ((mission.implementationRevisions ?? []).length > 0) {
      throw new Error('存在未激活的实现修订，不能创建基线修订');
    }
    const patch = Buffer.alloc(0);
    const revisionDir = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'revisions',
    );
    fs.mkdirSync(revisionDir, { recursive: true });
    const revision: ImplementationRevision = {
      id: 'R000',
      baseCommit: mission.gitBaseline.baseCommit,
      branch: mission.gitBaseline.taskBranch,
      contentHash: createHash('sha256').update(patch).digest('hex'),
      changedFiles: [],
      patchArtifact: 'R000.patch',
      manifestArtifact: 'R000.md',
      createdAt: Date.now() / 1000,
    };
    fs.writeFileSync(path.join(revisionDir, revision.patchArtifact), patch);
    fs.writeFileSync(
      path.join(revisionDir, revision.manifestArtifact),
      [
        '---',
        `id: ${revision.id}`,
        `baseCommit: ${revision.baseCommit}`,
        `branch: ${revision.branch}`,
        `contentHash: ${revision.contentHash}`,
        '---',
        '',
        '# 基线实现修订 R000',
        '',
        '该只读修订绑定任务启动时的 Git 基线，供独立代码审查或测试任务使用。',
      ].join('\n'),
      'utf-8',
    );
    mission.implementationRevisions = [revision];
    mission.currentImplementationRevisionId = revision.id;
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'implementation.baseline_revision_created',
      `id=${revision.id} hash=${revision.contentHash}`,
    );
    this.save();
    return { mission, revision };
  }

  recordImplementationRevision(
    groupId: string,
    missionId: string,
    workItemId: string,
    actorAgentId: string,
    snapshot: GitRevisionSnapshot,
  ): { mission: TaskSession; workItem: TaskCard; revision: ImplementationRevision } {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const workItem = this.taskCardById(workItemId);
    if (
      !group
      || !mission
      || !workItem
      || mission.groupId !== group.id
      || workItem.taskSessionId !== mission.id
    ) {
      throw new Error('任务或研发工作项不存在');
    }
    const actorMember = group.members.find(member => member.agentId === actorAgentId);
    if (
      !actorMember
      || actorMember.id !== workItem.ownerMemberId
      || actorMember.roleId !== 'role-developer'
      || mission.leaderSnapshot?.['role-developer'] !== actorMember.id
    ) {
      throw new Error('只有当前任务的技术 Leader 可以生成实现修订');
    }
    if (workItem.status !== 'active') throw new Error('只有进行中的研发工作项可以生成实现修订');
    const revision = this.persistImplementationRevision(group, mission, snapshot);
    this.save();
    return { mission, workItem, revision };
  }

  recordExternalImplementationRevision(
    groupId: string,
    missionId: string,
    note: string,
    snapshot: GitRevisionSnapshot,
  ): MissionOwnerActionResult & { revision: ImplementationRevision } {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(missionId);
    const trimmedNote = note.trim();
    if (!group || !mission || mission.groupId !== group.id || mission.kind !== 'mission') {
      throw new Error('mission not found');
    }
    const externalDecision = (mission.missingRoleDecisions ?? []).some(decision => (
      decision.roleId === 'role-developer' && decision.resolution === 'external_implementation'
    ));
    if (!externalDecision) throw new Error('当前任务没有“群主外部实现后导入”的缺岗决策');
    if (
      mission.status !== 'waiting_human'
      || mission.interruptionReason !== 'awaiting_external_implementation'
    ) {
      throw new Error('当前任务没有等待导入外部实现');
    }
    if (!trimmedNote) throw new Error('导入外部实现必须记录来源、范围和核对结果');

    const revision = this.persistImplementationRevision(group, mission, snapshot);
    const now = Date.now() / 1000;
    const resumedItems = this.taskCards.filter(item => (
      item.taskSessionId === mission.id
      && item.status === 'waiting_human'
      && item.resumeStatus === 'offered'
    ));
    let workItem: TaskCard | undefined;
    let collaborationWorkItems: TaskCard[] | undefined;
    if (resumedItems.length > 0) {
      for (const item of resumedItems) {
        item.status = 'offered';
        delete item.resumeStatus;
        item.requirementsRevision = mission.currentRequirementsRevision;
        item.implementationRevisionId = revision.id;
        item.contextRevision = (item.contextRevision ?? 0) + 1;
        item.updatedAt = now;
        item.revision = (item.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, mission, item);
      }
      workItem = resumedItems.find(item => (
        !!item.roleId && mission.leaderSnapshot?.[item.roleId] === item.ownerMemberId
      )) ?? resumedItems[0];
      collaborationWorkItems = resumedItems.filter(item => item.id !== workItem?.id);
      mission.status = 'active';
    } else {
      const developerPhase = (mission.phases ?? []).find(phase => phase.roleId === 'role-developer');
      const source = this.taskCards
        .filter(item => item.taskSessionId === mission.id && item.status === 'submitted')
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const sourcePhase = source?.phaseId
        ? (mission.phases ?? []).find(phase => phase.id === source.phaseId)
        : undefined;
      if (!developerPhase) throw new Error('等待外部实现的研发阶段不存在');
      if (!source || !sourcePhase) {
        if (!(mission.phases ?? []).every(phase => phase.status === 'waived')) {
          throw new Error('等待外部实现的交接现场不完整');
        }
        mission.status = 'ready_for_owner';
      } else {
        source.status = 'completed';
        source.completedAt = now;
        source.updatedAt = now;
        source.revision = (source.revision ?? 0) + 1;
        sourcePhase.status = 'passed';
        const nextPhase = (mission.phases ?? [])
          .filter(phase => phase.status === 'planned' && phase.order > developerPhase.order)
          .sort((a, b) => a.order - b.order)[0];
        const nextMember = nextPhase?.leaderMemberId
          ? group.members.find(member => member.id === nextPhase.leaderMemberId)
          : undefined;
        if (nextPhase && nextMember) {
          workItem = createMissionWorkItem(mission, nextPhase, nextMember, nextMember.agentId);
          workItem.dependsOn = [source.id];
          workItem.requirementsRevision = mission.currentRequirementsRevision;
          workItem.implementationRevisionId = revision.id;
          if (nextPhase.roleId === 'role-code-reviewer') workItem.kind = 'review';
          if (nextPhase.roleId === 'role-tester') workItem.kind = 'test';
          this.taskCards.push(workItem);
          collaborationWorkItems = this.createPhaseCollaborationWorkItems(
            group,
            mission,
            nextPhase,
            workItem,
          );
          mission.status = 'active';
          this.writeWorkItemFiles(group, mission, workItem);
          for (const collaboration of collaborationWorkItems) {
            this.writeWorkItemFiles(group, mission, collaboration);
          }
        } else {
          mission.status = 'ready_for_owner';
        }
        this.writeWorkItemFiles(group, mission, source);
      }
    }
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    delete mission.interruptionReason;
    delete mission.interruptedAt;
    this.recordOwnerDecision(mission, 'import_external_implementation', trimmedNote, now);
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'implementation.external_imported',
      `revision=${revision.id} ${trimmedNote}`,
    );
    this.save();
    return { mission, workItem, collaborationWorkItems, revision };
  }

  applyCollaborationAction(
    groupId: string,
    actorAgentId: string,
    action: CollaborationControlAction,
  ): {
    mission: TaskSession;
    workItem: TaskCard;
    createdWorkItem?: TaskCard;
    createdWorkItems?: TaskCard[];
    issue?: CollaborationIssue;
    duplicate: boolean;
  } {
    const group = this.groupById(groupId);
    const mission = this.taskSessionById(action.missionId);
    const workItem = this.taskCardById(action.workItemId);
    if (
      !group
      || !mission
      || !workItem
      || mission.groupId !== group.id
      || workItem.groupId !== group.id
      || workItem.taskSessionId !== mission.id
    ) {
      throw new Error('协作请求引用的任务或工作项不存在');
    }
    if ((mission.processedRequestIds ?? []).includes(action.requestId)) {
      return { mission, workItem, duplicate: true };
    }
    if ((workItem.revision ?? 0) !== action.expectedRevision) {
      throw new Error(`工作项版本冲突：当前为 ${workItem.revision ?? 0}`);
    }
    const actorMember = group.members.find(member => member.agentId === actorAgentId);
    if (!actorMember || actorMember.id !== workItem.ownerMemberId) {
      throw new Error('只有当前工作项负责人可以执行该操作');
    }
    const verifiesApprovedWorkspace = (
      action.action === 'work.accept'
      && ['role-code-reviewer', 'role-tester', 'role-committer'].includes(workItem.roleId ?? '')
    ) || ['stage.pass', 'mission.ready_for_owner'].includes(action.action);
    if (verifiesApprovedWorkspace) {
      this.assertWorkspaceMatchesApprovedRevision(group, mission);
    }
    const now = Date.now() / 1000;
    let createdWorkItem: TaskCard | undefined;
    let createdWorkItems: TaskCard[] | undefined;
    let issue: CollaborationIssue | undefined;
    const affectedWorkItems: TaskCard[] = [];
    switch (action.action) {
      case 'work.accept': {
        if (workItem.status !== 'offered') throw new Error('只有待接受的工作项可以接受');
        if (action.contextRevision !== (workItem.contextRevision ?? 0)) {
          throw new Error(`交接包版本冲突：当前为 ${workItem.contextRevision ?? 0}`);
        }
        workItem.status = 'accepted';
        workItem.acceptedAt = now;
        const sourceWorkItem = workItem.dependsOn?.length === 1
          ? this.taskCardById(workItem.dependsOn[0])
          : undefined;
        if (
          sourceWorkItem
          && workItem.kind !== 'rework'
          && sourceWorkItem.phaseId !== workItem.phaseId
        ) {
          const sourcePhase = (mission.phases ?? []).find(phase => phase.id === sourceWorkItem.phaseId);
          const targetPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
          if (!targetPhase) throw new Error('待接受工作项对应的目标阶段不存在');
          sourceWorkItem.status = 'completed';
          sourceWorkItem.nextStep = workItem.id;
          if (sourcePhase) sourcePhase.status = 'passed';
          targetPhase.status = 'active';
          mission.currentPhaseId = targetPhase.id;
          mission.status = 'active';
          affectedWorkItems.push(sourceWorkItem);
        }
        break;
      }
      case 'work.reject': {
        if (workItem.status !== 'offered') throw new Error('只有待接受的工作项可以拒绝');
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('拒绝工作项必须说明原因');
        workItem.status = 'cancelled';
        workItem.evidence = summary;
        const sourceWorkItem = workItem.dependsOn?.length === 1
          ? this.taskCardById(workItem.dependsOn[0])
          : undefined;
        if (sourceWorkItem) {
          const sourcePhase = (mission.phases ?? []).find(phase => phase.id === sourceWorkItem.phaseId);
          const targetPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
          sourceWorkItem.status = 'submitted';
          sourceWorkItem.nextStep = `交接被拒绝：${summary}`;
          if (sourcePhase) sourcePhase.status = 'active';
          if (targetPhase && targetPhase.status !== 'blocked') targetPhase.status = 'planned';
          mission.currentPhaseId = sourcePhase?.id;
          affectedWorkItems.push(sourceWorkItem);
        } else {
          mission.status = 'waiting_human';
        }
        break;
      }
      case 'work.clarify': {
        if (workItem.status !== 'offered') throw new Error('只有待接受的工作项可以请求澄清');
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('请求澄清必须列出具体问题');
        const sourceWorkItem = workItem.dependsOn?.length === 1
          ? this.taskCardById(workItem.dependsOn[0])
          : undefined;
        const sourceMember = sourceWorkItem?.ownerMemberId
          ? group.members.find(member => member.id === sourceWorkItem.ownerMemberId)
          : undefined;
        const sourcePhase = sourceWorkItem?.phaseId
          ? (mission.phases ?? []).find(phase => phase.id === sourceWorkItem.phaseId)
          : undefined;
        if (!sourceWorkItem || !sourceMember || !sourcePhase) {
          mission.status = 'waiting_human';
          throw new Error('当前交接缺少可负责澄清的上游工作项');
        }
        workItem.resumeStatus = 'offered';
        workItem.status = 'waiting_dependency';
        createdWorkItem = createMissionWorkItem(
          mission,
          sourcePhase,
          sourceMember,
          sourceMember.agentId,
        );
        createdWorkItem.kind = 'clarification';
        createdWorkItem.parentWorkItemId = workItem.id;
        createdWorkItem.title = `澄清：${workItem.title}`;
        createdWorkItem.description = summary;
        this.taskCards.push(createdWorkItem);
        break;
      }
      case 'work.started':
        if (workItem.status !== 'accepted') throw new Error('只有已接受的工作项可以开始');
        workItem.status = 'active';
        workItem.startedAt = now;
        workItem.lastProgressAt = now;
        break;
      case 'work.progress': {
        if (workItem.status !== 'active') throw new Error('只有进行中的工作项可以更新进度');
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('有效进度必须包含已完成内容和下一步摘要');
        workItem.progressSummary = summary;
        workItem.lastProgressAt = now;
        delete workItem.progressReminderAt;
        break;
      }
      case 'consultation.request':
      case 'clarification.request': {
        if (workItem.status !== 'active') throw new Error('只有进行中的工作项可以发起咨询或澄清');
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('咨询或澄清请求必须包含具体问题');
        const targetMember = this.resolveCollaborationTarget(group, mission, action);
        const targetPhase = (mission.phases ?? []).find(phase => phase.roleId === targetMember.roleId)
          ?? (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
        if (!targetPhase) throw new Error('无法为目标成员创建协作工作项');
        createdWorkItem = createMissionWorkItem(
          mission,
          targetPhase,
          targetMember,
          targetMember.agentId,
        );
        createdWorkItem.roleId = targetMember.roleId ?? undefined;
        createdWorkItem.phaseId = workItem.phaseId;
        createdWorkItem.kind = action.action === 'consultation.request'
          ? 'consultation'
          : 'clarification';
        createdWorkItem.parentWorkItemId = workItem.id;
        createdWorkItem.title = `${action.action === 'consultation.request' ? '咨询' : '澄清'}：${workItem.title}`;
        createdWorkItem.description = summary;
        this.taskCards.push(createdWorkItem);
        if (action.action === 'clarification.request') {
          workItem.resumeStatus = 'active';
          workItem.status = 'waiting_dependency';
        }
        break;
      }
      case 'work.submit': {
        if (workItem.status !== 'active') throw new Error('只有进行中的工作项可以提交');
        if (workItem.discussionStage === 'synthesis') {
          this.assertDiscussionReadyForSynthesis(workItem);
        }
        if (
          workItem.roleId === 'role-developer'
          && mission.gitBaseline
          && !['discussion', 'consultation', 'clarification'].includes(workItem.kind ?? '')
        ) {
          if (
            !mission.currentImplementationRevisionId
            || action.implementationRevisionId !== mission.currentImplementationRevisionId
          ) {
            throw new Error('研发提交必须引用当前实现修订');
          }
          workItem.implementationRevisionId = mission.currentImplementationRevisionId;
        }
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        workItem.status = ['consultation', 'clarification'].includes(workItem.kind ?? '')
          ? 'completed'
          : 'submitted';
        workItem.artifact = artifact;
        if (workItem.parentWorkItemId && ['consultation', 'clarification'].includes(workItem.kind ?? '')) {
          const parent = this.taskCardById(workItem.parentWorkItemId);
          if (parent) {
            parent.nextStep = `${workItem.kind === 'consultation' ? '咨询' : '澄清'}产物：${workItem.id}/${artifact}`;
            if (workItem.kind === 'clarification' && parent.status === 'waiting_dependency') {
              parent.status = parent.resumeStatus ?? 'active';
              parent.contextRevision = (parent.contextRevision ?? 0) + 1;
              delete parent.resumeStatus;
            }
            affectedWorkItems.push(parent);
          }
        }
        if (workItem.kind === 'discussion' && workItem.discussionRound === 1) {
          createdWorkItems = this.createDiscussionCritiqueRound(group, mission, workItem);
        }
        break;
      }
      case 'handoff.request': {
        if (workItem.status !== 'submitted') throw new Error('只有已提交的工作项可以正式交接');
        if (!workItem.roleId || mission.leaderSnapshot?.[workItem.roleId] !== actorMember.id) {
          throw new Error('只有当前角色 Leader 可以发起正式交接');
        }
        this.assertPhaseCollaboratorsSubmitted(workItem);
        const targetRole = ALL_ROLES.find(role => role.name === action.targetRole);
        if (!targetRole) throw new Error('交接目标必须是群内基础角色');
        this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        const currentPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
        const returnPhase = workItem.kind === 'rework' && workItem.returnToPhaseId
          ? (mission.phases ?? []).find(phase => phase.id === workItem.returnToPhaseId)
          : undefined;
        const nextPhase = returnPhase ?? (mission.phases ?? [])
          .filter(phase => phase.status === 'planned' && phase.order > (currentPhase?.order ?? 0))
          .sort((a, b) => a.order - b.order)[0];
        const externalDeveloperPhase = !returnPhase
          ? (mission.phases ?? []).find(phase => (
            phase.roleId === 'role-developer'
            && phase.status === 'waived'
            && phase.order > (currentPhase?.order ?? 0)
            && (!nextPhase || phase.order < nextPhase.order)
            && (mission.missingRoleDecisions ?? []).some(decision => (
              decision.roleId === phase.roleId && decision.resolution === 'external_implementation'
            ))
          ))
          : undefined;
        if (externalDeveloperPhase && !mission.currentImplementationRevisionId) {
          if (!currentPhase || targetRole.id !== 'role-developer') {
            throw new Error('正式交接必须先指向等待群主外部实现的研发阶段');
          }
          if (workItem.roleId === 'role-product-manager') {
            this.freezeRequirementsFromWorkItem(group, mission, workItem);
          }
          workItem.nextStep = action.artifact;
          mission.status = 'waiting_human';
          mission.interruptionReason = 'awaiting_external_implementation';
          mission.interruptedAt = now;
          break;
        }
        if (!currentPhase || !nextPhase || nextPhase.roleId !== targetRole.id) {
          throw new Error('正式交接必须指向阶段计划中的下一个角色');
        }
        if (!nextPhase.leaderMemberId) throw new Error('下一阶段没有可用 Leader');
        const nextOwner = group.members.find(member => member.id === nextPhase.leaderMemberId);
        if (!nextOwner) throw new Error('下一阶段 Leader 不在群内');
        if (
          workItem.roleId === 'role-product-manager'
          && nextPhase.roleId === 'role-developer'
        ) {
          this.freezeRequirementsFromWorkItem(group, mission, workItem);
        }
        workItem.nextStep = action.artifact;
        createdWorkItem = createMissionWorkItem(mission, nextPhase, nextOwner, nextOwner.agentId);
        if (nextPhase.roleId === 'role-code-reviewer') createdWorkItem.kind = 'review';
        if (nextPhase.roleId === 'role-tester') createdWorkItem.kind = 'test';
        createdWorkItem.implementationRevisionId = mission.currentImplementationRevisionId
          ?? workItem.implementationRevisionId;
        createdWorkItem.requirementsRevision = mission.currentRequirementsRevision
          || workItem.requirementsRevision;
        createdWorkItem.dependsOn = [workItem.id];
        this.taskCards.push(createdWorkItem);
        createdWorkItems = this.createPhaseCollaborationWorkItems(
          group,
          mission,
          nextPhase,
          createdWorkItem,
        );
        break;
      }
      case 'discussion.extend': {
        if (workItem.status !== 'active' || workItem.discussionStage !== 'synthesis') {
          throw new Error('只有进行中的讨论 Leader 汇总工作项可以追加讨论轮次');
        }
        if (!workItem.roleId || mission.leaderSnapshot?.[workItem.roleId] !== actorMember.id) {
          throw new Error('只有当前角色 Leader 可以追加讨论轮次');
        }
        const roundTwo = this.taskCards.filter(item => (
          item.parentWorkItemId === workItem.id
          && item.kind === 'discussion'
          && item.discussionRound === 2
        ));
        if (roundTwo.length === 0 || roundTwo.some(item => !['submitted', 'completed'].includes(item.status))) {
          throw new Error('第二轮交叉评议尚未全部提交');
        }
        if (this.taskCards.some(item => (
          item.parentWorkItemId === workItem.id
          && item.kind === 'discussion'
          && item.discussionRound === 3
        ))) {
          throw new Error('当前讨论已经追加过第三轮');
        }
        const focus = action.summary?.trim() ?? '';
        if (!focus) throw new Error('追加讨论轮次必须说明未决问题');
        createdWorkItems = this.createAdditionalDiscussionRound(
          group,
          mission,
          workItem,
          focus,
        );
        break;
      }
      case 'issue.report': {
        if (workItem.status !== 'active') throw new Error('只有进行中的质量工作项可以报告问题');
        if (!['role-code-reviewer', 'role-tester', 'role-committer'].includes(actorMember.roleId ?? '')) {
          throw new Error('只有代码审查、测试或提交角色可以报告质量问题');
        }
        const issueId = action.issueId?.trim() ?? '';
        const title = action.title?.trim() ?? '';
        const summary = action.summary?.trim() ?? '';
        const severity = action.severity as IssueSeverity | undefined;
        if (!/^[A-Za-z0-9._-]+$/.test(issueId)) throw new Error('issueId 格式无效');
        if (!title || !summary) throw new Error('质量问题必须包含标题和摘要');
        if (!severity || !['blocker', 'major', 'minor', 'suggestion'].includes(severity)) {
          throw new Error('质量问题严重度无效');
        }
        if (this.issues.some(item => item.missionId === mission.id && item.id === issueId)) {
          throw new Error(`质量问题 ${issueId} 已存在`);
        }
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        issue = {
          id: issueId,
          missionId: mission.id,
          groupId: group.id,
          workItemId: workItem.id,
          reporterMemberId: actorMember.id,
          roleId: actorMember.roleId ?? '',
          title,
          summary,
          severity,
          status: 'open',
          revision: 1,
          evidenceArtifact: artifact,
          requirementsRevision: workItem.requirementsRevision ?? mission.currentRequirementsRevision,
          implementationRevisionId: workItem.implementationRevisionId
            ?? mission.currentImplementationRevisionId,
          reopenCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.issues.push(issue);
        break;
      }
      case 'stage.pass': {
        if (workItem.status !== 'submitted') throw new Error('只有已提交的质量工作项可以签署通过');
        if (!workItem.roleId || mission.leaderSnapshot?.[workItem.roleId] !== actorMember.id) {
          throw new Error('只有当前角色 Leader 可以签署阶段通过');
        }
        if (!['role-code-reviewer', 'role-tester'].includes(workItem.roleId)) {
          throw new Error('只有代码审查或测试阶段使用质量通过操作');
        }
        if (
          !mission.currentRequirementsRevision
          || workItem.requirementsRevision !== mission.currentRequirementsRevision
        ) {
          throw new Error('质量结论必须绑定当前冻结需求版本');
        }
        if (
          !mission.currentImplementationRevisionId
          || workItem.implementationRevisionId !== mission.currentImplementationRevisionId
        ) {
          throw new Error('质量结论必须绑定当前批准实现修订');
        }
        this.assertPhaseCollaboratorsSubmitted(workItem);
        const blockingSeverities = new Set(
          mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major'],
        );
        const blockers = this.issues.filter(item => (
          item.missionId === mission.id
          && blockingSeverities.has(item.severity)
          && ['open', 'reopened'].includes(item.status)
        ));
        if (blockers.length > 0) {
          throw new Error(`存在未关闭的阻断问题：${blockers.map(item => item.id).join('、')}`);
        }
        const qualityArtifact = this.resolveWorkItemArtifact(
          group,
          mission,
          workItem,
          action.artifact,
        );
        const evidenceErrors = validateQualityEvidence(
          workItem.roleId,
          this.readWorkItemArtifact(group, mission, workItem, qualityArtifact),
        );
        if (evidenceErrors.length > 0) {
          throw new Error(`质量证据不完整：${evidenceErrors.join('；')}`);
        }
        const currentPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
        if (!currentPhase) throw new Error('当前质量阶段不存在');
        const nextPhase = (mission.phases ?? [])
          .filter(phase => phase.status === 'planned' && phase.order > currentPhase.order)
          .sort((a, b) => a.order - b.order)[0];
        currentPhase.status = 'passed';
        workItem.nextStep = action.artifact;
        if (nextPhase?.leaderMemberId) {
          const nextOwner = group.members.find(member => member.id === nextPhase.leaderMemberId);
          if (!nextOwner) throw new Error('下一阶段 Leader 不在群内');
          createdWorkItem = createMissionWorkItem(mission, nextPhase, nextOwner, nextOwner.agentId);
          createdWorkItem.implementationRevisionId = mission.currentImplementationRevisionId
            ?? workItem.implementationRevisionId;
          createdWorkItem.requirementsRevision = mission.currentRequirementsRevision
            || workItem.requirementsRevision;
          createdWorkItem.dependsOn = [workItem.id];
          this.taskCards.push(createdWorkItem);
          createdWorkItems = this.createPhaseCollaborationWorkItems(
            group,
            mission,
            nextPhase,
            createdWorkItem,
          );
        } else {
          workItem.status = 'completed';
          mission.status = 'ready_for_owner';
        }
        break;
      }
      case 'issue.resolve': {
        const issueId = action.issueId?.trim() ?? '';
        issue = this.issues.find(item => item.missionId === mission.id && item.id === issueId);
        if (!issue) throw new Error(`质量问题 ${issueId || '(空)'} 不存在`);
        if (!['open', 'reopened'].includes(issue.status)) throw new Error('只有未解决的问题可以关闭');
        if (mission.leaderSnapshot?.[issue.roleId] !== actorMember.id) {
          throw new Error('只有报告该问题的质量角色 Leader 可以签署解决');
        }
        const resolution = action.summary?.trim() ?? '';
        if (!resolution) throw new Error('解决问题必须提供验证摘要');
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        issue.status = 'resolved';
        issue.revision = (issue.revision ?? 1) + 1;
        issue.resolution = resolution;
        issue.evidenceArtifact = artifact;
        issue.resolvedAt = now;
        issue.updatedAt = now;
        break;
      }
      case 'issue.reopen': {
        const issueId = action.issueId?.trim() ?? '';
        issue = this.issues.find(item => item.missionId === mission.id && item.id === issueId);
        if (!issue) throw new Error(`质量问题 ${issueId || '(空)'} 不存在`);
        if (issue.status !== 'resolved') throw new Error('只有已解决的问题可以重新打开');
        if (mission.leaderSnapshot?.[issue.roleId] !== actorMember.id) {
          throw new Error('只有报告该问题的质量角色 Leader 可以重新打开');
        }
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('重新打开问题必须提供复现或回归摘要');
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        issue.status = 'reopened';
        issue.revision = (issue.revision ?? 1) + 1;
        issue.summary = `${issue.summary}\n\n重新打开：${summary}`;
        issue.evidenceArtifact = artifact;
        issue.reopenCount += 1;
        issue.updatedAt = now;
        delete issue.resolvedAt;
        delete issue.resolution;
        if (issue.reopenCount >= 2) {
          mission.status = 'waiting_human';
          mission.interruptionReason = `issue_reopen_fuse:${issue.id}`;
          mission.interruptedAt = now;
        }
        break;
      }
      case 'defect.return': {
        if (workItem.status !== 'submitted') throw new Error('只有已提交的质量工作项可以退回研发');
        if (
          !workItem.roleId
          || !['role-code-reviewer', 'role-tester', 'role-committer'].includes(workItem.roleId)
        ) {
          throw new Error('只有代码审查、测试或提交工作项可以退回缺陷');
        }
        if (mission.leaderSnapshot?.[workItem.roleId] !== actorMember.id) {
          throw new Error('只有当前质量角色 Leader 可以退回缺陷');
        }
        const targetRole = ALL_ROLES.find(role => role.name === action.targetRole);
        if (targetRole?.id !== 'role-developer') throw new Error('缺陷只能退回研发角色');
        issue = this.issues.find(item => (
          item.missionId === mission.id
          && item.id === action.issueId
          && ['open', 'reopened'].includes(item.status)
        ));
        if (!issue) throw new Error('退回缺陷必须引用当前任务中未解决的问题');
        this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        const qualityPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
        const developerPhase = (mission.phases ?? []).find(phase => phase.roleId === 'role-developer');
        const developerLeaderId = mission.leaderSnapshot?.['role-developer'];
        const developerMember = group.members.find(member => member.id === developerLeaderId);
        if (!qualityPhase || !developerPhase || !developerMember) {
          throw new Error('当前任务没有可用的技术 Leader');
        }
        workItem.status = 'changes_requested';
        qualityPhase.status = 'blocked';
        if ((mission.reworkRound ?? 0) >= (mission.maxReworkRounds ?? 3)) {
          mission.status = 'waiting_human';
          mission.interruptionReason = `rework_fuse:${issue.id}`;
          mission.interruptedAt = now;
          break;
        }
        developerPhase.status = 'active';
        mission.currentPhaseId = developerPhase.id;
        mission.reworkRound = (mission.reworkRound ?? 0) + 1;
        createdWorkItem = createMissionWorkItem(
          mission,
          developerPhase,
          developerMember,
          developerMember.agentId,
        );
        createdWorkItem.kind = 'rework';
        createdWorkItem.requirementsRevision = mission.currentRequirementsRevision;
        createdWorkItem.implementationRevisionId = mission.currentImplementationRevisionId;
        createdWorkItem.parentWorkItemId = workItem.id;
        createdWorkItem.returnIssueId = issue.id;
        createdWorkItem.returnToPhaseId = qualityPhase.id;
        createdWorkItem.dependsOn = [workItem.id];
        this.taskCards.push(createdWorkItem);
        break;
      }
      case 'mission.owner_attention': {
        if (isTaskTerminal(workItem)) throw new Error('已结束的工作项不能请求群主介入');
        const reasonCode = action.reasonCode as OwnerAttentionReason;
        if (![
          'scope_change',
          'major_risk',
          'missing_role_change',
          'external_verification',
          'external_action',
        ].includes(reasonCode)) {
          throw new Error('群主介入原因无效');
        }
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        const summary = action.summary?.trim() ?? '';
        workItem.resumeStatus = workItem.status;
        workItem.status = reasonCode === 'external_verification'
          ? 'pending_human_verification'
          : 'waiting_human';
        workItem.artifact = artifact;
        workItem.progressSummary = summary;
        mission.status = 'waiting_human';
        mission.interruptionReason = `owner_attention:${reasonCode}`;
        mission.interruptedAt = now;
        break;
      }
      case 'mission.ready_for_owner': {
        if (workItem.status !== 'submitted') throw new Error('只有已提交的最终工作项可以请求群主处理');
        if (!workItem.roleId || mission.leaderSnapshot?.[workItem.roleId] !== actorMember.id) {
          throw new Error('只有当前角色 Leader 可以结束自治流程');
        }
        this.assertPhaseCollaboratorsSubmitted(workItem);
        const currentPhase = (mission.phases ?? []).find(phase => phase.id === workItem.phaseId);
        const remainingPhase = (mission.phases ?? []).find(phase => (
          phase.required
          && !['passed', 'waived'].includes(phase.status)
          && phase.id !== currentPhase?.id
        ));
        if (remainingPhase) throw new Error(`仍有未完成阶段：${remainingPhase.name}`);
        const blockingSeverities = new Set(
          mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major'],
        );
        const blockers = this.issues.filter(item => (
          item.missionId === mission.id
          && blockingSeverities.has(item.severity)
          && ['open', 'reopened'].includes(item.status)
        ));
        if (blockers.length > 0) {
          throw new Error(`存在未关闭的阻断问题：${blockers.map(item => item.id).join('、')}`);
        }
        const summary = action.summary?.trim() ?? '';
        if (!summary) throw new Error('请求群主处理必须提供最终摘要和建议下一步');
        const artifact = this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        if (workItem.roleId === 'role-committer' && mission.gitBaseline) {
          this.verifyAndRecordSubmission(group, mission, action, now);
        }
        if (currentPhase) currentPhase.status = 'passed';
        workItem.status = 'completed';
        workItem.artifact = artifact;
        workItem.nextStep = summary;
        mission.status = 'ready_for_owner';
        break;
      }
      case 'mission.auto_merge_complete': {
        if (mission.status !== 'ready_for_owner') throw new Error('只有等待群主处理的任务可以报告自动合并');
        if (mission.autoMergeAuthorized !== true) throw new Error('任务章程没有自动合并预授权');
        if (
          workItem.roleId !== 'role-committer'
          || mission.leaderSnapshot?.['role-committer'] !== actorMember.id
        ) {
          throw new Error('只有提交专员 Leader 可以报告自动合并');
        }
        const submission = mission.submission;
        if (!submission?.draft) throw new Error('自动合并前必须先记录已验证的 Draft PR');
        const summary = action.summary?.trim() ?? '';
        const prUrl = action.prUrl?.trim() ?? '';
        const mergeCommitSha = action.mergeCommitSha?.trim() ?? '';
        if (!summary) throw new Error('自动合并完成必须提供合并摘要');
        if (prUrl !== submission.prUrl) throw new Error('合并证明的 PR 地址与 Draft PR 不一致');
        if (!/^[a-f0-9]{40}$/i.test(mergeCommitSha)) {
          throw new Error('mergeCommitSha 必须是完整的 Git 提交哈希');
        }
        this.resolveWorkItemArtifact(group, mission, workItem, action.artifact);
        if (!mission.gitBaseline) throw new Error('自动合并缺少任务 Git 基线');
        try {
          const remoteLine = execFileSync(
            'git',
            [
              '-C',
              mission.gitBaseline.repositoryRoot,
              'ls-remote',
              '--exit-code',
              'origin',
              `refs/heads/${mission.gitBaseline.baseBranch}`,
            ],
            { encoding: 'utf-8' },
          ).trim();
          const remoteHead = remoteLine.split(/\s+/)[0];
          if (remoteHead !== mergeCommitSha) {
            throw new Error('远端基准分支 HEAD 与合并证明不一致');
          }
        } catch (error) {
          if (error instanceof Error && !('status' in error)) throw error;
          throw new Error(`无法验证远端合并证明：${error instanceof Error ? error.message : String(error)}`);
        }
        mission.submission = {
          ...submission,
          draft: false,
          mergeCommitSha,
          mergedAt: now,
        };
        mission.status = 'completed';
        mission.completedAt = now;
        if (group.activeTaskSessionId === mission.id) delete group.activeTaskSessionId;
        for (const paused of this.groups) {
          if (paused.pausedByMissionId === mission.id) delete paused.pausedByMissionId;
        }
        break;
      }
      default:
        throw new Error(`未实现的协作操作：${String(action.action satisfies never)}`);
    }
    workItem.updatedAt = now;
    workItem.revision = (workItem.revision ?? 0) + 1;
    for (const affected of affectedWorkItems) {
      if (affected.id === workItem.id) continue;
      affected.updatedAt = now;
      affected.revision = (affected.revision ?? 0) + 1;
    }
    mission.processedRequestIds = [...(mission.processedRequestIds ?? []), action.requestId];
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = now;
    this.writeMissionFiles(group, mission);
    this.writeWorkItemFiles(group, mission, workItem);
    for (const affected of affectedWorkItems) this.writeWorkItemFiles(group, mission, affected);
    if (createdWorkItem) {
      this.writeWorkItemFiles(group, mission, createdWorkItem);
      this.writeHandoffInbox(group, mission, workItem, createdWorkItem, action);
    }
    for (const collaborationWorkItem of createdWorkItems ?? []) {
      this.writeWorkItemFiles(group, mission, collaborationWorkItem);
    }
    if (issue) this.writeIssueFile(group, mission, issue);
    this.appendMissionEvent(group, mission, action.action, `workItem=${workItem.id} actor=${actorMember.id}`);
    this.save();
    return {
      mission,
      workItem,
      createdWorkItem,
      createdWorkItems,
      issue,
      duplicate: false,
    };
  }

  private resolveCollaborationTarget(
    group: AgentGroup,
    mission: TaskSession,
    action: CollaborationControlAction,
  ): GroupMember {
    if (action.targetMemberId) {
      const member = group.members.find(item => (
        item.id === action.targetMemberId || item.agentId === action.targetMemberId
      ));
      if (!member) throw new Error('指定的协作目标不在当前群内');
      return member;
    }
    const targetRole = ALL_ROLES.find(role => (
      role.id === action.targetRole || role.name === action.targetRole
    ));
    if (!targetRole) throw new Error('必须指定有效的目标成员或目标角色');
    const leaderMemberId = mission.leaderSnapshot?.[targetRole.id];
    const member = group.members.find(item => item.id === leaderMemberId);
    if (!member) throw new Error(`目标角色「${targetRole.name}」没有任务 Leader`);
    return member;
  }

  private createPhaseCollaborationWorkItems(
    group: AgentGroup,
    mission: TaskSession,
    phase: MissionPhase,
    leaderWorkItem: TaskCard,
  ): TaskCard[] {
    const leaderMemberId = phase.leaderMemberId;
    const collaborators = group.members.filter(member => (
      member.roleId === phase.roleId && member.id !== leaderMemberId
    ));
    const kind = phase.roleId === 'role-code-reviewer'
      ? 'review'
      : phase.roleId === 'role-tester'
        ? 'test'
        : 'discussion';
    const workItems = collaborators.map(member => {
      const workItem = createMissionWorkItem(mission, phase, member, member.agentId);
      workItem.kind = kind;
      workItem.parentWorkItemId = leaderWorkItem.id;
      workItem.implementationRevisionId = leaderWorkItem.implementationRevisionId;
      workItem.requirementsRevision = leaderWorkItem.requirementsRevision;
      workItem.title = `${phase.name}独立${kind === 'discussion' ? '提案' : '检查'}：${mission.title}`;
      if (kind === 'discussion') {
        workItem.discussionRound = 1;
        workItem.discussionStage = 'independent';
      }
      return workItem;
    });
    if (kind === 'discussion' && workItems.length > 0) {
      leaderWorkItem.discussionStage = 'synthesis';
    }
    this.taskCards.push(...workItems);
    mission.requiredMemberIds = [
      ...(mission.requiredMemberIds ?? []),
      ...collaborators.map(member => member.id),
    ].filter((id, index, all) => all.indexOf(id) === index);
    return workItems;
  }

  private assertPhaseCollaboratorsSubmitted(leaderWorkItem: TaskCard) {
    const pending = this.taskCards.filter(workItem => (
      workItem.parentWorkItemId === leaderWorkItem.id
      && !['submitted', 'accepted_result', 'completed'].includes(workItem.status)
    ));
    if (pending.length > 0) {
      throw new Error(`同角色必需工作项尚未提交：${pending.map(item => item.id).join('、')}`);
    }
  }

  private assertDiscussionReadyForSynthesis(leaderWorkItem: TaskCard) {
    const discussionItems = this.taskCards.filter(item => (
      item.parentWorkItemId === leaderWorkItem.id && item.kind === 'discussion'
    ));
    if (discussionItems.length === 0) return;
    const hasCritiqueRound = discussionItems.some(item => item.discussionRound === 2);
    if (!hasCritiqueRound) throw new Error('同角色讨论必须完成独立提案和交叉评议后才能由 Leader 汇总');
    const pending = discussionItems.filter(item => !['submitted', 'completed'].includes(item.status));
    if (pending.length > 0) {
      throw new Error(`同角色讨论尚未完成：${pending.map(item => item.id).join('、')}`);
    }
  }

  private createDiscussionCritiqueRound(
    group: AgentGroup,
    mission: TaskSession,
    submittedWorkItem: TaskCard,
  ): TaskCard[] | undefined {
    const leaderWorkItemId = submittedWorkItem.parentWorkItemId;
    if (!leaderWorkItemId) return undefined;
    const roundOne = this.taskCards.filter(item => (
      item.parentWorkItemId === leaderWorkItemId
      && item.kind === 'discussion'
      && item.discussionRound === 1
    ));
    if (
      roundOne.length === 0
      || roundOne.some(item => !['submitted', 'completed'].includes(item.status))
      || this.taskCards.some(item => (
        item.parentWorkItemId === leaderWorkItemId
        && item.kind === 'discussion'
        && item.discussionRound === 2
      ))
    ) {
      return undefined;
    }
    const phase = (mission.phases ?? []).find(item => item.id === submittedWorkItem.phaseId);
    if (!phase) throw new Error('同角色讨论阶段不存在');
    const sourceSummary = roundOne
      .map(item => `- ${item.id}: ${item.artifact ?? '未记录产物'}`)
      .join('\n');
    const critiques = roundOne.map(roundOneItem => {
      const member = group.members.find(item => item.id === roundOneItem.ownerMemberId);
      if (!member) throw new Error('讨论成员已不在群内');
      const critique = createMissionWorkItem(mission, phase, member, member.agentId);
      critique.kind = 'discussion';
      critique.parentWorkItemId = leaderWorkItemId;
      critique.discussionRound = 2;
      critique.discussionStage = 'critique';
      critique.title = `${phase.name}交叉评议：${mission.title}`;
      critique.description = [
        '阅读第一轮所有独立提案，记录质疑、补充、修正和仍未解决的分歧。',
        '',
        sourceSummary,
      ].join('\n');
      return critique;
    });
    this.taskCards.push(...critiques);
    return critiques;
  }

  private createAdditionalDiscussionRound(
    group: AgentGroup,
    mission: TaskSession,
    leaderWorkItem: TaskCard,
    focus: string,
  ): TaskCard[] {
    const phase = (mission.phases ?? []).find(item => item.id === leaderWorkItem.phaseId);
    if (!phase) throw new Error('同角色讨论阶段不存在');
    const priorParticipants = new Set(
      this.taskCards
        .filter(item => (
          item.parentWorkItemId === leaderWorkItem.id
          && item.kind === 'discussion'
          && item.discussionRound === 2
        ))
        .map(item => item.ownerMemberId)
        .filter((id): id is string => !!id),
    );
    const round = [...priorParticipants].map(memberId => {
      const member = group.members.find(item => item.id === memberId);
      if (!member) throw new Error('讨论成员已不在群内');
      const item = createMissionWorkItem(mission, phase, member, member.agentId);
      item.kind = 'discussion';
      item.parentWorkItemId = leaderWorkItem.id;
      item.discussionRound = 3;
      item.discussionStage = 'critique';
      item.title = `${phase.name}补充讨论：${mission.title}`;
      item.description = `Leader 追加一轮讨论，聚焦以下未决问题：\n\n${focus}`;
      return item;
    });
    this.taskCards.push(...round);
    return round;
  }

  private freezeRequirementsFromWorkItem(
    group: AgentGroup,
    mission: TaskSession,
    workItem: TaskCard,
  ) {
    if (!group.workingDirectory || !workItem.artifact) {
      throw new Error('产品交接缺少可冻结的需求产物');
    }
    const source = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
      workItem.artifact,
    );
    const content = fs.readFileSync(source);
    this.writeRequirementsRevision(group, mission, content, workItem.id);
  }

  private persistImplementationRevision(
    group: AgentGroup,
    mission: TaskSession,
    snapshot: GitRevisionSnapshot,
  ): ImplementationRevision {
    if (!mission.gitBaseline || snapshot.baseCommit !== mission.gitBaseline.baseCommit) {
      throw new Error('实现修订与任务 Git 基线不一致');
    }
    const expectedNumber = nextImplementationRevisionNumber(mission.implementationRevisions ?? []);
    const expectedId = `R${String(expectedNumber).padStart(3, '0')}`;
    if (snapshot.id !== expectedId) throw new Error(`下一个实现修订必须是 ${expectedId}`);
    if (!group.workingDirectory) throw new Error('群没有工作目录');
    const revisionDir = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'revisions',
    );
    fs.mkdirSync(revisionDir, { recursive: true });
    const patchArtifact = `${snapshot.id}.patch`;
    const manifestArtifact = `${snapshot.id}.md`;
    if (fs.existsSync(path.join(revisionDir, patchArtifact))) {
      throw new Error(`实现修订 ${snapshot.id} 已存在，禁止覆盖`);
    }
    fs.writeFileSync(path.join(revisionDir, patchArtifact), snapshot.patch, 'utf-8');
    const revision: ImplementationRevision = {
      id: snapshot.id,
      baseCommit: snapshot.baseCommit,
      branch: snapshot.branch,
      contentHash: snapshot.contentHash,
      changedFiles: snapshot.changedFiles,
      patchArtifact,
      manifestArtifact,
      createdAt: snapshot.createdAt,
    };
    fs.writeFileSync(
      path.join(revisionDir, manifestArtifact),
      [
        '---',
        `id: ${revision.id}`,
        `baseCommit: ${revision.baseCommit}`,
        `branch: ${revision.branch}`,
        `contentHash: ${revision.contentHash}`,
        '---',
        '',
        `# 实现修订 ${revision.id}`,
        '',
        '## 变更文件',
        '',
        ...revision.changedFiles.map(file => `- ${file}`),
        '',
        `补丁：${revision.patchArtifact}`,
      ].join('\n'),
      'utf-8',
    );
    mission.implementationRevisions = [...(mission.implementationRevisions ?? []), revision];
    mission.currentImplementationRevisionId = revision.id;
    mission.revision = (mission.revision ?? 0) + 1;
    mission.updatedAt = Date.now() / 1000;
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'implementation.revision_created',
      `id=${revision.id} hash=${revision.contentHash}`,
    );
    return revision;
  }

  private freezeOwnerRequirements(group: AgentGroup, mission: TaskSession) {
    const content = Buffer.from([
      `# ${mission.title}`,
      '',
      '## 群主确认的目标',
      '',
      mission.objective ?? '',
      '',
      '## 验收标准',
      '',
      ...(mission.acceptanceCriteria ?? []).map(item => `- ${item}`),
      '',
    ].join('\n'));
    this.writeRequirementsRevision(group, mission, content);
  }

  private writeRequirementsRevision(
    group: AgentGroup,
    mission: TaskSession,
    content: Buffer,
    sourceWorkItemId?: string,
  ) {
    if (!group.workingDirectory) throw new Error('群没有工作目录');
    const version = (mission.currentRequirementsRevision ?? 0) + 1;
    const artifact = `requirements/requirements-v${version}.md`;
    const target = path.join(group.workingDirectory, '.ai-team', 'tasks', mission.id, artifact);
    if (fs.existsSync(target)) throw new Error(`需求版本 requirements-v${version} 已存在，禁止覆盖`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    mission.requirementsRevisions = [
      ...(mission.requirementsRevisions ?? []),
      {
        version,
        artifact,
        contentHash: createHash('sha256').update(content).digest('hex'),
        sourceWorkItemId,
        createdAt: Date.now() / 1000,
      },
    ];
    mission.currentRequirementsRevision = version;
  }

  private assertWorkspaceMatchesApprovedRevision(group: AgentGroup, mission: TaskSession) {
    if (!mission.gitBaseline || !mission.currentImplementationRevisionId) return;
    const approved = (mission.implementationRevisions ?? []).find(
      revision => revision.id === mission.currentImplementationRevisionId,
    );
    if (!approved) throw new Error('当前批准实现修订不存在');
    const repositoryRoot = mission.gitBaseline.repositoryRoot;
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-verify-index-'));
    const indexPath = path.join(tempDirectory, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    let actualHash: string;
    try {
      execFileSync('git', ['read-tree', mission.gitBaseline.baseCommit], {
        cwd: repositoryRoot,
        env,
      });
      execFileSync('git', ['add', '-A', '--', '.'], {
        cwd: repositoryRoot,
        env,
      });
      const patchBuffer = execFileSync(
        'git',
        ['diff', '--cached', '--binary', '--no-ext-diff', mission.gitBaseline.baseCommit, '--'],
        { cwd: repositoryRoot, env },
      );
      actualHash = createHash('sha256').update(patchBuffer).digest('hex');
    } catch (error) {
      throw new Error(`无法核对当前项目文件：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
    if (actualHash === approved.contentHash) return;

    const now = Date.now() / 1000;
    mission.status = 'external_change_detected';
    mission.interruptionReason = `external_change_detected:expected=${approved.contentHash}:actual=${actualHash}`;
    mission.interruptedAt = now;
    mission.updatedAt = now;
    mission.revision = (mission.revision ?? 0) + 1;
    for (const workItem of this.taskCards.filter(item => (
      item.taskSessionId === mission.id
      && ['offered', 'accepted', 'active', 'waiting_dependency', 'waiting_collab'].includes(item.status)
    ))) {
      workItem.interruptedFromStatus = workItem.status;
      workItem.status = 'interrupted';
      workItem.updatedAt = now;
      workItem.revision = (workItem.revision ?? 0) + 1;
      this.writeWorkItemFiles(group, mission, workItem);
    }
    this.writeMissionFiles(group, mission);
    this.appendMissionEvent(
      group,
      mission,
      'mission.external_change_detected',
      `expected=${approved.contentHash} actual=${actualHash}`,
    );
    this.save();
    throw new Error('检测到批准实现修订之外的项目文件变化，任务已暂停等待群主处理');
  }

  private restoreApprovedImplementationRevision(group: AgentGroup, mission: TaskSession) {
    if (!group.workingDirectory || !mission.gitBaseline || !mission.currentImplementationRevisionId) {
      throw new Error('无法恢复：任务缺少 Git 基线或批准实现修订');
    }
    const approved = (mission.implementationRevisions ?? []).find(
      revision => revision.id === mission.currentImplementationRevisionId,
    );
    if (!approved) throw new Error('无法恢复：当前批准实现修订不存在');
    const repositoryRoot = mission.gitBaseline.repositoryRoot;
    const patchPath = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'revisions',
      approved.patchArtifact,
    );
    if (!fs.existsSync(patchPath)) throw new Error('无法恢复：批准实现修订补丁不存在');
    const approvedPatch = fs.readFileSync(patchPath);
    try {
      const currentBranch = execFileSync('git', ['-C', repositoryRoot, 'branch', '--show-current'], {
        encoding: 'utf-8',
      }).trim();
      if (currentBranch !== mission.gitBaseline.taskBranch) {
        throw new Error(`当前分支不是任务分支：${mission.gitBaseline.taskBranch}`);
      }
      execFileSync('git', ['-C', repositoryRoot, 'reset', '--hard', mission.gitBaseline.baseCommit]);
      const untracked = execFileSync(
        'git',
        ['-C', repositoryRoot, 'ls-files', '--others', '--exclude-standard', '-z'],
      ).toString('utf-8').split('\0').filter(Boolean);
      for (const relativeFile of untracked) {
        if (relativeFile.split('/').includes('.ai-team')) continue;
        fs.rmSync(path.join(repositoryRoot, relativeFile), { recursive: true, force: true });
      }
      if (approvedPatch.length > 0) {
        execFileSync(
          'git',
          ['-C', repositoryRoot, 'apply', '--binary', '--whitespace=nowarn', '-'],
          { input: approvedPatch },
        );
      }
      this.assertWorkspaceMatchesApprovedRevision(group, mission);
    } catch (error) {
      if (mission.status === 'external_change_detected') {
        throw new Error(`移除外部变更失败：${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  private verifyAndRecordSubmission(
    group: AgentGroup,
    mission: TaskSession,
    action: CollaborationControlAction,
    recordedAt: number,
  ) {
    if (!group.workingDirectory || !mission.gitBaseline) throw new Error('提交任务缺少 Git 基线');
    const revision = (mission.implementationRevisions ?? []).find(item => (
      item.id === mission.currentImplementationRevisionId
    ));
    if (!revision) throw new Error('提交前必须存在当前批准实现修订');
    const branch = action.branch?.trim() ?? '';
    const commitSha = action.commitSha?.trim() ?? '';
    const prUrl = action.prUrl?.trim() ?? '';
    if (branch !== mission.gitBaseline.taskBranch) throw new Error('提交分支与任务分支不一致');
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('commitSha 必须是完整的 Git 提交哈希');
    if (action.draftPr !== true) throw new Error('提交专员必须创建 Draft PR');
    try {
      const parsed = new URL(prUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      throw new Error('prUrl 必须是有效的 HTTP(S) PR 地址');
    }

    const repositoryRoot = mission.gitBaseline.repositoryRoot;
    try {
      const actualBranch = execFileSync('git', ['-C', repositoryRoot, 'branch', '--show-current'], {
        encoding: 'utf-8',
      }).trim();
      const actualCommit = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
      if (actualBranch !== branch) throw new Error(`当前分支不是任务分支：${branch}`);
      if (actualCommit !== commitSha) throw new Error('提交证明与当前 HEAD 不一致');
      const trackedTeamFiles = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '--', '.ai-team'], {
        encoding: 'utf-8',
      }).trim();
      if (trackedTeamFiles) throw new Error('.ai-team 被纳入 Git，禁止创建提交证明');
      const status = execFileSync('git', ['-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
        encoding: 'utf-8',
      })
        .split(/\r?\n/)
        .filter(Boolean)
        .filter(line => {
          const file = line.slice(3).replace(/^"|"$/g, '');
          return file !== '.ai-team' && !file.startsWith('.ai-team/');
        });
      if (status.length > 0) throw new Error(`提交后工作区仍有未提交变化：${status.join('、')}`);
      const submittedPatch = execFileSync(
        'git',
        ['-C', repositoryRoot, 'diff', '--binary', '--no-ext-diff', mission.gitBaseline.baseCommit, 'HEAD', '--'],
      );
      const submittedHash = createHash('sha256').update(submittedPatch).digest('hex');
      if (submittedHash !== revision.contentHash) {
        throw new Error('HEAD 内容与批准实现修订哈希不一致');
      }
    } catch (error) {
      if (error instanceof Error && !('status' in error)) throw error;
      throw new Error(`无法验证本地提交证明：${error instanceof Error ? error.message : String(error)}`);
    }

    mission.submission = {
      revisionId: revision.id,
      revisionContentHash: revision.contentHash,
      branch,
      commitSha,
      prUrl,
      draft: true,
      recordedAt,
    };
  }

  private resolveWorkItemArtifact(
    group: AgentGroup,
    mission: TaskSession,
    workItem: TaskCard,
    artifact: string | undefined,
  ): string {
    if (!group.workingDirectory) throw new Error('群没有工作目录');
    if (!artifact || path.isAbsolute(artifact) || path.extname(artifact).toLowerCase() !== '.md') {
      throw new Error('正式交付物必须是工作项目录中的 Markdown 相对路径');
    }
    const workItemDir = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    const resolved = path.resolve(workItemDir, artifact);
    if (!resolved.startsWith(`${path.resolve(workItemDir)}${path.sep}`) || !fs.existsSync(resolved)) {
      throw new Error('交付物不存在或超出当前工作项目录');
    }
    return artifact;
  }

  private readWorkItemArtifact(
    group: AgentGroup,
    mission: TaskSession,
    workItem: TaskCard,
    artifact: string,
  ): string {
    if (!group.workingDirectory) throw new Error('群没有工作目录');
    return fs.readFileSync(path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
      artifact,
    ), 'utf-8');
  }

  private writeHandoffInbox(
    group: AgentGroup,
    mission: TaskSession,
    source: TaskCard,
    target: TaskCard,
    action: CollaborationControlAction,
  ) {
    if (!group.workingDirectory || !action.artifact) return;
    const inboxPath = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      target.id,
      'inbox',
      `${action.requestId}.md`,
    );
    const sourceArtifact = path.posix.join('..', '..', source.id, action.artifact.replaceAll(path.sep, '/'));
    fs.writeFileSync(
      inboxPath,
      [
        '# 正式阶段交接',
        '',
        `- 来源工作项：${source.id}`,
        `- 目标工作项：${target.id}`,
        `- 来源产物：[打开交接包](${sourceArtifact})`,
        `- 上下文版本：${target.contextRevision ?? 0}`,
        '',
        '阅读交接包后，请使用结构化控制块接受、拒绝或请求澄清。',
      ].join('\n'),
      'utf-8',
    );
  }

  private writeIssueFile(group: AgentGroup, mission: TaskSession, issue: CollaborationIssue) {
    if (!group.workingDirectory) return;
    const issueDirectory = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'issues',
      issue.id,
    );
    fs.mkdirSync(issueDirectory, { recursive: true });
    const revision = issue.revision ?? 1;
    const issuePath = path.join(issueDirectory, `v${String(revision).padStart(3, '0')}.md`);
    const content = appendRecoverySnapshot([
        '---',
        `id: ${issue.id}`,
        `revision: ${revision}`,
        `status: ${issue.status}`,
        `severity: ${issue.severity}`,
        `workItemId: ${issue.workItemId}`,
        `reporterMemberId: ${issue.reporterMemberId}`,
        `reopenCount: ${issue.reopenCount}`,
        `requirementsRevision: ${issue.requirementsRevision ?? ''}`,
        `implementationRevisionId: ${issue.implementationRevisionId ?? ''}`,
        '---',
        '',
        `# ${issue.title}`,
        '',
        issue.summary,
        '',
        `证据：${issue.evidenceArtifact}`,
        ...(issue.resolution ? ['', '## 处理结论', '', issue.resolution] : []),
      ].join('\n'), issue);
    if (fs.existsSync(issuePath)) {
      const existing = fs.readFileSync(issuePath, 'utf-8');
      if (existing !== content) throw new Error(`问题记录 ${issue.id} v${revision} 已存在，禁止覆盖`);
      return;
    }
    fs.writeFileSync(issuePath, content, 'utf-8');
  }

  archiveTaskSession(id: string): TaskSession | undefined {
    const session = this.taskSessionById(id);
    if (!session || session.status === 'archived') return session;
    session.status = 'archived';
    session.archivedAt = Date.now() / 1000;
    const group = this.groupById(session.groupId);
    if (group?.activeTaskSessionId === session.id) {
      delete group.activeTaskSessionId;
    }
    this.save();
    return session;
  }

  /** 若已有群组使用与 path 经 path.resolve 后相同的工作目录则返回该群组 */
  groupByResolvedWorkingDirectory(dir: string, groupType?: AgentGroup['groupType']): AgentGroup | undefined {
    const target = path.resolve(dir.trim());
    return this.groups.find(
      g => (
        (!groupType || g.groupType === groupType)
        && !!g.workingDirectory
        && path.resolve(g.workingDirectory) === target
      ),
    );
  }

  isAgentInAnyGroup(agentId: string): boolean {
    return this.groups.some(g => groupMemberIds(g).includes(agentId));
  }

  // MARK: - Role

  role(id: string): Role | undefined { return roleById(id); }

  roleName(agentName: string, group: AgentGroup): string | undefined {
    const agent = this.agentByName(agentName);
    if (!agent) return undefined;
    const member = group.members.find(m => m.agentId === agent.id);
    if (!member?.roleId) return undefined;
    return this.role(member.roleId)?.name;
  }

  // MARK: - TaskCard CRUD

  addTaskCard(card: TaskCard) {
    this.taskCards.push(card);
    this.save();
  }

  updateTaskCard(card: TaskCard) {
    const idx = this.taskCards.findIndex(c => c.id === card.id);
    if (idx < 0) return;
    this.taskCards[idx] = card;
    this.save();
  }

  removeTaskCard(id: string) {
    this.taskCards = this.taskCards.filter(c => c.id !== id);
    this.save();
  }

  taskCardById(id: string): TaskCard | undefined {
    return this.taskCards.find(c => c.id === id);
  }

  activeTaskCards(groupId: string): TaskCard[] {
    return this.taskCards.filter(c => c.groupId === groupId && !isTaskTerminal(c));
  }

  taskCardsForOwner(agentId: string): TaskCard[] {
    return this.taskCards.filter(c => c.ownerAgentId === agentId && !isTaskTerminal(c));
  }

  // MARK: - Team Context Files

  buildTeamContextFile(_group: AgentGroup): string {
    return [
      '# AI 团队协作入口', '',
      '本目录定义了当前群组的协作制度。请按顺序阅读以下文件：', '',
      '1. **group.md** — 群的目标、类型、群主和边界',
      '2. **members.md** — 当前成员名册与角色分配',
      '3. **dispatch.md** — 任务创建、派单、协作和异常处理规则',
      '4. **roles/** 目录下你自己的角色文件 — 你的岗位职责、允许/禁止动作、回执格式', '',
      '阅读完成后请简要确认你的角色，然后等待群主下发任务。',
    ].join('\n');
  }

  buildGroupFile(group: AgentGroup): string {
    const lines = ['# 群组信息', '', '## 群名称', group.name, '', '## 群类型', '协作群', ''];
    lines.push('> 群的协作方式由当前任务模板决定；正式工作项遵循单主责和 Leader 交接。');
    lines.push('', '## 人类群主', group.ownerName, '');
    lines.push('## 门禁动作', '以下动作必须交给人类群主，AI 不得自行执行：');
    lines.push('- 需求定稿与方案选型拍板', '- 真机验收与外部系统操作');
    lines.push('- 合并 PR / 发布上线 / 推送默认分支 / 强制推送', '- 删除或覆盖重要文件');
    lines.push('- 任务范围外的代码变化与重大架构、安全或成本决策');
    lines.push('- 涉及安全凭据、密钥的操作', '');
    lines.push('## 交付标准', '- 每项任务完成时必须提供：做了什么、结果证据、建议下一步');
    lines.push('- 代码类交付需要说明改动范围和自测结果');
    return lines.join('\n');
  }

  buildMembersFile(group: AgentGroup): string {
    const roleStats = this.buildRoleStats(group);
    const lines = ['# 群成员名册', '', '## 成员列表', ''];
    lines.push('| 联系人 | 当前角色 | 状态 |', '|--------|----------|------|');
    lines.push(`| ${group.ownerName} | 群主（人类） | 在线 |`);
    for (const member of group.members) {
      const agentName = this.agentById(member.agentId)?.name ?? '?';
      const rName = member.roleId ? (this.role(member.roleId)?.name ?? '无角色') : '无角色';
      const status = member.roleId && group.roleLeaders[member.roleId] === member.id
        ? 'Leader'
        : '成员';
      lines.push(`| ${agentName} | ${rName} | ${status} |`);
    }
    lines.push('');
    lines.push('## 可用角色统计');
    for (const stat of roleStats) {
      if (stat.count === 1) {
        lines.push(`- ${stat.roleName} x1`);
      } else {
        lines.push(`- ${stat.roleName} x${stat.count}: ${stat.agentNames.join(', ')}`);
      }
    }
    const allRoleNames = new Set(ALL_ROLES.map(r => r.name));
    const presentRoleNames = new Set(roleStats.map(s => s.roleName));
    const missing = [...allRoleNames].filter(n => !presentRoleNames.has(n)).sort();
    if (missing.length > 0) {
      lines.push('', '## 缺岗说明');
      for (const m of missing) {
        lines.push(`- ${m} — 当前群内无此角色，相关工作需群主决定处理方式`);
      }
      lines.push('', '> 缺岗不会阻止任务推进，但系统会在关键节点提醒群主相关风险。');
    }
    return lines.join('\n');
  }

  buildDispatchFile(group: AgentGroup): string {
    const availableRoleNames = this.buildRoleStats(group).map(stat => stat.roleName).join('、');
    const lines = ['# 调度规则', '', '## 核心约束'];
    lines.push('- 任务由人类群主创建并确认首位负责人，不存在抢单模式');
    lines.push('- 一个 AI 在本群只能承担一个基础角色，禁止兼职');
    lines.push('- 一个工作项只有一个负责人；正式跨角色交接由当前角色 Leader 发起');
    lines.push('- 同角色多人先独立提案，再交叉评议，最后只由 Leader 汇总结论并对外交接');
    lines.push('- 只有技术 Leader 可以修改项目文件；其他研发只讨论，其他角色只写 .ai-team');
    lines.push('- 普通自然语言只用于沟通，不改变任何任务状态');
    lines.push(`- 当前可用角色：${availableRoleNames || '无'}`, '');
    lines.push('## 结构化控制协议');
    lines.push('正式接单、开始、提交、交接和退回必须在回复中输出：', '');
    lines.push('```octrix-action');
    lines.push('action: work.accept');
    lines.push('requestId: 唯一请求ID');
    lines.push('missionId: 主任务ID');
    lines.push('workItemId: 工作项ID');
    lines.push('expectedRevision: 当前工作项版本');
    lines.push('contextRevision: 当前交接包版本');
    lines.push('```', '');
    lines.push('格式错误或版本冲突时必须修正请求，不得用自然语言宣称状态已经变化。');
    lines.push('连续失败可按系统反馈自动修正两次；第 3 次失败进入 protocol_error，等待群主恢复。');
    lines.push('', '## 常用动作');
    lines.push('- `work.accept`：必须带 contextRevision；接受前不转移责任');
    lines.push('- `work.reject` / `work.clarify`：必须带 summary');
    lines.push('- `work.started` / `work.progress` / `work.submit`：提交必须引用 Markdown artifact');
    lines.push('- `consultation.request` / `clarification.request`：指定 targetRole 或 targetMemberId');
    lines.push('- `handoff.request`：Leader 指向计划中的下一角色，并引用不可覆盖交接包');
    lines.push('- `issue.report` / `issue.resolve` / `issue.reopen`：使用稳定 issueId 和证据 artifact');
    lines.push('- `defect.return`：质量 Leader 引用未关闭 issueId 退回研发');
    lines.push('- `stage.pass`：质量 Leader 在所有阻断问题关闭后签署通过');
    lines.push('- `discussion.extend`：同角色 Leader 在两轮结束后显式追加且最多追加一轮');
    lines.push('- `mission.owner_attention`：范围变化、重大风险、缺岗变化、外部验证或外部动作需要群主介入');
    lines.push('- `mission.ready_for_owner`：最终角色提交摘要；提交专员还必须提供 Git/PR 证明');
    lines.push('- `mission.auto_merge_complete`：仅在任务预授权时，由提交专员提交远端合并证明');
    lines.push('', '## 正式流转');
    lines.push('- 咨询不会转移责任；澄清只阻塞依赖答案的工作项');
    lines.push('- 阶段交接必须引用不可覆盖的 Markdown 交接包');
    lines.push('- 缺陷退回必须引用稳定问题 ID 和证据');
    lines.push('- 遇到群主门禁、停滞或协议错误时停止推进并等待处理');
    return lines.join('\n');
  }

  buildRoleStats(group: AgentGroup): { roleName: string; count: number; agentNames: string[] }[] {
    const roleOrder: string[] = [];
    const roleAgents: Record<string, string[]> = {};
    for (const member of group.members) {
      if (!member.roleId) continue;
      const r = this.role(member.roleId);
      if (!r) continue;
      const agentName = this.agentById(member.agentId)?.name ?? '?';
      if (!roleAgents[r.name]) { roleOrder.push(r.name); roleAgents[r.name] = []; }
      roleAgents[r.name].push(agentName);
    }
    return roleOrder.map(name => ({
      roleName: name,
      count: roleAgents[name].length,
      agentNames: roleAgents[name],
    }));
  }

  buildRoleFile(member: GroupMember, group: AgentGroup): string {
    if (!member.roleId) return '';
    const myRole = this.role(member.roleId);
    if (!myRole) return '';
    const myAgentName = this.agentById(member.agentId)?.name ?? '?';
    let content = roleMarkdownTemplate(myRole);
    const isLeader = group.roleLeaders[myRole.id] === member.id;
    content += '\n\n## 当前成员身份\n';
    content += `- AI 成员：${myAgentName}\n`;
    content += `- 当前基础角色：${myRole.name}\n`;
    content += `- 角色身份：${isLeader ? 'Leader' : '普通成员'}\n`;
    content += '- 一个 AI 在本群只能承担一个基础角色，禁止兼职或冒充缺失角色。\n';
    if (isLeader) {
      content += `- 你是本群${myRole.name}角色的默认 Leader，负责汇总、签发结论和正式对外交接。\n`;
    } else {
      content += `- 你不是${myRole.name} Leader；你可以讨论和提交独立产物，但不能发起正式跨角色交接。\n`;
    }
    if (myRole.id === 'role-developer') {
      content += isLeader
        ? '- 你是项目文件的唯一写入者，其他研发只能参与讨论和方案设计。\n'
        : '- 不得修改任何项目文件；只允许阅读、讨论并在 .ai-team 中提交方案。\n';
    }
    const sameRolePeers = group.members.filter(
      m => m.id !== member.id && m.roleId === member.roleId,
    );
    if (sameRolePeers.length > 0) {
      const peerNames = sameRolePeers.map(m => this.agentById(m.agentId)?.name ?? '?');
      content += `\n\n## 同角色成员\n`;
      content += `你(${myAgentName})与 ${peerNames.join('、')} 同为${myRole.name}，请注意协调分工，避免重复劳动。\n`;
      content += '同角色讨论采用独立提案、交叉评议和 Leader 汇总；每位成员写独立 Markdown 文件。';
    }
    return content;
  }

  writeTeamFiles(group: AgentGroup) {
    if (group.groupType === 'direct') return;
    if (!group.workingDirectory) return;
    const teamDir = path.join(group.workingDirectory, '.ai-team');
    const rolesDir = path.join(teamDir, 'roles');
    fs.mkdirSync(rolesDir, { recursive: true });

    // Clean old role files
    for (const dir of [teamDir, rolesDir]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith('role-') && f.endsWith('.md')) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
      } catch { /* ignore */ }
    }

    fs.writeFileSync(path.join(teamDir, 'context.md'), this.buildTeamContextFile(group), 'utf-8');
    fs.writeFileSync(path.join(teamDir, 'group.md'), this.buildGroupFile(group), 'utf-8');
    fs.writeFileSync(path.join(teamDir, 'members.md'), this.buildMembersFile(group), 'utf-8');
    fs.writeFileSync(path.join(teamDir, 'dispatch.md'), this.buildDispatchFile(group), 'utf-8');

    for (const member of group.members) {
      if (!member.roleId) continue;
      const r = this.role(member.roleId);
      if (!r) continue;
      const agentName = this.agentById(member.agentId)?.name ?? 'unknown';
      const content = this.buildRoleFile(member, group);
      fs.writeFileSync(path.join(rolesDir, `role-${r.name}-${agentName}.md`), content, 'utf-8');
    }
  }

  writeMissionFiles(group: AgentGroup, mission: TaskSession) {
    if (!group.workingDirectory || mission.kind !== 'mission') return;
    this.writeTeamFiles(group);
    const missionDir = path.join(group.workingDirectory, '.ai-team', 'tasks', mission.id);
    const directories = [
      'requirements',
      'discussions',
      'issues',
      'revisions',
      'work-items',
    ];
    fs.mkdirSync(missionDir, { recursive: true });
    for (const directory of directories) {
      fs.mkdirSync(path.join(missionDir, directory), { recursive: true });
    }

    const missionLines = [
      '---',
      `id: ${mission.id}`,
      `groupId: ${mission.groupId}`,
      `status: ${mission.status}`,
      `revision: ${mission.revision ?? 0}`,
      `template: ${mission.template}`,
      '---',
      '',
      `# ${mission.title}`,
      '',
      '## 目标',
      '',
      mission.objective ?? '',
      '',
      '## 验收标准',
      '',
      ...(mission.acceptanceCriteria ?? []).map(item => `- ${item}`),
      '',
      '## 缺岗决策',
      '',
      ...((mission.missingRoleDecisions?.length ?? 0) > 0
        ? (mission.missingRoleDecisions ?? []).map(decision => (
          `- ${roleById(decision.roleId)?.name ?? decision.roleId}: ${decision.resolution} — ${decision.note}`
        ))
        : ['- 无']),
      '',
      '## Git 基线',
      '',
      ...(mission.gitBaseline
        ? [
          `- 基准分支：${mission.gitBaseline.baseBranch}`,
          `- 基准提交：${mission.gitBaseline.baseCommit}`,
          `- 任务分支：${mission.gitBaseline.taskBranch}`,
        ]
        : ['- 未准备或当前任务不需要 Git 分支']),
      '',
      '## 当前实现修订',
      '',
      mission.currentImplementationRevisionId
        ? `- ${mission.currentImplementationRevisionId}`
        : '- 尚未生成',
      '',
      '## 当前需求版本',
      '',
      mission.currentRequirementsRevision
        ? `- requirements-v${mission.currentRequirementsRevision}`
        : '- 尚未冻结',
      '',
      '## 质量策略',
      '',
      `- 阻断严重度：${(mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major']).join('、')}`,
      '- 会写入共享缓存、构建目录或设备状态的测试：串行执行',
      '',
      '## 提交与 PR',
      '',
      ...(mission.submission
        ? [
          `- 实现修订：${mission.submission.revisionId}`,
          `- 分支：${mission.submission.branch}`,
          `- Commit：${mission.submission.commitSha}`,
          `- ${mission.submission.draft ? 'Draft PR' : '已合并 PR'}：${mission.submission.prUrl}`,
          ...(mission.submission.mergeCommitSha
            ? [`- 合并提交：${mission.submission.mergeCommitSha}`]
            : []),
        ]
        : ['- 尚未提交']),
      '',
      '> 本文件的状态字段由 Octrix 服务端管理，请勿直接覆盖。',
    ];
    fs.writeFileSync(
      path.join(missionDir, 'mission.md'),
      appendRecoverySnapshot(missionLines.join('\n'), mission),
      'utf-8',
    );

    const planLines = [
      '# 阶段计划',
      '',
      '| 顺序 | 阶段 | Leader | 状态 |',
      '|---:|---|---|---|',
      ...(mission.phases ?? []).map(phase => {
        const leaderName = phase.leaderMemberId
          ? this.agentById(group.members.find(member => member.id === phase.leaderMemberId)?.agentId ?? '')?.name ?? '-'
          : '-';
        return `| ${phase.order} | ${phase.name} | ${leaderName} | ${phase.status} |`;
      }),
      '',
      `自动合并预授权：${mission.autoMergeAuthorized ? '是' : '否'}`,
      '',
      '> 阶段、Leader 与缺岗决策由 Octrix 服务端管理。',
    ];
    fs.writeFileSync(path.join(missionDir, 'plan.md'), planLines.join('\n'), 'utf-8');
    const eventsPath = path.join(missionDir, 'events.md');
    if (!fs.existsSync(eventsPath)) {
      fs.writeFileSync(
        eventsPath,
        `# 任务事件\n\n- ${new Date(mission.createdAt * 1000).toISOString()} mission.created revision=0\n`,
        'utf-8',
      );
    }
  }

  writeWorkItemFiles(group: AgentGroup, mission: TaskSession, workItem: TaskCard) {
    if (!group.workingDirectory) return;
    const workItemDir = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    for (const directory of ['inbox', 'handoffs', 'reviews', 'artifacts']) {
      fs.mkdirSync(path.join(workItemDir, directory), { recursive: true });
    }
    const brief = [
      '---',
      `id: ${workItem.id}`,
      `missionId: ${mission.id}`,
      `status: ${workItem.status}`,
      `revision: ${workItem.revision ?? 0}`,
      `roleId: ${workItem.roleId ?? ''}`,
      `ownerMemberId: ${workItem.ownerMemberId ?? ''}`,
      `requirementsRevision: ${workItem.requirementsRevision ?? ''}`,
      `implementationRevisionId: ${workItem.implementationRevisionId ?? ''}`,
      '---',
      '',
      `# ${workItem.title}`,
      '',
      workItem.description,
      '',
      '## 验收标准',
      '',
      ...(mission.acceptanceCriteria ?? []).map(item => `- ${item}`),
    ];
    fs.writeFileSync(
      path.join(workItemDir, 'brief.md'),
      appendRecoverySnapshot(brief.join('\n'), workItem),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workItemDir, 'inbox', 'offer-001.md'),
      `# 工作项派单\n\n请阅读 ../brief.md 后使用结构化控制块接受、拒绝或请求澄清。\n`,
      'utf-8',
    );
  }

  appendMissionEvent(group: AgentGroup, mission: TaskSession, event: string, detail = '') {
    if (!group.workingDirectory) return;
    const eventsPath = path.join(
      group.workingDirectory,
      '.ai-team',
      'tasks',
      mission.id,
      'events.md',
    );
    const suffix = detail ? ` ${detail}` : '';
    fs.appendFileSync(
      eventsPath,
      `- ${new Date().toISOString()} ${event} revision=${mission.revision ?? 0}${suffix}\n`,
      'utf-8',
    );
  }

  roleFileName(member: GroupMember): string | undefined {
    if (!member.roleId) return undefined;
    const r = this.role(member.roleId);
    if (!r) return undefined;
    const agentName = this.agentById(member.agentId)?.name ?? 'unknown';
    return `roles/role-${r.name}-${agentName}.md`;
  }

  // MARK: - Workflow CRUD

  addWorkflow(wf: WorkflowDefinition) {
    this.workflows.push(wf);
    this.saveWorkflows();
  }

  removeWorkflow(id: string) {
    this.workflows = this.workflows.filter(w => w.id !== id);
    this.saveWorkflows();
  }

  workflowById(id: string): WorkflowDefinition | undefined {
    return this.workflows.find(w => w.id === id);
  }

  addWorkflowRun(run: WorkflowRun) {
    this.workflowRuns.push(run);
    this.saveWorkflows();
  }

  updateWorkflowRun(run: WorkflowRun) {
    const idx = this.workflowRuns.findIndex(r => r.id === run.id);
    if (idx < 0) return;
    this.workflowRuns[idx] = run;
    this.saveWorkflows();
  }

  // MARK: - Persistence

  private load() {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.tryMigrateLegacy();
        return;
      }
      const data: StorageData = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      this.agents = data.agents ?? [];
      this.groups = data.groups ?? [];
      this.taskCards = data.taskCards ?? [];
      this.taskSessions = data.taskSessions ?? [];
      this.issues = data.issues ?? [];

      const workspaceReset = this.resetLegacyWorkspaceData(data.workspaceDataVersion ?? 0);
      const collaborationReset = this.resetLegacyCollaborationData(
        data.collaborationSchemaVersion ?? 0,
      );
      const recovered = this.recoverMissionStateFromMarkdown();

      // Migrate legacy memberIds format
      for (const g of this.groups) {
        if (!g.members && (g as any).memberIds) {
          g.members = ((g as any).memberIds as string[]).map(id => ({
            id: `migrated-${id}`, agentId: id, roleId: null,
          }));
        }
      }

      if (data.roles && data.roles.length > 0) {
        this.migrateRoleIds(data.roles);
      }
      const taskSessionsInitialized = this.ensureTaskSessionsForGroups();
      const normalized = this.normalizeSupportedAgents();
      const pruned = this.pruneUnsupportedAgents();
      const interrupted = this.interruptRunningMissionsAfterLoad();
      if (
        workspaceReset
        || collaborationReset
        || recovered
        || taskSessionsInitialized
        || normalized
        || pruned
        || interrupted
      ) this.save();
    } catch { /* start fresh */ }
  }

  private tryMigrateLegacy() {
    const legacyPath = path.join(
      os.homedir(), 'Library', 'Application Support', 'CLIBridge', 'config.json',
    );
    if (fs.existsSync(legacyPath)) {
      try {
        const data: StorageData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        this.agents = data.agents ?? [];
        this.groups = data.groups ?? [];
        this.taskCards = data.taskCards ?? [];
        this.taskSessions = data.taskSessions ?? [];
        this.issues = data.issues ?? [];
        const workspaceReset = this.resetLegacyWorkspaceData(0);
        this.resetLegacyCollaborationData(data.collaborationSchemaVersion ?? 0);
        const recovered = this.recoverMissionStateFromMarkdown();
        for (const g of this.groups) {
          if (!g.members && (g as any).memberIds) {
            g.members = ((g as any).memberIds as string[]).map(id => ({
              id: `migrated-${id}`, agentId: id, roleId: null,
            }));
          }
        }
        if (data.roles) this.migrateRoleIds(data.roles);
        const taskSessionsInitialized = this.ensureTaskSessionsForGroups();
        const normalized = this.normalizeSupportedAgents();
        const pruned = this.pruneUnsupportedAgents();
        const interrupted = this.interruptRunningMissionsAfterLoad();
        if (workspaceReset || recovered || taskSessionsInitialized || normalized || pruned || interrupted) this.save();
        console.log('[store] Migrated legacy config from', legacyPath);
      } catch { /* ignore */ }
    }

    const legacyWfPath = path.join(
      os.homedir(), 'Library', 'Application Support', 'CLIBridge', 'workflows.json',
    );
    if (fs.existsSync(legacyWfPath)) {
      try {
        const data: WorkflowStorageData = JSON.parse(fs.readFileSync(legacyWfPath, 'utf-8'));
        this.workflows = data.workflows ?? [];
        this.workflowRuns = data.runs ?? [];
        this.saveWorkflows();
        console.log('[store] Migrated legacy workflows from', legacyWfPath);
      } catch { /* ignore */ }
    }
  }

  private migrateRoleIds(legacyRoles: { id: string; name: string }[]) {
    const nameToFixedId = new Map(ALL_ROLES.map(r => [r.name, r.id]));
    const legacyMap = new Map<string, string>();
    for (const old of legacyRoles) {
      const fixed = nameToFixedId.get(old.name);
      if (fixed) legacyMap.set(old.id, fixed);
    }
    if (legacyMap.size === 0) return;

    let migrated = false;
    for (const group of this.groups) {
      for (let i = 0; i < group.members.length; i++) {
        const rid = group.members[i].roleId;
        if (rid && legacyMap.has(rid)) {
          group.members[i] = { ...group.members[i], roleId: legacyMap.get(rid)! };
          migrated = true;
        }
      }
    }
    if (migrated) this.save();
  }

  private save() {
    const data: StorageData = {
      workspaceDataVersion: Store.WORKSPACE_DATA_VERSION,
      collaborationSchemaVersion: Store.COLLABORATION_SCHEMA_VERSION,
      agents: this.agents,
      groups: this.groups,
      taskCards: this.taskCards,
      taskSessions: this.taskSessions,
      issues: this.issues,
    };
    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
    this.onChange?.();
  }

  private interruptRunningMissionsAfterLoad(): boolean {
    const now = Date.now() / 1000;
    let changed = false;
    for (const mission of this.taskSessions) {
      if (
        mission.kind !== 'mission'
        || !['active', 'preparing', 'stalled'].includes(mission.status)
      ) {
        continue;
      }
      const group = this.groupById(mission.groupId);
      if (!group) continue;
      mission.status = 'interrupted';
      mission.interruptionReason = 'service_restarted';
      mission.interruptedAt = now;
      mission.updatedAt = now;
      mission.revision = (mission.revision ?? 0) + 1;
      for (const workItem of this.taskCards.filter(item => item.taskSessionId === mission.id)) {
        if (!['offered', 'accepted', 'active', 'waiting_dependency'].includes(workItem.status)) continue;
        workItem.interruptedFromStatus = workItem.status;
        workItem.status = 'interrupted';
        workItem.updatedAt = now;
        workItem.revision = (workItem.revision ?? 0) + 1;
        this.writeWorkItemFiles(group, mission, workItem);
      }
      this.writeMissionFiles(group, mission);
      this.appendMissionEvent(group, mission, 'mission.interrupted', 'reason=service_restarted');
      changed = true;
    }
    return changed;
  }

  private recoverMissionStateFromMarkdown(): boolean {
    let changed = false;
    for (const group of this.groups) {
      if (group.groupType === 'direct' || !group.workingDirectory) continue;
      const tasksRoot = path.join(group.workingDirectory, '.ai-team', 'tasks');
      if (!fs.existsSync(tasksRoot)) continue;
      for (const missionId of fs.readdirSync(tasksRoot)) {
        const missionDir = path.join(tasksRoot, missionId);
        const missionPath = path.join(missionDir, 'mission.md');
        if (!fs.existsSync(missionPath) || !fs.statSync(missionPath).isFile()) continue;
        const snapshot = parseRecoverySnapshot(fs.readFileSync(missionPath, 'utf-8'));
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        const recoveredMission = snapshot as TaskSession;
        if (
          recoveredMission.id !== missionId
          || recoveredMission.groupId !== group.id
          || recoveredMission.kind !== 'mission'
          || typeof recoveredMission.revision !== 'number'
        ) continue;
        const missionIndex = this.taskSessions.findIndex(item => item.id === recoveredMission.id);
        const storedMission = this.taskSessions[missionIndex];
        if (!storedMission || (storedMission.revision ?? -1) < recoveredMission.revision) {
          if (missionIndex >= 0) this.taskSessions[missionIndex] = recoveredMission;
          else this.taskSessions.push(recoveredMission);
          changed = true;
        }

        const workItemsRoot = path.join(missionDir, 'work-items');
        if (fs.existsSync(workItemsRoot)) {
          for (const workItemId of fs.readdirSync(workItemsRoot)) {
            const briefPath = path.join(workItemsRoot, workItemId, 'brief.md');
            if (!fs.existsSync(briefPath)) continue;
            const workSnapshot = parseRecoverySnapshot(fs.readFileSync(briefPath, 'utf-8'));
            if (!workSnapshot || typeof workSnapshot !== 'object' || Array.isArray(workSnapshot)) continue;
            const recoveredWorkItem = workSnapshot as TaskCard;
            if (
              recoveredWorkItem.id !== workItemId
              || recoveredWorkItem.groupId !== group.id
              || recoveredWorkItem.taskSessionId !== missionId
              || typeof recoveredWorkItem.revision !== 'number'
            ) continue;
            const workItemIndex = this.taskCards.findIndex(item => item.id === recoveredWorkItem.id);
            const storedWorkItem = this.taskCards[workItemIndex];
            if (!storedWorkItem || (storedWorkItem.revision ?? -1) < recoveredWorkItem.revision) {
              if (workItemIndex >= 0) this.taskCards[workItemIndex] = recoveredWorkItem;
              else this.taskCards.push(recoveredWorkItem);
              changed = true;
            }
          }
        }

        const issuesRoot = path.join(missionDir, 'issues');
        if (fs.existsSync(issuesRoot)) {
          for (const issueId of fs.readdirSync(issuesRoot)) {
            const issueDirectory = path.join(issuesRoot, issueId);
            if (!fs.statSync(issueDirectory).isDirectory()) continue;
            const latest = fs.readdirSync(issueDirectory)
              .filter(file => /^v\d+\.md$/.test(file))
              .sort()
              .at(-1);
            if (!latest) continue;
            const issueSnapshot = parseRecoverySnapshot(
              fs.readFileSync(path.join(issueDirectory, latest), 'utf-8'),
            );
            if (!issueSnapshot || typeof issueSnapshot !== 'object' || Array.isArray(issueSnapshot)) continue;
            const recoveredIssue = issueSnapshot as CollaborationIssue;
            if (
              recoveredIssue.id !== issueId
              || recoveredIssue.groupId !== group.id
              || recoveredIssue.missionId !== missionId
              || typeof recoveredIssue.revision !== 'number'
            ) continue;
            const issueIndex = this.issues.findIndex(item => (
              item.missionId === missionId && item.id === recoveredIssue.id
            ));
            const storedIssue = this.issues[issueIndex];
            if (!storedIssue || (storedIssue.revision ?? -1) < recoveredIssue.revision) {
              if (issueIndex >= 0) this.issues[issueIndex] = recoveredIssue;
              else this.issues.push(recoveredIssue);
              changed = true;
            }
          }
        }
      }

      const current = group.activeTaskSessionId
        ? this.taskSessionById(group.activeTaskSessionId)
        : undefined;
      if (!current || ['completed', 'cancelled', 'archived'].includes(current.status)) {
        const recoveredActive = this.taskSessions
          .filter(mission => (
            mission.groupId === group.id
            && mission.kind === 'mission'
            && !['completed', 'cancelled', 'archived'].includes(mission.status)
          ))
          .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
        if (recoveredActive && group.activeTaskSessionId !== recoveredActive.id) {
          group.activeTaskSessionId = recoveredActive.id;
          changed = true;
        }
      }
    }
    return changed;
  }

  private resetLegacyCollaborationData(schemaVersion: number): boolean {
    if (schemaVersion >= Store.COLLABORATION_SCHEMA_VERSION) {
      for (const group of this.groups) {
        group.groupType = group.groupType === 'direct' ? 'direct' : 'collaboration';
        group.compositionStatus = group.groupType === 'direct' || group.members.length >= 2
          ? 'active'
          : 'composition_insufficient';
        group.roleLeaders ??= {};
      }
      return false;
    }

    const legacyGroups = this.groups.filter(group => group.groupType !== 'direct');
    const removedIds = new Set(legacyGroups.map(group => group.id));
    this.removedLegacyGroupIds = [...new Set([...this.removedLegacyGroupIds, ...removedIds])];

    for (const group of legacyGroups) {
      this.removeGeneratedTeamDirectory(group);
    }

    this.groups = this.groups
      .filter(group => !removedIds.has(group.id))
      .map(group => ({
        ...group,
        groupType: 'direct' as const,
        compositionStatus: 'active' as const,
        roleLeaders: {},
      }));
    this.taskCards = [];
    this.taskSessions = this.taskSessions.filter(session => !removedIds.has(session.groupId));
    this.issues = [];
    return legacyGroups.length > 0 || schemaVersion !== Store.COLLABORATION_SCHEMA_VERSION;
  }

  private resetLegacyWorkspaceData(workspaceDataVersion: number): boolean {
    if (workspaceDataVersion >= Store.WORKSPACE_DATA_VERSION) return false;

    this.removedLegacyGroupIds = this.groups.map(group => group.id);
    for (const group of this.groups) this.removeGeneratedTeamDirectory(group);

    this.agents = [];
    this.groups = [];
    this.taskCards = [];
    this.taskSessions = [];
    this.issues = [];
    this.didResetWorkData = true;
    return true;
  }

  private removeGeneratedTeamDirectory(group: AgentGroup) {
    if (!group.workingDirectory) return;
    const teamDir = path.join(group.workingDirectory, '.ai-team');
    const contextPath = path.join(teamDir, 'context.md');
    try {
      if (!fs.existsSync(contextPath)) return;
      const context = fs.readFileSync(contextPath, 'utf-8');
      if (!context.includes('# AI 团队协作入口')) return;
      fs.rmSync(teamDir, { recursive: true, force: true });
    } catch { /* preserve unknown project files when cleanup cannot be verified */ }
  }

  private normalizeSupportedAgents(): boolean {
    let changed = false;
    this.agents = this.agents.map(agent => {
      if (!isSupportedAgentPlatform((agent as Partial<Agent>).platform)) return agent;
      const supported = getSupportedAgent(agent.platform);
      if (agent.name === supported.name && agent.command === supported.command) return agent;
      changed = true;
      return {
        ...agent,
        name: supported.name,
        command: supported.command,
      };
    });
    return changed;
  }

  private pruneUnsupportedAgents(): boolean {
    const supportedAgentIds = new Set(
      this.agents
        .filter(agent => isSupportedAgentPlatform((agent as Partial<Agent>).platform))
        .map(agent => agent.id),
    );
    if (supportedAgentIds.size === this.agents.length) return false;

    this.agents = this.agents.filter(agent => supportedAgentIds.has(agent.id));
    for (const group of this.groups) {
      group.members = group.members.filter(member => supportedAgentIds.has(member.agentId));
    }
    return true;
  }

  private loadWorkflows() {
    try {
      if (!fs.existsSync(this.workflowPath)) return;
      const data: WorkflowStorageData = JSON.parse(fs.readFileSync(this.workflowPath, 'utf-8'));
      this.workflows = data.workflows ?? [];
      this.workflowRuns = data.runs ?? [];
      if (this.didResetWorkData) {
        this.workflows = [];
        this.workflowRuns = [];
        this.saveWorkflows();
        return;
      }
      if (this.removedLegacyGroupIds.length > 0) {
        const removed = new Set(this.removedLegacyGroupIds);
        this.workflows = this.workflows.filter(workflow => !removed.has(workflow.groupId));
        this.workflowRuns = this.workflowRuns.filter(run => !removed.has(run.groupId));
        this.saveWorkflows();
      }
    } catch { /* start fresh */ }
  }

  private saveWorkflows() {
    const data: WorkflowStorageData = {
      workflows: this.workflows,
      runs: this.workflowRuns,
    };
    fs.writeFileSync(this.workflowPath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
