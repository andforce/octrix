import { useState, type Dispatch } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchContext, StoreContext, type Action } from '../hooks/useStore';
import { api } from '../lib/api';
import { Sidebar } from './Sidebar';
import type { AgentGroup, AppState } from '../types';

type TestStoreState = AppState & {
  initializingByGroup: Record<string, string[]>;
  streamingByGroup: Record<string, string[]>;
  selectedGroupId: string | null;
  selectedTaskSessionIdByGroup?: Record<string, string>;
  terminalAgentId: string | null;
  terminalGroupId: string | null;
  platformInstallState: NonNullable<AppState['platformInstallState']>;
};

vi.mock('../lib/api', () => ({
  api: {
    removeGroup: vi.fn(),
    goOnline: vi.fn(),
    goOffline: vi.fn(),
    removeMember: vi.fn(),
  },
}));

const group: AgentGroup = {
  id: 'group-1',
  name: '示例群聊',
  ownerName: '用户',
  members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
  groupType: 'collaboration',
  activeTaskSessionId: 'ts-group-1',
  createdAt: Date.now() / 1000,
};

const secondGroup: AgentGroup = {
  id: 'group-2',
  name: '执行群聊',
  ownerName: '用户',
  members: [{ id: 'member-2', agentId: 'agent-1', roleId: null }],
  groupType: 'collaboration',
  activeTaskSessionId: 'ts-group-2',
  createdAt: Date.now() / 1000,
};

function renderSidebar(groups: AgentGroup[] = [group]) {
  const state: TestStoreState = {
    agents: [{
      id: 'agent-1',
      platform: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      avatarColor: 'blue',
    }],
    groups,
    roles: [],
    taskSessions: groups.map(item => ({
      id: item.activeTaskSessionId ?? `ts-${item.id}`,
      groupId: item.id,
      title: '默认任务',
      status: 'active' as const,
      createdAt: Date.now() / 1000,
    })),
    messages: [],
    runningAgentIdsByGroup: {},
    initializingByGroup: {},
    streamingByGroup: {},
    agentErrorsByGroup: {},
    port: 9800,
    isRunning: true,
    platformInstallState: {},
    selectedGroupId: groups[0]?.id ?? null,
    selectedTaskSessionIdByGroup: Object.fromEntries(groups.map(item => [item.id, item.activeTaskSessionId ?? `ts-${item.id}`])),
    terminalAgentId: null,
    terminalGroupId: null,
  };

  return render(
    <StoreContext.Provider value={state as any}>
      <DispatchContext.Provider value={vi.fn()}>
        <Sidebar onShowCreateGroup={vi.fn()} onShowContacts={vi.fn()} onShowRelayConnect={vi.fn()} />
      </DispatchContext.Provider>
    </StoreContext.Provider>,
  );
}

describe('Sidebar group deletion', () => {
  beforeEach(() => {
    vi.mocked(api.removeGroup).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not delete a group on right click', () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText('示例群聊'));

    expect(api.removeGroup).not.toHaveBeenCalled();
    expect(screen.queryByText('删除群组')).toBeNull();
  });

  it('shows a confirmation dialog when the delete button is clicked', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '删除群组 示例群聊' }));

    expect(screen.getByText(/确定要删除群组/)).toBeTruthy();
    expect(screen.getByText('「示例群聊」', { exact: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(api.removeGroup).not.toHaveBeenCalled();
  });

  it('calls removeGroup only after confirming in the dialog', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '删除群组 示例群聊' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(api.removeGroup).toHaveBeenCalledWith(group.id);
  });

  it('does not delete when cancelling the dialog', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '删除群组 示例群聊' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(api.removeGroup).not.toHaveBeenCalled();
    expect(screen.queryByText(/确定要删除群组/)).toBeNull();
  });

  it('uses distinct stable avatar gradients for different groups', () => {
    renderSidebar([group, secondGroup]);

    const discussionAvatarStyle = screen.getByTestId('group-avatar-group-1').getAttribute('style');
    const executionAvatarStyle = screen.getByTestId('group-avatar-group-2').getAttribute('style');

    expect(discussionAvatarStyle).toContain('linear-gradient');
    expect(executionAvatarStyle).toContain('linear-gradient');
    expect(discussionAvatarStyle).not.toEqual(executionAvatarStyle);
  });
});

describe('Sidebar conversation row members expand', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows member panel with count and owner when group is selected (default expanded)', () => {
    const g: AgentGroup = {
      ...group,
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-pm' }],
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      groups: [g],
      roles: [{ id: 'role-pm', name: '产品经理', responsibility: '负责产品规划' }],
      taskSessions: [{ id: 'ts-group-1', groupId: 'group-1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'group-1',
      selectedTaskSessionIdByGroup: { 'group-1': 'ts-group-1' },
      terminalAgentId: null,
      terminalGroupId: null,
    };

    render(
      <StoreContext.Provider value={state as any}>
        <DispatchContext.Provider value={vi.fn()}>
          <Sidebar onShowCreateGroup={vi.fn()} onShowContacts={vi.fn()} onShowRelayConnect={vi.fn()} />
        </DispatchContext.Provider>
      </StoreContext.Provider>,
    );

    expect(screen.getByText('成员 (2)')).toBeTruthy();
    expect(screen.getByText('用户')).toBeTruthy();
    expect(screen.getByText('群主')).toBeTruthy();
    expect(screen.getByText('产品经理')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
  });

  it('collapses member panel when chevron is clicked again', () => {
    renderSidebar();

    expect(screen.getByText('成员 (2)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起群成员' }));
    expect(screen.queryByText('成员 (2)')).toBeNull();
  });

  it('shows error presence title for failed member startup', () => {
    const state: TestStoreState = {
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      groups: [group],
      roles: [],
      taskSessions: [{ id: 'ts-group-1', groupId: 'group-1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: { 'group-1': { 'agent-1': 'Token 已用尽' } },
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'group-1',
      selectedTaskSessionIdByGroup: { 'group-1': 'ts-group-1' },
      terminalAgentId: null,
      terminalGroupId: null,
    };

    render(
      <StoreContext.Provider value={state as any}>
        <DispatchContext.Provider value={vi.fn()}>
          <Sidebar onShowCreateGroup={vi.fn()} onShowContacts={vi.fn()} onShowRelayConnect={vi.fn()} />
        </DispatchContext.Provider>
      </StoreContext.Provider>,
    );

    expect(screen.getByTitle('异常: Token 已用尽')).toBeTruthy();
  });

  it('closes previous group members when another group is selected', () => {
    const g2: AgentGroup = {
      ...secondGroup,
      members: [],
    };
    function Harness() {
      const [selectedId, setSelected] = useState<string | null>('group-1');
      const handleDispatch: Dispatch<Action> = (action) => {
        if (action.type === 'SELECT_GROUP') setSelected(action.payload);
      };
      const state: TestStoreState = {
        agents: [{
          id: 'agent-1',
          platform: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          avatarColor: 'blue',
        }],
        groups: [group, g2],
        roles: [],
        taskSessions: [
          { id: 'ts-group-1', groupId: 'group-1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 },
          { id: 'ts-group-2', groupId: 'group-2', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 },
        ],
        messages: [],
        runningAgentIdsByGroup: {},
        initializingByGroup: {},
        streamingByGroup: {},
        agentErrorsByGroup: {},
        port: 9800,
        isRunning: true,
        platformInstallState: {},
        selectedGroupId: selectedId,
        selectedTaskSessionIdByGroup: { 'group-1': 'ts-group-1', 'group-2': 'ts-group-2' },
        terminalAgentId: null,
        terminalGroupId: null,
      };
      return (
        <StoreContext.Provider value={state as any}>
          <DispatchContext.Provider value={handleDispatch}>
            <Sidebar onShowCreateGroup={vi.fn()} onShowContacts={vi.fn()} onShowRelayConnect={vi.fn()} />
          </DispatchContext.Provider>
        </StoreContext.Provider>
      );
    }

    render(<Harness />);

    expect(screen.getByText('成员 (2)')).toBeTruthy();
    expect(screen.queryByText('成员 (1)')).toBeNull();

    fireEvent.click(screen.getByText('执行群聊'));

    expect(screen.queryByText('成员 (2)')).toBeNull();
    expect(screen.getByText('成员 (1)')).toBeTruthy();
  });
});
