import type {
  AgentGroup,
  IssueSeverity,
  MissionQualityPolicy,
  MissionTemplate,
} from './models.js';

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

export const DEFAULT_BLOCKING_SEVERITIES: IssueSeverity[] = ['blocker', 'major'];

export function defaultMissionQualityPolicy(): MissionQualityPolicy {
  return {
    blockingSeverities: [...DEFAULT_BLOCKING_SEVERITIES],
    sharedStateTestExecution: 'serial',
  };
}

export function missionTemplateRoleIds(template: MissionTemplate): string[] {
  switch (template) {
    case 'feature':
      return [
        'role-product-manager',
        'role-developer',
        'role-code-reviewer',
        'role-tester',
        'role-committer',
      ];
    case 'bugfix':
    case 'refactor':
      return ['role-developer', 'role-code-reviewer', 'role-tester', 'role-committer'];
    case 'discussion':
      return ['role-product-manager'];
    case 'review':
      return ['role-code-reviewer'];
    case 'test':
      return ['role-tester'];
    case 'documentation':
      return ['role-product-manager', 'role-developer'];
    case 'submission':
      return ['role-developer', 'role-committer'];
    case 'generic':
      return ['role-developer'];
  }
}

export function generateMissionDraft(goal: string, group: AgentGroup): GeneratedMissionDraft {
  const objective = goal.trim().replace(/\r\n/g, '\n');
  if (!objective) throw new Error('goal required');
  const template = inferMissionTemplate(objective);
  const roleIds = missionTemplateRoleIds(template);
  const firstClause = objective.split(/[，。；;\n]/, 1)[0]?.trim() || objective;
  const title = firstClause.length > 40 ? `${firstClause.slice(0, 40)}…` : firstClause;
  const initialOwnerMemberId = roleIds
    .map(roleId => group.roleLeaders[roleId])
    .find((memberId): memberId is string => !!memberId);
  const missingRoleIds = roleIds.filter(roleId => !group.roleLeaders[roleId]);

  return {
    title,
    objective,
    template,
    acceptanceCriteria: generatedAcceptanceCriteria(template),
    roleIds,
    initialOwnerMemberId,
    missingRoleIds,
    qualityPolicy: defaultMissionQualityPolicy(),
  };
}

function inferMissionTemplate(goal: string): MissionTemplate {
  const normalized = goal.toLowerCase();
  const rules: Array<[MissionTemplate, RegExp]> = [
    ['bugfix', /(bug|fix|修复|故障|报错|崩溃|异常|不生效|错误)/i],
    ['refactor', /(refactor|重构|架构调整|技术债)/i],
    ['review', /(code review|代码审查|审计|review)/i],
    ['test', /(测试|验证|验收|回归)/i],
    ['documentation', /(文档|readme|说明书|操作手册)/i],
    ['discussion', /(讨论|调研|方案设计|技术选型|产品方案)/i],
    ['feature', /(新增|新功能|实现|开发|支持|增加|优化)/i],
    ['submission', /(draft\s*pr|pull request|创建\s*pr|提交当前|push|推送分支|合并请求)/i],
  ];
  return rules.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'generic';
}

function generatedAcceptanceCriteria(template: MissionTemplate): string[] {
  const common = ['目标中描述的预期结果可复现并有明确证据', '没有引入目标范围之外的未说明变更'];
  switch (template) {
    case 'bugfix':
      return ['原问题可稳定复现且修复后不再出现', '相关既有流程完成回归验证', ...common];
    case 'feature':
      return ['主要用户路径符合目标描述', '异常与边界场景有明确处理', ...common];
    case 'refactor':
      return ['对外行为保持兼容或差异已获群主确认', '相关自动化测试与构建通过', ...common];
    case 'review':
      return ['审查覆盖规格要求的全部质量维度', '所有阻断问题均已关闭或由群主显式接受风险', ...common];
    case 'test':
      return ['测试报告包含命令、环境、退出码、关键输出和证据路径', '业务验收结论明确', ...common];
    case 'documentation':
      return ['文档内容准确且步骤可执行', '涉及的链接、命令和示例已验证', ...common];
    case 'submission':
      return ['提交内容与批准实现修订一致', '任务分支已 push 并创建 Draft PR', ...common];
    case 'discussion':
      return ['结论记录共识、分歧、选择及理由', '原始参与者意见均被保留', ...common];
    case 'generic':
      return ['交付物与目标逐项对应', '完成必要验证并记录证据', ...common];
  }
}
