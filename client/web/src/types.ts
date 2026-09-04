import type { AgentPlatform } from './agent-platforms';

export type GroupType = 'collaboration' | 'direct';
export type GroupCompositionStatus = 'active' | 'composition_insufficient';
export type TaskStatus =
  | 'planned'
  | 'offered'
  | 'assigned'
  | 'accepted'
  | 'active'
  | 'waiting_dependency'
  | 'waiting_collab'
  | 'waiting_human'
  | 'submitted'
  | 'reviewing'
  | 'accepted_result'
  | 'changes_requested'
  | 'completed'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'stalled'
  | 'pending_human_verification'
  | 'interrupted';
export type MessageStatus = 'streaming' | 'complete';
export type AgentPresenceState = 'offline' | 'online' | 'busy' | 'error';
export type GitChangeKind = 'added' | 'modified' | 'deleted';
export type GitChangeSection = 'staged' | 'unstaged' | 'untracked';
export type TaskSessionStatus =
  | 'draft'
  | 'preparing'
  | 'active'
  | 'waiting_human'
  | 'stalled'
  | 'interrupted'
  | 'protocol_error'
  | 'external_change_detected'
  | 'ready_for_owner'
  | 'completed'
  | 'cancelled'
  | 'archived';
export type MissionTemplate =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'discussion'
  | 'review'
  | 'test'
  | 'documentation'
  | 'submission'
  | 'generic';
export type MissionPhaseStatus = 'planned' | 'active' | 'passed' | 'missing' | 'waived' | 'blocked';
export type MissingRoleResolution =
  | 'owner_supplies'
  | 'waive'
  | 'owner_handles'
  | 'external_implementation'
  | 'remove_irrelevant';
export type WorkItemKind =
  | 'phase'
  | 'discussion'
  | 'consultation'
  | 'clarification'
  | 'handoff'
  | 'rework'
  | 'review'
  | 'test';
export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'suggestion';
export type CollaborationIssueStatus = 'open' | 'resolved' | 'reopened' | 'accepted_risk';

export interface Agent {
  id: string;
  platform: AgentPlatform;
  name: string;
  command: string;
  avatarColor: string;
}

export type AgentStartupPromptKind = 'workspace-trust' | 'bypass-permissions';
export type AgentStartupPromptAction = 'accept' | 'decline';

export interface AgentStartupPrompt {
  kind: AgentStartupPromptKind;
  agentId: string;
  agentName: string;
  groupId: string;
  directory: string;
  rawPreview: string;
  detectedAt: number;
  updatedAt: number;
}

export interface Role {
  id: string;
  name: string;
  responsibility: string;
}

export interface GroupMember {
  id: string;
  agentId: string;
  roleId: string | null;
}

export interface AgentGroup {
  id: string;
  name: string;
  ownerName: string;
  members: GroupMember[];
  workingDirectory?: string;
  groupType: GroupType;
  compositionStatus?: GroupCompositionStatus;
  /** roleId -> leader memberId */
  roleLeaders?: Record<string, string>;
  activeTaskSessionId?: string;
  pausedByMissionId?: string;
  createdAt: number;
  archivedAt?: number;
}

export interface TaskSession {
  id: string;
  groupId: string;
  title: string;
  kind?: 'direct' | 'mission';
  objective?: string;
  template?: MissionTemplate;
  status: TaskSessionStatus;
  revision?: number;
  acceptanceCriteria?: string[];
  qualityPolicy?: MissionQualityPolicy;
  phases?: MissionPhase[];
  leaderSnapshot?: Record<string, string>;
  initialOwnerMemberId?: string;
  requiredMemberIds?: string[];
  missingRoleDecisions?: MissingRoleDecision[];
  currentPhaseId?: string;
  reworkRound?: number;
  maxReworkRounds?: number;
  gitBaseline?: MissionGitBaseline;
  implementationRevisions?: ImplementationRevision[];
  currentImplementationRevisionId?: string;
  requirementsRevisions?: RequirementsRevision[];
  currentRequirementsRevision?: number;
  submission?: MissionSubmission;
  autoMergeAuthorized?: boolean;
  ownerDecisionHistory?: MissionOwnerDecision[];
  protocolFailureCounts?: Record<string, number>;
  protocolErrorMemberId?: string;
  interruptionReason?: string;
  interruptedAt?: number;
  createdAt: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  archivedAt?: number;
}

export interface MissionQualityPolicy {
  blockingSeverities: IssueSeverity[];
  sharedStateTestExecution: 'serial';
}

export interface GeneratedMissionDraft {
  title: string;
  objective: string;
  template: MissionTemplate;
  acceptanceCriteria: string[];
  roleIds: string[];
  initialOwnerMemberId?: string;
  missingRoleIds: string[];
  qualityPolicy: MissionQualityPolicy;
}

export interface MissionOwnerDecision {
  action:
    | 'complete'
    | 'cancel'
    | 'pause'
    | 'request_changes'
    | 'accept_risk'
    | 'extend_rework'
    | 'incorporate_external_changes'
    | 'discard_external_changes'
    | 'import_external_implementation'
    | 'reassign'
    | 'resume';
  note: string;
  decidedAt: number;
}

export interface MissionPhase {
  id: string;
  name: string;
  roleId: string;
  leaderMemberId?: string;
  status: MissionPhaseStatus;
  required: boolean;
  order: number;
}

export interface MissingRoleDecision {
  roleId: string;
  resolution: MissingRoleResolution;
  note: string;
  decidedAt: number;
}

export interface MissionGitBaseline {
  repositoryRoot: string;
  baseBranch: string;
  baseCommit: string;
  taskBranch: string;
  preparedAt: number;
}

export interface ImplementationRevision {
  id: string;
  baseCommit: string;
  branch: string;
  contentHash: string;
  changedFiles: string[];
  patchArtifact: string;
  manifestArtifact: string;
  createdAt: number;
}

export interface RequirementsRevision {
  version: number;
  artifact: string;
  contentHash: string;
  sourceWorkItemId?: string;
  createdAt: number;
}

export interface MissionSubmission {
  revisionId: string;
  revisionContentHash: string;
  branch: string;
  commitSha: string;
  prUrl: string;
  draft: boolean;
  recordedAt: number;
  mergeCommitSha?: string;
  mergedAt?: number;
}

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  groupId: string;
  taskSessionId?: string;
  creatorName: string;
  ownerAgentId: string;
  ownerMemberId?: string;
  roleId?: string;
  phaseId?: string;
  kind?: WorkItemKind;
  revision?: number;
  contextRevision?: number;
  dependsOn?: string[];
  parentWorkItemId?: string;
  reassignedFromWorkItemId?: string;
  reassignedToWorkItemId?: string;
  returnIssueId?: string;
  returnToPhaseId?: string;
  implementationRevisionId?: string;
  requirementsRevision?: number;
  collaboratorAgentIds: string[];
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  evidence?: string;
  artifact?: string;
  nextStep?: string;
  offeredAt?: number;
  acceptedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  progressSummary?: string;
  resumeStatus?: TaskStatus;
  unresponsiveAt?: number;
  progressReminderAt?: number;
  stalledAt?: number;
  interruptedFromStatus?: TaskStatus;
  discussionRound?: number;
  discussionStage?: 'independent' | 'critique' | 'synthesis';
}

export interface CollaborationIssue {
  id: string;
  missionId: string;
  groupId: string;
  workItemId: string;
  reporterMemberId: string;
  roleId: string;
  title: string;
  summary: string;
  severity: IssueSeverity;
  status: CollaborationIssueStatus;
  revision?: number;
  evidenceArtifact: string;
  requirementsRevision?: number;
  implementationRevisionId?: string;
  reopenCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'system';
  content: string;
  timestamp: number;
  toolName?: string;
  tokens?: { input: number; output: number; reasoning: number };
  cost?: number;
  phase?: 'commentary' | 'final_answer';
  source?: 'codex_jsonl_event' | 'codex_jsonl_response_item' | 'codex_jsonl_task_complete';
  turnId?: string;
  itemType?: string;
  dedupeKey?: string;
  metrics?: { durationMs?: number; timeToFirstTokenMs?: number };
  humanInput?: HumanInputRequest;
}

export interface HumanInputOption {
  label: string;
  description?: string;
}

export interface HumanInputQuestion {
  id: string;
  header?: string;
  question: string;
  options: HumanInputOption[];
  multiSelect?: boolean;
}

export interface HumanInputRequest {
  callId: string;
  status: 'pending' | 'answered';
  autoResolutionMs?: number;
  questions: HumanInputQuestion[];
  selectedAnswers?: Record<string, string[]>;
}

export interface Envelope {
  id: string;
  from: string;
  to: string;
  body: string;
  ts: number;
  groupId?: string;
  taskSessionId?: string;
  clientMsgId?: string;
  entries?: ConversationEntry[];
  status?: MessageStatus;
}

export interface AppState {
  agents: Agent[];
  groups: AgentGroup[];
  roles: Role[];
  taskSessions: TaskSession[];
  workItems?: WorkItem[];
  issues?: CollaborationIssue[];
  messages: Envelope[];
  runningAgentIdsByGroup: Record<string, string[]>;
  busyAgentIdsByGroup?: Record<string, string[]>;
  port: number;
  isRunning: boolean;
  platformInstallState?: Partial<Record<AgentPlatform, boolean>>;
  enabledAgentPlatforms?: AgentPlatform[];
  workspaceDataVersion?: number;
  agentErrorsByGroup: Record<string, Record<string, string>>;
}

export interface RelayConfig {
  enabled: boolean;
  url: string;
  deviceId: string;
  deviceName: string;
  authorized: boolean;
  accountLabel?: string;
}

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  deviceId: string;
  deviceName: string;
  authorized: boolean;
  accountLabel?: string;
  authorizationState: 'signed_out' | 'pending' | 'authorized';
  verificationUri?: string;
  userCode?: string;
  authorizationExpiresAt?: string;
  lastError: string | null;
}

export interface OctrixCliStatus {
  path: string;
  state: 'not_installed' | 'outdated' | 'current';
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
}

/** 本机扫描得到的 Skill 项（服务端 /api/skills） */
export interface SkillListItem {
  id: string;
  name: string;
  skillMdPath: string;
  rootPath: string;
  sourceTag: string;
  summary: string | null;
}

/** 静态维护的 CLI slash command 项（服务端 /api/cli-commands） */
export interface CliCommandItem {
  id: string;
  platform: AgentPlatform;
  name: string;
  description: string;
  insertText: string;
  aliases?: string[];
  argumentHint?: string;
}

export interface GitStatusEntry {
  path: string;
  previousPath?: string;
  kind: GitChangeKind;
  section: GitChangeSection;
  staged: boolean;
  x: string;
  y: string;
}

export interface GitWorkspaceStatus {
  isGitRepository: boolean;
  branch: string | null;
  repositoryRoot: string | null;
  entries: GitStatusEntry[];
}

export interface GitDiffSnapshot {
  exists: boolean;
  isBinary: boolean;
  text: string;
}

export interface GitDiffView {
  path: string;
  kind: GitChangeKind;
  section: GitChangeSection;
  staged: boolean;
  before: GitDiffSnapshot;
  after: GitDiffSnapshot;
  beforeLabel: string;
  afterLabel: string;
  isBinary: boolean;
}

export const AVAILABLE_COLORS = [
  'blue', 'green', 'orange', 'purple', 'pink', 'red', 'teal', 'indigo', 'mint', 'cyan',
];

export const COLOR_MAP: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22c55e',
  orange: '#f97316',
  purple: '#a855f7',
  pink: '#ec4899',
  red: '#ef4444',
  teal: '#14b8a6',
  indigo: '#6366f1',
  mint: '#34d399',
  cyan: '#06b6d4',
};
