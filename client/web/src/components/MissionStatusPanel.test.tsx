import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentGroup, CollaborationIssue, TaskSession, WorkItem } from '../types';
import { MissionStatusPanel } from './MissionStatusPanel';

const group: AgentGroup = {
  id: 'group-1',
  name: '协作群',
  ownerName: '群主',
  members: [
    { id: 'member-dev', agentId: 'agent-dev', roleId: 'role-developer' },
    { id: 'member-review', agentId: 'agent-review', roleId: 'role-code-reviewer' },
  ],
  groupType: 'collaboration',
  createdAt: 1,
};

const mission: TaskSession = {
  id: 'mission-1',
  groupId: group.id,
  title: '协作协议升级',
  kind: 'mission',
  objective: '完成端到端协作',
  template: 'feature',
  status: 'active',
  currentPhaseId: 'phase-dev',
  phases: [
    { id: 'phase-dev', name: '研发', roleId: 'role-developer', status: 'active', required: true, order: 1 },
    { id: 'phase-review', name: '代码审查', roleId: 'role-code-reviewer', status: 'planned', required: true, order: 2 },
  ],
  gitBaseline: {
    repositoryRoot: '/repo',
    baseBranch: 'main',
    baseCommit: 'abc',
    taskBranch: 'octrix/mission-1',
    preparedAt: 1,
  },
  createdAt: 1,
};

const workItem: WorkItem = {
  id: 'work-1',
  title: '研发：协作协议升级',
  description: '实现',
  groupId: group.id,
  taskSessionId: mission.id,
  creatorName: 'system',
  ownerAgentId: 'agent-dev',
  ownerMemberId: 'member-dev',
  roleId: 'role-developer',
  phaseId: 'phase-dev',
  collaboratorAgentIds: [],
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};

afterEach(cleanup);

describe('MissionStatusPanel', () => {
  it('shows the phase, owner, branch, and blocking issues', () => {
    const issue: CollaborationIssue = {
      id: 'ISSUE-1',
      missionId: mission.id,
      groupId: group.id,
      workItemId: workItem.id,
      reporterMemberId: 'member-review',
      roleId: 'role-code-reviewer',
      title: '状态竞争',
      summary: '存在竞争条件',
      severity: 'blocker',
      status: 'open',
      evidenceArtifact: 'issues/ISSUE-1.md',
      reopenCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    render(
      <MissionStatusPanel
        group={group}
        mission={mission}
        workItems={[workItem]}
        issues={[issue]}
        agents={[{ id: 'agent-dev', platform: 'opencode', name: '研发一号', command: 'opencode', avatarColor: 'blue' }]}
        onConfigure={vi.fn()}
      />,
    );

    expect(screen.getByText('研发 · 进行中')).toBeTruthy();
    expect(screen.getByText(/负责人：研发一号/)).toBeTruthy();
    expect(screen.getByText('octrix/mission-1')).toBeTruthy();
    expect(screen.getByText('1 个阻断问题')).toBeTruthy();
  });

  it('lets the owner resume configuring a draft', () => {
    const onConfigure = vi.fn();
    render(
      <MissionStatusPanel
        group={group}
        mission={{ ...mission, status: 'draft' }}
        workItems={[]}
        issues={[]}
        agents={[]}
        onConfigure={onConfigure}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '继续配置并启动' }));
    expect(onConfigure).toHaveBeenCalled();
  });
});
