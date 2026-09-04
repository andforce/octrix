import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMembersModal } from './GroupMembersModal';

const mockedUseAppStore = vi.fn();
const mockedApi = {
  addAgent: vi.fn(),
  addMember: vi.fn(),
  goOnline: vi.fn(),
  goOffline: vi.fn(),
  openTerminal: vi.fn(),
  removeMember: vi.fn(),
};

vi.mock('../../hooks/useStore', () => ({
  useAppStore: () => mockedUseAppStore(),
  useAppDispatch: () => vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    addAgent: (...args: unknown[]) => mockedApi.addAgent(...args),
    addMember: (...args: unknown[]) => mockedApi.addMember(...args),
    goOnline: (...args: unknown[]) => mockedApi.goOnline(...args),
    goOffline: (...args: unknown[]) => mockedApi.goOffline(...args),
    openTerminal: (...args: unknown[]) => mockedApi.openTerminal(...args),
    removeMember: (...args: unknown[]) => mockedApi.removeMember(...args),
  },
}));

afterEach(() => {
  cleanup();
});

describe('GroupMembersModal', () => {
  beforeEach(() => {
    mockedUseAppStore.mockReturnValue({
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'red',
      }],
      roles: [{ id: 'role-developer', name: '研发', responsibility: '实现代码' }],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      platformInstallState: {},
    });
    mockedApi.addAgent.mockReset();
    mockedApi.addMember.mockReset();
    mockedApi.goOnline.mockReset();
    mockedApi.goOffline.mockReset();
  });

  it('shows an error message when going online fails', async () => {
    mockedApi.goOnline.mockRejectedValue(new Error('启动失败'));

    render(
      <GroupMembersModal
        group={{
          id: 'group-1',
          name: 'Test Group',
          ownerName: '群主',
          members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' }],
          groupType: 'collaboration',
          createdAt: Date.now() / 1000,
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('上线'));

    await waitFor(() => {
      expect(screen.getByText('启动失败')).toBeTruthy();
    });
  });

  it('shows loading state while adding a member', async () => {
    let resolveAddMember: (() => void) | undefined;
    mockedUseAppStore.mockReturnValue({
      agents: [],
      roles: [{ id: 'role-developer', name: '研发', responsibility: '实现代码' }],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      platformInstallState: { 'claude-code': true },
    });
    mockedApi.addAgent.mockResolvedValue({
      id: 'agent-2',
      platform: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      avatarColor: 'blue',
    });
    mockedApi.addMember.mockImplementation(() => new Promise(resolve => {
      resolveAddMember = () => resolve({
        id: 'member-2',
        agentId: 'agent-2',
        roleId: 'role-developer',
      });
    }));

    render(
      <GroupMembersModal
        group={{
          id: 'group-1',
          name: 'Test Group',
          ownerName: '群主',
          members: [],
          groupType: 'collaboration',
          createdAt: Date.now() / 1000,
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '研发' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: '拉入群' }));

    expect(screen.getByRole('button', { name: '拉入中...' }).hasAttribute('disabled')).toBe(true);

    await waitFor(() => {
      expect(mockedApi.addMember).toHaveBeenCalledWith('group-1', 'agent-2', 'role-developer');
    });

    resolveAddMember?.();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '拉入中...' })).toBeNull();
      expect(screen.getByRole('button', { name: '拉入群' }).hasAttribute('disabled')).toBe(true);
      const roleSelect = screen.getByRole('combobox', { name: '选择角色' }) as HTMLSelectElement;
      expect(roleSelect.value).toBe('');
      expect(screen.getByRole('combobox', { name: '选择 Agent' }).textContent).toMatch(/选择 Agent/);
    });
  });
});
