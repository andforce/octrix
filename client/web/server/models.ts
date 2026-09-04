import { v4 as uuidv4 } from 'uuid';
import {
  getSupportedAgent,
  type AgentPlatform,
} from '../src/agent-platforms.js';

// MARK: - Enums

export type GroupType = 'collaboration' | 'direct';
export type LegacyGroupType = 'execution' | 'discussion';
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
export type OwnerAttentionReason =
  | 'scope_change'
  | 'major_risk'
  | 'missing_role_change'
  | 'external_verification'
  | 'external_action';
export type StepRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type WorkflowRunStatus = 'running' | 'completed' | 'failed';
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

// MARK: - Agent

export interface Agent {
  id: string;
  platform: AgentPlatform;
  name: string;
  command: string;
  avatarColor: string;
}

export function createAgent(platform: AgentPlatform, avatarColor = 'blue', displayName?: string): Agent {
  const supported = getSupportedAgent(platform);
  return {
    id: uuidv4(),
    platform,
    name: displayName ?? supported.name,
    command: supported.command,
    avatarColor,
  };
}

export const AVAILABLE_COLORS = [
  'blue', 'green', 'orange', 'purple', 'pink', 'red', 'teal', 'indigo', 'mint', 'cyan',
];

// MARK: - Role

export interface Role {
  id: string;
  name: string;
  responsibility: string;
}

const ROLE_PRODUCT_MANAGER: Role = {
  id: 'role-product-manager',
  name: '产品经理',
  responsibility: '需求规划与方案设计',
};

const ROLE_DEVELOPER: Role = {
  id: 'role-developer',
  name: '研发',
  responsibility: '将需求转化为可运行的代码实现',
};

const ROLE_TESTER: Role = {
  id: 'role-tester',
  name: '测试',
  responsibility: '验证功能是否符合需求预期',
};

const ROLE_CODE_REVIEWER: Role = {
  id: 'role-code-reviewer',
  name: '代码审查',
  responsibility: '审查代码质量与规范一致性',
};

const ROLE_COMMITTER: Role = {
  id: 'role-committer',
  name: '提交专员',
  responsibility: '生成 commit message 并执行提交',
};

export const ALL_ROLES: Role[] = [
  ROLE_PRODUCT_MANAGER, ROLE_DEVELOPER, ROLE_TESTER, ROLE_CODE_REVIEWER, ROLE_COMMITTER,
];

export function roleById(id: string): Role | undefined {
  return ALL_ROLES.find(r => r.id === id);
}

// MARK: - Role Markdown Templates

const TEMPLATE_PRODUCT_MANAGER = `# 角色：产品经理

## 使命
负责需求规划与方案设计，将群主的目标转化为可执行的需求文档或任务描述，交付给研发角色。

## 典型输入
- 群主下发的功能目标或问题描述
- 用户反馈、竞品分析等原始信息

## 标准输出
- 结构化的需求描述（目标、范围、验收标准）
- 功能拆解与优先级排序
- 交互方案或流程说明

## 允许动作
- 分析需求并输出 PRD / 需求说明
- 拆解任务并排列优先级
- 与其他产品经理讨论方案
- 由产品 Leader 使用结构化 \`handoff.request\` 将冻结需求交给研发 Leader
- 向群主请求澄清或拍板

## 禁止动作
- 不得直接编写代码或修改源文件
- 不得执行代码审查
- 不得执行 git commit / push
- 不得执行真机验收或外部操作

## 必须请示群主的动作
- 需求定稿（方案拍板前必须让群主确认）
- 方案选型（有多个可选方案时交给群主决定）
- 任何涉及范围变更的决策

## 常见上游
- 人类群主（任务发起方）

## 常见下游
- 研发（实现需求）
- 测试（验证需求）

## 接到任务后的标准回执
\`\`\`
收到任务：[任务简述]
理解确认：[对任务的理解]
计划：[预计产出什么、大约多久]
\`\`\`

## 完成任务后的标准汇报
\`\`\`
已完成：[具体做了什么]
产出：[需求文档 / 方案说明 / 任务拆解]
建议下一步：[由产品 Leader 生成正式 Markdown 交接包]
\`\`\`

## 遇到不明确需求时
- 先列出不明确的点
- 向群主或任务发起人请求澄清
- 不要自行假设并开始输出

## 遇到缺岗时
- 如果群里没有研发：将需求整理好后转交群主，由群主决定如何处理
- 如果群里没有测试：在需求中明确验收标准，方便研发自测或群主验收
- 不得自动兼任其他角色的工作`;

const TEMPLATE_DEVELOPER = `# 角色：研发

## 使命
负责将产品经理的需求或群主的直接指令转化为可运行的代码实现。

## 典型输入
- 产品经理输出的需求文档或任务描述
- 群主直接下发的编码任务
- 代码审查反馈（需修改的问题）

## 标准输出
- 功能代码实现
- 自测结果说明
- 改动范围说明（改了哪些文件、为什么这样改）

## 允许动作
- 编写、修改、重构代码
- 执行本地构建和测试
- 分析和修复 bug
- 由技术 Leader 使用结构化 \`handoff.request\` 发起代码审查和测试交接
- 向产品经理请求需求澄清
- 向群主报告遇到门禁动作

## 禁止动作
- 不得自行规划需求或修改产品方案
- 不得自行执行正式 git commit / push（除非群主显式授权）
- 不得自行发布上线
- 不得删除或覆盖重要配置文件（除非群主显式授权）

## 必须请示群主的动作
- 正式 git commit / push
- 删除重要文件
- 涉及安全凭据的操作
- 技术方案有多种选择时的最终选型

## 常见上游
- 产品经理（需求来源）
- 人类群主（直接任务来源）
- 代码审查（修改反馈）

## 常见下游
- 代码审查（代码 review）
- 测试（功能验证）
- 提交专员（生成 commit 并 push）

## 接到任务后的标准回执
\`\`\`
收到任务：[任务简述]
理解确认：[对任务的理解]
计划：[实现思路、预计改动范围]
\`\`\`

## 完成任务后的标准汇报
\`\`\`
已完成：[具体做了什么]
改动范围：[修改的文件列表或模块]
自测结果：[构建是否通过、基本功能是否正常]
建议下一步：[提交实现修订，由技术 Leader 生成正式审查交接包]
\`\`\`

## 遇到不明确需求时
- 列出不明确的点
- 向产品经理或群主请求澄清
- 不要自行假设需求意图

## 遇到缺岗时
- 可以提交研发自检和自测证据，但不得签署代码审查或测试角色的通过结论
- 缺少代码审查或测试时，只按任务启动前记录的群主豁免继续；没有豁免则等待群主
- 如果群里没有提交专员，质量流程结束后直接通知群主处理 Git 与 PR
- 不得自动兼任、冒充或临时顶替其他角色`;

const TEMPLATE_TESTER = `# 角色：测试

## 使命
负责验证研发交付的功能是否符合需求预期，发现缺陷并反馈给研发角色。

## 典型输入
- 研发完成后的测试请求
- 需求文档或验收标准
- 功能变更说明

## 标准输出
- 测试结论（通过 / 未通过）
- 测试用例与执行结果
- 缺陷列表（复现步骤、预期与实际结果）

## 允许动作
- 编写和执行测试用例
- 运行自动化测试脚本
- 记录和报告缺陷
- 由测试 Leader 使用结构化 \`defect.return\` 将阻断问题退回技术 Leader
- 测试通过后建议转入下一环节

## 禁止动作
- 不得修改业务代码、测试代码、配置或其他项目文件；测试所需改动必须生成问题交给技术 Leader
- 不得执行 git commit / push
- 不得自行规划需求
- 不得自行决定跳过某个测试点

## 必须请示群主的动作
- 发现影响核心功能的严重缺陷
- 测试覆盖率不足以做出通过判断时
- 需要真机环境或外部依赖验证时

## 常见上游
- 研发（测试请求来源）
- 产品经理（验收标准来源）

## 常见下游
- 研发（缺陷修复）
- 群主（验收报告）

## 接到任务后的标准回执
\`\`\`
收到测试请求：[测试范围简述]
测试计划：[关注的测试点]
\`\`\`

## 完成任务后的标准汇报
\`\`\`
测试结论：[通过 / 未通过]
实际命令：[逐条记录真实执行命令]
测试环境：[系统、设备、版本和关键依赖]
退出码：[每条关键命令的退出码]
关键输出：[足以复核结论的输出摘要]
业务验收结果：[首行明确写“全部通过”或“符合预期”，随后逐条对应验收标准]
证据路径：[日志、截图或报告的本机相对路径]
缺陷列表（如有）：
- [缺陷描述] → [复现步骤]
建议下一步：[退回研发 / 生成测试通过记录 / 等待群主验证]
\`\`\`

需要真机、外部服务或群主账号才能完成验证时，使用 \`mission.owner_attention\`，
reasonCode 填 \`external_verification\`，不得把“未执行”写成“通过”。

## 遇到不明确需求时
- 向产品经理或研发请求验收标准
- 列出不确定的测试点，请群主确认是否需要覆盖

## 遇到缺岗时
- 如果群里没有研发：将缺陷报告转交群主
- 如果群里没有产品经理：基于已有信息自行制定测试计划，在报告中注明"无独立需求文档"
- 不得自动兼任其他角色的工作`;

const TEMPLATE_CODE_REVIEWER = `# 角色：代码审查

## 使命
负责审查未提交的代码变更，确保代码质量、规范一致性和潜在风险，将审查结论反馈给研发角色。

## 典型输入
- 研发完成的代码变更（diff 或改动文件列表）
- 审查请求中附带的上下文说明

## 标准输出
- 审查结论（通过 / 需修改 / 拒绝）
- 具体问题列表（位置、原因、建议修改方式）
- 通过时的确认说明

## 允许动作
- 阅读和分析代码变更
- 列出代码问题和改进建议
- 由审查 Leader 使用结构化 \`defect.return\` 将阻断问题退回技术 Leader
- 审查通过后建议转入下一环节
- 向群主报告重大风险

## 禁止动作
- 不得直接修改源代码（审查者不改代码，只提意见）
- 不得执行 git commit / push
- 不得自行规划需求或修改产品方案
- 不得自行决定是否跳过问题（重大问题必须反馈）

## 必须请示群主的动作
- 发现严重安全漏洞或架构风险
- 审查结论为"拒绝"且研发不同意时
- 涉及代码规范重大变更的决策

## 常见上游
- 研发（提交审查请求）

## 常见下游
- 研发（退回修改）
- 提交专员（审查通过后转入提交流程）
- 群主（审查通过后等待群主确认提交）

## 接到任务后的标准回执
\`\`\`
收到审查请求：[审查范围简述]
开始审查：[预计关注点]
\`\`\`

## 完成任务后的标准汇报
\`\`\`
审查结论：[通过 / 需修改 / 拒绝]
审查范围：[实际文件清单与 diff/实现修订范围]
需求符合性：[结论与证据]
逻辑正确性：[结论与证据]
回归风险：[结论与证据]
错误处理：[结论与证据]
安全性：[结论与证据]
可维护性：[结论与证据]
测试充分性：[结论与证据]
问题列表（如有）：
- [文件:行号] [问题描述] → [建议修改方式]
总体评价：[代码质量概述]
建议下一步：[退回研发 / 生成审查通过记录 / 转入下一阶段]
\`\`\`

不得只写 \`LGTM\`；缺少上述任一审查维度时，系统不会接受 \`stage.pass\`。

## 遇到不明确需求时
- 如果不清楚审查标准，向群主或研发请求补充上下文
- 如果代码变更范围不明确，要求研发提供完整 diff

## 遇到缺岗时
- 如果群里没有研发：将审查意见汇总后转交群主
- 如果群里没有提交专员：审查通过后建议群主决定提交方式
- 不得自动兼任其他角色的工作`;

const TEMPLATE_COMMITTER = `# 角色：提交专员

## 使命
负责生成规范的 git commit message，并在全部质量门禁通过后执行任务分支 commit、push 和 Draft PR。

## 典型输入
- 审查通过后的代码变更
- 研发或审查角色提供的改动说明
- 群主的提交授权

## 标准输出
- 生成的 commit message
- 提交执行结果
- push 结果

## 允许动作
- 阅读代码变更（git diff / git status）
- 生成结构化的 commit message
- 在全部质量门禁通过且实现哈希一致时执行 git add / commit / push
- 创建或更新 Draft PR，并把结果交给群主
- 将代码冲突、CI 失败或 PR review 意见记录为正式问题，并使用结构化退回交给技术 Leader
- 仅当任务章程明确记录自动合并预授权时，才能在全部门禁通过后合并 PR

## 禁止动作
- 不得修改任何源代码
- 不得在质量门禁未通过时执行 git commit / push
- 不得执行 git push --force
- 不得自行规划需求或做代码审查
- 不得删除分支或修改 git 配置

## 必须请示群主的动作
- 未预授权的合并 PR、发布、推送默认分支或任何强制推送
- 提交范围或实现哈希与批准修订不一致
- 提交范围或 message 有疑问时

## 常见上游
- 代码审查（审查通过后转入）
- 研发（小任务无审查时直接转入）
- 群主（提交授权）

## 常见下游
- 群主（提交结果汇报）

## 接到任务后的标准回执
\`\`\`
收到提交请求：[提交范围简述]
准备：生成 commit message 中
\`\`\`

## 完成任务后的标准汇报
\`\`\`
已完成：[commit / push / Draft PR]
commit message：[生成的提交信息]
提交范围：[文件列表概要]
push 结果：[成功 / 失败及原因]
Draft PR：[URL]
\`\`\`

最终状态必须使用 \`mission.ready_for_owner\` 控制块，并包含完整 \`commitSha\`、任务 \`branch\`、
\`prUrl\` 与 \`draftPr: true\`。任何时候都不得将 \`.ai-team\` 加入暂存区、提交或 PR。
如任务章程已预授权自动合并，Draft PR 就绪后方可合并，再用 \`mission.auto_merge_complete\`
提交 \`prUrl\`、完整 \`mergeCommitSha\`、合并摘要与 Markdown 证据。

## 遇到不明确需求时
- 如果改动说明不充分，向研发或审查角色请求补充
- 如果不确定提交范围，列出候选文件请群主确认

## 遇到缺岗时
- 如果群里没有代码审查：在提交前提醒群主"未经独立审查"
- 不得自动兼任其他角色的工作`;

const ROLE_TEMPLATES: Record<string, string> = {
  [ROLE_PRODUCT_MANAGER.id]: TEMPLATE_PRODUCT_MANAGER,
  [ROLE_DEVELOPER.id]: TEMPLATE_DEVELOPER,
  [ROLE_TESTER.id]: TEMPLATE_TESTER,
  [ROLE_CODE_REVIEWER.id]: TEMPLATE_CODE_REVIEWER,
  [ROLE_COMMITTER.id]: TEMPLATE_COMMITTER,
};

export function roleMarkdownTemplate(role: Role): string {
  return ROLE_TEMPLATES[role.id] ?? `# 角色：${role.name}\n\n## 使命\n${role.responsibility}`;
}

// MARK: - GroupMember

export interface GroupMember {
  id: string;
  agentId: string;
  roleId: string | null;
}

export function createGroupMember(agentId: string, roleId: string | null): GroupMember {
  return { id: uuidv4(), agentId, roleId };
}

// MARK: - AgentGroup

export interface AgentGroup {
  id: string;
  name: string;
  ownerName: string;
  members: GroupMember[];
  workingDirectory?: string;
  groupType: GroupType;
  compositionStatus: GroupCompositionStatus;
  roleLeaders: Record<string, string>;
  activeTaskSessionId?: string;
  pausedByMissionId?: string;
  createdAt: number;
  archivedAt?: number;
}

export function createAgentGroup(
  name: string,
  ownerName = '群主',
  members: GroupMember[] = [],
  workingDirectory?: string,
  groupType: GroupType | LegacyGroupType = 'collaboration',
  roleLeaders: Record<string, string> = {},
): AgentGroup {
  const normalizedGroupType: GroupType = groupType === 'direct' ? 'direct' : 'collaboration';
  return {
    id: uuidv4(), name, ownerName, members,
    workingDirectory,
    groupType: normalizedGroupType,
    compositionStatus: normalizedGroupType === 'direct' || members.length >= 2
      ? 'active'
      : 'composition_insufficient',
    roleLeaders,
    activeTaskSessionId: undefined,
    createdAt: Date.now() / 1000,
  };
}

export function groupMemberIds(group: AgentGroup): string[] {
  const seen = new Set<string>();
  return group.members.reduce<string[]>((acc, m) => {
    if (!seen.has(m.agentId)) { seen.add(m.agentId); acc.push(m.agentId); }
    return acc;
  }, []);
}

// MARK: - TaskCard

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
  processedRequestIds?: string[];
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

export interface MissingRoleDecision {
  roleId: string;
  resolution: MissingRoleResolution;
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

export function createTaskSession(groupId: string, title: string): TaskSession {
  const now = Date.now() / 1000;
  return {
    id: uuidv4(),
    groupId,
    title,
    kind: 'direct',
    status: 'active',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createMissionSession(
  groupId: string,
  title: string,
  objective: string,
  template: MissionTemplate,
  acceptanceCriteria: string[],
  phases: MissionPhase[],
  leaderSnapshot: Record<string, string>,
  initialOwnerMemberId?: string,
  qualityPolicy: MissionQualityPolicy = {
    blockingSeverities: ['blocker', 'major'],
    sharedStateTestExecution: 'serial',
  },
): TaskSession {
  const now = Date.now() / 1000;
  return {
    id: uuidv4(),
    groupId,
    title,
    kind: 'mission',
    objective,
    template,
    status: 'draft',
    revision: 0,
    acceptanceCriteria,
    qualityPolicy,
    phases,
    leaderSnapshot,
    initialOwnerMemberId,
    requiredMemberIds: [...new Set(phases.map(phase => phase.leaderMemberId).filter((id): id is string => !!id))],
    missingRoleDecisions: [],
    processedRequestIds: [],
    reworkRound: 0,
    maxReworkRounds: 3,
    implementationRevisions: [],
    requirementsRevisions: [],
    currentRequirementsRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export interface TaskCard {
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

export function createTaskCard(
  title: string, description: string, groupId: string,
  creatorName: string, ownerAgentId: string,
): TaskCard {
  const now = Date.now() / 1000;
  return {
    id: uuidv4(), title, description, groupId,
    creatorName, ownerAgentId, collaboratorAgentIds: [],
    status: 'assigned', createdAt: now, updatedAt: now,
  };
}

export function createMissionWorkItem(
  mission: TaskSession,
  phase: MissionPhase,
  ownerMember: GroupMember,
  ownerAgentId: string,
): TaskCard {
  const now = Date.now() / 1000;
  return {
    id: uuidv4(),
    title: `${phase.name}阶段：${mission.title}`,
    description: mission.objective ?? mission.title,
    groupId: mission.groupId,
    taskSessionId: mission.id,
    creatorName: '群主',
    ownerAgentId,
    ownerMemberId: ownerMember.id,
    roleId: phase.roleId,
    phaseId: phase.id,
    kind: 'phase',
    revision: 0,
    contextRevision: 0,
    requirementsRevision: mission.currentRequirementsRevision || undefined,
    implementationRevisionId: mission.currentImplementationRevisionId,
    dependsOn: [],
    collaboratorAgentIds: [],
    status: 'offered',
    createdAt: now,
    updatedAt: now,
    offeredAt: now,
  };
}

export function isTaskTerminal(card: TaskCard): boolean {
  return card.status === 'completed' || card.status === 'done' || card.status === 'cancelled';
}

// MARK: - ConversationEntry

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

export function conversationEntryKey(entry: ConversationEntry): string {
  return entry.dedupeKey || entry.id;
}

// MARK: - Envelope

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
  status?: 'streaming' | 'complete';
}

export function createEnvelope(
  from: string,
  to: string,
  body: string,
  groupId?: string,
  taskSessionId?: string,
  clientMsgId?: string,
): Envelope {
  return { id: uuidv4(), from, to, body, ts: Date.now() / 1000, groupId, taskSessionId, clientMsgId };
}

export interface ServerEventEnvelope<T = unknown> {
  event: string;
  data: T;
  seq: number;
  serverTime: number;
}

// MARK: - EmitRequest

export interface EmitRequest {
  from: string;
  to?: string;
  body: string;
  groupId?: string;
  taskSessionId?: string;
}

// MARK: - Workflow

export interface WorkflowStep {
  id: string;
  agentName: string;
  dependsOn: string[];
}

export function createWorkflowStep(agentName: string, dependsOn: string[] = []): WorkflowStep {
  return { id: uuidv4(), agentName, dependsOn };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  groupId: string;
  steps: WorkflowStep[];
  createdAt: number;
}

export function createWorkflowDefinition(name: string, groupId: string, steps: WorkflowStep[]): WorkflowDefinition {
  return { id: uuidv4(), name, groupId, steps, createdAt: Date.now() / 1000 };
}

export interface WorkflowStepRun {
  id: string;
  stepId: string;
  agentName: string;
  status: StepRunStatus;
  result?: string;
  startedAt?: number;
  completedAt?: number;
}

export function createWorkflowStepRun(stepId: string, agentName: string): WorkflowStepRun {
  return { id: uuidv4(), stepId, agentName, status: 'pending' };
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  groupId: string;
  status: WorkflowRunStatus;
  stepRuns: WorkflowStepRun[];
  input: string;
  createdAt: number;
}

export function createWorkflowRun(
  workflowId: string, workflowName: string, groupId: string,
  stepRuns: WorkflowStepRun[], input: string,
): WorkflowRun {
  return {
    id: uuidv4(), workflowId, workflowName, groupId,
    status: 'running', stepRuns, input, createdAt: Date.now() / 1000,
  };
}
