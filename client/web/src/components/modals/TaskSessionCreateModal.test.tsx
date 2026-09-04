import {
  cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGroup, TaskSession } from '../../types';
import { TaskSessionCreateModal } from './TaskSessionCreateModal';

const mockedApi = {
  previewMission: vi.fn(),
  createMission: vi.fn(),
  updateMissionCharter: vi.fn(),
  resolveMissingRole: vi.fn(),
  startMission: vi.fn(),
  updateMissionPlan: vi.fn(),
  setMissionRoleLeader: vi.fn(),
};

vi.mock('../../lib/api', () => ({
  api: {
    previewMission: (...args: unknown[]) => mockedApi.previewMission(...args),
    createMission: (...args: unknown[]) => mockedApi.createMission(...args),
    updateMissionCharter: (...args: unknown[]) => mockedApi.updateMissionCharter(...args),
    resolveMissingRole: (...args: unknown[]) => mockedApi.resolveMissingRole(...args),
    startMission: (...args: unknown[]) => mockedApi.startMission(...args),
    updateMissionPlan: (...args: unknown[]) => mockedApi.updateMissionPlan(...args),
    setMissionRoleLeader: (...args: unknown[]) => mockedApi.setMissionRoleLeader(...args),
  },
}));

const group: AgentGroup = {
  id: 'group-1',
  name: '协作群',
  ownerName: '群主',
  members: [
    { id: 'member-dev', agentId: 'agent-dev', roleId: 'role-developer' },
    { id: 'member-review', agentId: 'agent-review', roleId: 'role-code-reviewer' },
  ],
  groupType: 'collaboration',
  compositionStatus: 'active',
  roleLeaders: {
    'role-developer': 'member-dev',
    'role-code-reviewer': 'member-review',
  },
  createdAt: 1,
};

function mission(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    id: 'mission-1',
    groupId: group.id,
    title: '实现协作任务',
    kind: 'mission',
    objective: '完成多 Agent 协作闭环',
    template: 'feature',
    status: 'draft',
    revision: 0,
    acceptanceCriteria: ['测试通过', '文档完整'],
    phases: [
      {
        id: 'phase-dev',
        name: '研发',
        roleId: 'role-developer',
        leaderMemberId: 'member-dev',
        status: 'planned',
        required: true,
        order: 1,
      },
    ],
    createdAt: 1,
    ...overrides,
  };
}

afterEach(cleanup);

describe('TaskSessionCreateModal mission charter', () => {
  beforeEach(() => {
    mockedApi.createMission.mockReset();
    mockedApi.previewMission.mockReset();
    mockedApi.updateMissionCharter.mockReset();
    mockedApi.resolveMissingRole.mockReset();
    mockedApi.startMission.mockReset();
    mockedApi.updateMissionPlan.mockReset();
    mockedApi.setMissionRoleLeader.mockReset();
  });

  it('creates a draft charter and starts only after explicit confirmation', async () => {
    const draft = mission();
    const onCreated = vi.fn();
    mockedApi.createMission.mockResolvedValue({ ok: true, mission: draft });
    mockedApi.startMission.mockResolvedValue({ ok: true, mission: { ...draft, status: 'active' } });

    render(<TaskSessionCreateModal group={group} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '实现协作任务' } });
    fireEvent.change(screen.getByLabelText('任务目标'), { target: { value: '完成多 Agent 协作闭环' } });
    fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '测试通过\n文档完整' } });
    fireEvent.click(screen.getByRole('button', { name: '生成任务章程' }));

    await waitFor(() => expect(mockedApi.createMission).toHaveBeenCalledWith(group.id, {
      title: '实现协作任务',
      objective: '完成多 Agent 协作闭环',
      template: 'feature',
      acceptanceCriteria: ['测试通过', '文档完整'],
      qualityPolicy: {
        blockingSeverities: ['blocker', 'major'],
        sharedStateTestExecution: 'serial',
      },
    }));
    expect(mockedApi.startMission).not.toHaveBeenCalled();
    expect(await screen.findByText('启动前确认')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认并启动' }));
    await waitFor(() => expect(mockedApi.startMission).toHaveBeenCalledWith(group.id, draft.id));
    expect(onCreated).toHaveBeenCalledWith(draft.id);
  });

  it('fills an editable charter from a natural-language goal', async () => {
    mockedApi.previewMission.mockResolvedValue({
      ok: true,
      draft: {
        title: '修复验证码提示',
        objective: '修复验证码错误时没有提示的问题',
        template: 'bugfix',
        acceptanceCriteria: ['错误验证码显示提示', '密码登录回归通过'],
        roleIds: ['role-developer', 'role-code-reviewer', 'role-tester', 'role-committer'],
        missingRoleIds: ['role-tester', 'role-committer'],
        qualityPolicy: {
          blockingSeverities: ['blocker', 'major'],
          sharedStateTestExecution: 'serial',
        },
      },
    });

    render(<TaskSessionCreateModal group={group} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('用自然语言描述目标'), {
      target: { value: '修复验证码错误时没有提示的问题' },
    });
    fireEvent.click(screen.getByRole('button', { name: '从目标生成可编辑建议' }));

    await waitFor(() => expect(mockedApi.previewMission).toHaveBeenCalledWith(
      group.id,
      '修复验证码错误时没有提示的问题',
    ));
    expect((screen.getByLabelText('任务名称') as HTMLInputElement).value).toBe('修复验证码提示');
    expect((screen.getByLabelText('任务模板') as HTMLSelectElement).value).toBe('bugfix');
    expect((screen.getByLabelText('验收标准') as HTMLTextAreaElement).value).toContain('密码登录回归通过');
  });

  it('requires a documented owner decision for a missing role', async () => {
    const missing = mission({
      phases: [{
        id: 'phase-test',
        name: '测试',
        roleId: 'role-tester',
        status: 'missing',
        required: true,
        order: 1,
      }],
    });
    const resolved = mission({
      revision: 1,
      phases: [{
        id: 'phase-test',
        name: '测试',
        roleId: 'role-tester',
        status: 'waived',
        required: false,
        order: 1,
      }],
    });
    mockedApi.createMission.mockResolvedValue({ ok: true, mission: missing });
    mockedApi.resolveMissingRole.mockResolvedValue({ ok: true, mission: resolved });

    render(<TaskSessionCreateModal group={group} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '测试缺岗任务' } });
    fireEvent.change(screen.getByLabelText('任务目标'), { target: { value: '验证缺岗决策' } });
    fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '决策留痕' } });
    fireEvent.click(screen.getByRole('button', { name: '生成任务章程' }));

    expect(await screen.findByText('测试角色缺岗')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('测试缺岗处理'), { target: { value: 'waive' } });
    fireEvent.change(screen.getByLabelText('测试缺岗说明'), { target: { value: '由群主承担最终验收风险' } });
    fireEvent.click(screen.getByRole('button', { name: '确认测试缺岗决策' }));

    await waitFor(() => expect(mockedApi.resolveMissingRole).toHaveBeenCalledWith(
      group.id,
      missing.id,
      'role-tester',
      'waive',
      '由群主承担最终验收风险',
    ));
    expect(await screen.findByText(/所有缺岗均已处理/)).toBeTruthy();
  });
});
