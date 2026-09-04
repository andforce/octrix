import {
  cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateGroupModal } from './CreateGroupModal';

const mockedUseAppStore = vi.fn();
const mockedApi = {
  addAgent: vi.fn(),
  createGroup: vi.fn(),
  getState: vi.fn(),
  pickDirectory: vi.fn(),
};

vi.mock('../../hooks/useStore', () => ({
  useAppStore: () => mockedUseAppStore(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    addAgent: (...args: unknown[]) => mockedApi.addAgent(...args),
    createGroup: (...args: unknown[]) => mockedApi.createGroup(...args),
    getState: (...args: unknown[]) => mockedApi.getState(...args),
    pickDirectory: (...args: unknown[]) => mockedApi.pickDirectory(...args),
  },
}));

afterEach(() => {
  cleanup();
});

describe('CreateGroupModal', () => {
  beforeEach(() => {
    mockedUseAppStore.mockReset();
    mockedApi.addAgent.mockReset();
    mockedApi.createGroup.mockReset();
    mockedApi.getState.mockReset();
    mockedApi.pickDirectory.mockReset();
    mockedApi.pickDirectory.mockResolvedValue({ path: '/tmp/project' });
    mockedApi.getState.mockResolvedValue({ agents: [] });
    mockedApi.createGroup.mockResolvedValue({
      id: 'group-1',
      name: '新群组',
      ownerName: '群主',
      members: [],
      workingDirectory: '/tmp/project',
      groupType: 'collaboration',
      compositionStatus: 'active',
      roleLeaders: {},
      createdAt: Date.now(),
    });
  });

  it('shows installed platforms as selectable agents', () => {
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [],
      roles: [
        { id: 'role-dev', name: '研发', responsibility: '写代码' },
        { id: 'role-test', name: '测试', responsibility: '验证' },
      ],
      platformInstallState: {
        'openai-codex-cli': true,
        openclaude: true,
        'claude-code': true,
        opencode: true,
        'cursor-cli': true,
      },
    });

    render(<CreateGroupModal onClose={vi.fn()} />);

    expect(screen.queryByText('请先添加 AI Agent')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    expect(screen.getByRole('option', { name: 'Codex CLI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'OpenClaude' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Claude Code' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'OpenCode' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Cursor CLI' })).toBeTruthy();
  });

  it('creates a managed agent for installed platforms before creating the group', async () => {
    const onClose = vi.fn();
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [],
      roles: [
        { id: 'role-dev', name: '研发', responsibility: '写代码' },
        { id: 'role-test', name: '测试', responsibility: '验证' },
      ],
      platformInstallState: {
        'openai-codex-cli': true,
      },
    });
    mockedApi.addAgent
      .mockResolvedValueOnce({
        id: 'agent-dev', platform: 'openai-codex-cli', name: 'Codex CLI 1', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'blue',
      })
      .mockResolvedValueOnce({
        id: 'agent-test', platform: 'openai-codex-cli', name: 'Codex CLI 2', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'green',
      });

    render(<CreateGroupModal onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));

    await waitFor(() => {
      expect(screen.getByText('/tmp/project')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText(/群名称/), { target: { value: '新群组' } });

    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '研发' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '测试' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mockedApi.addAgent).toHaveBeenNthCalledWith(1, 'openai-codex-cli', 'blue');
      expect(mockedApi.addAgent).toHaveBeenNthCalledWith(2, 'openai-codex-cli', 'green');
      expect(mockedApi.createGroup).toHaveBeenCalledWith({
        name: '新群组',
        ownerName: '群主',
        members: [
          { agentId: 'agent-dev', roleId: 'role-dev' },
          { agentId: 'agent-test', roleId: 'role-test' },
        ],
        workingDirectory: '/tmp/project',
        groupType: 'collaboration',
        roleLeaders: {},
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('未填写群名称时使用工作目录末级文件夹名', async () => {
    const onClose = vi.fn();
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [],
      roles: [
        { id: 'role-dev', name: '研发', responsibility: '写代码' },
        { id: 'role-test', name: '测试', responsibility: '验证' },
      ],
      platformInstallState: {
        'openai-codex-cli': true,
      },
    });
    mockedApi.addAgent
      .mockResolvedValueOnce({
        id: 'agent-dev', platform: 'openai-codex-cli', name: 'Codex CLI 1', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'blue',
      })
      .mockResolvedValueOnce({
        id: 'agent-test', platform: 'openai-codex-cli', name: 'Codex CLI 2', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'green',
      });

    render(<CreateGroupModal onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));

    await waitFor(() => {
      expect(screen.getByText('/tmp/project')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '研发' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '测试' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mockedApi.createGroup).toHaveBeenCalledWith({
        name: 'project',
        ownerName: '群主',
        members: [
          { agentId: 'agent-dev', roleId: 'role-dev' },
          { agentId: 'agent-test', roleId: 'role-test' },
        ],
        workingDirectory: '/tmp/project',
        groupType: 'collaboration',
        roleLeaders: {},
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('allows a collaboration group to share a repository with a direct chat', async () => {
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [{
        id: 'existing',
        name: '已有单聊',
        ownerName: '群主',
        members: [],
        workingDirectory: '/tmp/project',
        groupType: 'direct',
        compositionStatus: 'active',
        roleLeaders: {},
        createdAt: 0,
      }],
      roles: [{ id: 'role-dev', name: '研发', responsibility: '写代码' }],
      platformInstallState: { 'openai-codex-cli': true },
    });

    render(<CreateGroupModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));

    await waitFor(() => {
      expect(screen.getByText('/tmp/project')).toBeTruthy();
    });

    expect(screen.queryByText(/已被协作群/)).toBeNull();
    expect(mockedApi.createGroup).not.toHaveBeenCalled();
  });

  it('requires at least two AI members for a group chat', async () => {
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [],
      roles: [{ id: 'role-dev', name: '研发', responsibility: '写代码' }],
      platformInstallState: { 'openai-codex-cli': true },
    });
    render(<CreateGroupModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
    await screen.findByText('/tmp/project');
    fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
    fireEvent.click(screen.getByRole('option', { name: '研发' }));
    fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(screen.getByText(/群聊至少需要 2 个 AI/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true);
  });

  it('sends the selected leader when one role has multiple AI members', async () => {
    mockedUseAppStore.mockReturnValue({
      agents: [],
      groups: [],
      roles: [{ id: 'role-dev', name: '研发', responsibility: '写代码' }],
      platformInstallState: { 'openai-codex-cli': true },
    });
    mockedApi.addAgent
      .mockResolvedValueOnce({ id: 'dev-1', platform: 'openai-codex-cli', name: 'Codex CLI 1', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'blue' })
      .mockResolvedValueOnce({ id: 'dev-2', platform: 'openai-codex-cli', name: 'Codex CLI 2', command: 'codex --dangerously-bypass-approvals-and-sandbox', avatarColor: 'green' });

    render(<CreateGroupModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
    await screen.findByText('/tmp/project');
    for (let index = 0; index < 2; index++) {
      fireEvent.click(screen.getByRole('combobox', { name: '选择角色' }));
      fireEvent.click(screen.getByRole('option', { name: '研发' }));
      fireEvent.click(screen.getByRole('combobox', { name: '选择 Agent' }));
      fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));
      fireEvent.click(screen.getByRole('button', { name: '添加' }));
    }
    fireEvent.click(screen.getAllByRole('button', { name: /设为研发 Leader/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(mockedApi.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      roleLeaders: { 'role-dev': 'dev-2' },
    })));
  });
});
