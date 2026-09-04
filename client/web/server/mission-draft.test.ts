import { describe, expect, it } from 'vitest';
import { generateMissionDraft } from './mission-draft';
import { createAgentGroup, createGroupMember } from './models';

describe('generateMissionDraft', () => {
  it('turns one natural-language goal into an editable bug-fix charter', () => {
    const developer = createGroupMember('agent-dev', 'role-developer');
    const reviewer = createGroupMember('agent-review', 'role-code-reviewer');
    const group = createAgentGroup(
      '修复小组',
      '群主',
      [developer, reviewer],
      '/tmp/project',
      'collaboration',
      {
        'role-developer': developer.id,
        'role-code-reviewer': reviewer.id,
      },
    );

    const draft = generateMissionDraft(
      '修复登录页验证码错误时没有提示的问题，并验证不会影响密码登录。',
      group,
    );

    expect(draft.template).toBe('bugfix');
    expect(draft.title).toContain('修复登录页验证码错误时没有提示的问题');
    expect(draft.objective).toContain('不会影响密码登录');
    expect(draft.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
    expect(draft.roleIds).toEqual([
      'role-developer',
      'role-code-reviewer',
      'role-tester',
      'role-committer',
    ]);
    expect(draft.initialOwnerMemberId).toBe(developer.id);
    expect(draft.missingRoleIds).toEqual(['role-tester', 'role-committer']);
    expect(draft.qualityPolicy.blockingSeverities).toEqual(['blocker', 'major']);
  });

  it('routes a submission goal through technical revision freeze before the committer phase', () => {
    const committer = createGroupMember('agent-commit', 'role-committer');
    const developer = createGroupMember('agent-dev', 'role-developer');
    const group = createAgentGroup(
      '发布小组',
      '群主',
      [committer, developer],
      '/tmp/project',
      'collaboration',
      {
        'role-committer': committer.id,
        'role-developer': developer.id,
      },
    );

    const draft = generateMissionDraft('提交当前改动、push 分支并创建 Draft PR', group);

    expect(draft.template).toBe('submission');
    expect(draft.roleIds).toEqual(['role-developer', 'role-committer']);
    expect(draft.initialOwnerMemberId).toBe(developer.id);
  });
});
