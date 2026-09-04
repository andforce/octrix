import {
  cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStartupPromptDialog } from './AgentStartupPromptDialog';

const mockedUseAppStore = vi.fn();
const mockedApi = {
  getAgentStartupPrompts: vi.fn(),
  getWorkspaceTrustPrompts: vi.fn(),
  resolveAgentStartupPrompts: vi.fn(),
  confirmWorkspaceTrust: vi.fn(),
  goOffline: vi.fn(),
};

vi.mock('../hooks/useStore', () => ({
  useAppStore: () => mockedUseAppStore(),
}));

vi.mock('../lib/api', () => ({
  api: {
    getAgentStartupPrompts: (...args: unknown[]) => mockedApi.getAgentStartupPrompts(...args),
    getWorkspaceTrustPrompts: (...args: unknown[]) => mockedApi.getWorkspaceTrustPrompts(...args),
    resolveAgentStartupPrompts: (...args: unknown[]) => mockedApi.resolveAgentStartupPrompts(...args),
    confirmWorkspaceTrust: (...args: unknown[]) => mockedApi.confirmWorkspaceTrust(...args),
    goOffline: (...args: unknown[]) => mockedApi.goOffline(...args),
  },
}));

const bypassPrompt = {
  kind: 'bypass-permissions' as const,
  agentId: 'agent-1',
  agentName: 'Claude Code',
  groupId: 'group-1',
  directory: '/tmp/project',
  rawPreview: 'WARNING: Claude Code running in Bypass Permissions mode',
  detectedAt: 1,
  updatedAt: 1,
};

const workspaceTrustPrompt = {
  ...bypassPrompt,
  kind: 'workspace-trust' as const,
  directory: '/Users/test/project',
  rawPreview: 'Security guide\nYes, I trust this folder',
};

describe('AgentStartupPromptDialog', () => {
  beforeEach(() => {
    mockedUseAppStore.mockReturnValue({
      groups: [{
        id: 'group-1',
        name: '演示会话',
        members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
      }],
      runningAgentIdsByGroup: { 'group-1': ['agent-1'] },
    });
    mockedApi.getAgentStartupPrompts.mockReset();
    mockedApi.getWorkspaceTrustPrompts.mockReset().mockResolvedValue({ ok: true, prompts: [] });
    mockedApi.resolveAgentStartupPrompts.mockReset();
    mockedApi.confirmWorkspaceTrust.mockReset().mockResolvedValue({ ok: true, resolved: 1, prompts: [] });
    mockedApi.goOffline.mockReset().mockResolvedValue({ ok: true });
    mockedApi.getAgentStartupPrompts
      .mockResolvedValueOnce({ ok: true, prompts: [bypassPrompt] })
      .mockResolvedValue({ ok: true, prompts: [] });
    mockedApi.resolveAgentStartupPrompts.mockResolvedValue({ ok: true, resolved: 1, prompts: [] });
  });

  afterEach(() => cleanup());

  it('warns about bypass permissions and accepts with an explicit action', async () => {
    render(<AgentStartupPromptDialog />);

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('确认 Bypass Permissions 模式')).toBeTruthy();
    expect(screen.getByText(/执行潜在危险命令前不会再请求批准/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '我了解风险，继续' }));

    await waitFor(() => {
      expect(mockedApi.resolveAgentStartupPrompts).toHaveBeenCalledWith(
        'group-1',
        'accept',
        ['agent-1'],
      );
    });
  });

  it('keeps exit as a separate decline action', async () => {
    render(<AgentStartupPromptDialog />);

    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: '退出 Claude Code' }));

    await waitFor(() => {
      expect(mockedApi.resolveAgentStartupPrompts).toHaveBeenCalledWith(
        'group-1',
        'decline',
        ['agent-1'],
      );
    });
  });

  it('falls back to the legacy Security guide API and confirms workspace trust', async () => {
    mockedApi.getAgentStartupPrompts.mockReset().mockRejectedValue(new Error('404 Not Found'));
    mockedApi.getWorkspaceTrustPrompts.mockResolvedValue({ ok: true, prompts: [workspaceTrustPrompt] });
    mockedApi.resolveAgentStartupPrompts.mockRejectedValue(new Error('404 Not Found'));

    render(<AgentStartupPromptDialog />);

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('确认工作目录信任')).toBeTruthy();
    expect(screen.getByText('/Users/test/project')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '信任并继续' }));

    await waitFor(() => {
      expect(mockedApi.confirmWorkspaceTrust).toHaveBeenCalledWith('group-1', ['agent-1']);
    });
  });

  it('takes the agent offline when declining through a legacy Host', async () => {
    mockedApi.getAgentStartupPrompts.mockReset().mockRejectedValue(new Error('404 Not Found'));
    mockedApi.getWorkspaceTrustPrompts.mockResolvedValue({ ok: true, prompts: [workspaceTrustPrompt] });
    mockedApi.resolveAgentStartupPrompts.mockRejectedValue(new Error('404 Not Found'));

    render(<AgentStartupPromptDialog />);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: '退出 Claude Code' }));

    await waitFor(() => {
      expect(mockedApi.goOffline).toHaveBeenCalledWith('group-1', 'member-1');
    });
  });
});
