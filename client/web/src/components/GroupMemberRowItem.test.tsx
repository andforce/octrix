import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMemberRowItem } from './GroupMemberRowItem';
import type { Agent, AgentGroup, Role } from '../types';

const dispatchMock = vi.fn();
const mockedUseAppStore = vi.fn();
const mockedApi = {
  goOnline: vi.fn(),
  goOffline: vi.fn(),
  removeMember: vi.fn(),
};

vi.mock('../hooks/useStore', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStore: () => mockedUseAppStore(),
}));

vi.mock('../lib/api', () => ({
  api: {
    goOnline: (...args: unknown[]) => mockedApi.goOnline(...args),
    goOffline: (...args: unknown[]) => mockedApi.goOffline(...args),
    removeMember: (...args: unknown[]) => mockedApi.removeMember(...args),
  },
}));

const group: AgentGroup = {
  id: 'group-1',
  name: '测试群',
  ownerName: '群主',
  members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-dev' }],
  groupType: 'collaboration',
  createdAt: Date.now() / 1000,
};

const agent: Agent = {
  id: 'agent-1',
  platform: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  avatarColor: 'blue',
};

const roles: Role[] = [{ id: 'role-dev', name: '研发', responsibility: '负责实现' }];

function renderItem(presenceState: 'offline' | 'online' | 'busy' | 'error' = 'online') {
  return render(
    <GroupMemberRowItem
      member={group.members[0]}
      group={group}
      agents={[agent]}
      roles={roles}
      presenceState={presenceState}
    />,
  );
}

describe('GroupMemberRowItem', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    mockedApi.goOnline.mockReset();
    mockedApi.goOffline.mockReset();
    mockedApi.removeMember.mockReset();
    mockedUseAppStore.mockReturnValue({
      terminalAgentId: null,
      terminalGroupId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the terminal when clicking the avatar for online members', () => {
    renderItem('online');

    fireEvent.click(screen.getByRole('button', { name: '打开 Claude Code 的模型终端' }));

    expect(screen.getByRole('button', { name: '下线' })).toBeTruthy();
    expect(dispatchMock).toHaveBeenCalledWith({
      type: 'OPEN_TERMINAL',
      payload: { agentId: 'agent-1', groupId: 'group-1' },
    });
  });

  it('calls goOffline only after confirming in the dialog', async () => {
    mockedApi.goOffline.mockResolvedValue({ ok: true });

    renderItem('busy');
    fireEvent.click(screen.getByRole('button', { name: '下线' }));

    expect(mockedApi.goOffline).not.toHaveBeenCalled();
    expect(screen.getByText('下线成员')).toBeTruthy();

    const offlineButtons = screen.getAllByRole('button', { name: '下线' });
    fireEvent.click(offlineButtons[offlineButtons.length - 1]);

    await waitFor(() => {
      expect(mockedApi.goOffline).toHaveBeenCalledWith('group-1', 'member-1');
    });
  });

  it('does not expose terminal open action on offline members', () => {
    renderItem('offline');

    expect(screen.queryByRole('button', { name: '打开 Claude Code 的模型终端' })).toBeNull();

    fireEvent.click(screen.getByRole('presentation'));

    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_TERMINAL' }));
    expect(screen.getByRole('button', { name: '上线' })).toBeTruthy();
  });
});
