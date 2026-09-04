import {
  cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENABLED_AGENTS } from '../../agent-platforms';
import { AddAgentModal } from './AddAgentModal';

const mockedAddAgent = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    addAgent: (...args: unknown[]) => mockedAddAgent(...args),
  },
}));

afterEach(() => {
  cleanup();
});

describe('AddAgentModal', () => {
  beforeEach(() => {
    mockedAddAgent.mockReset();
    mockedAddAgent.mockResolvedValue({
      id: 'agent-1',
      platform: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      avatarColor: 'blue',
    });
  });

  it('does not render free-form name or command inputs', () => {
    render(<AddAgentModal onClose={vi.fn()} />);

    expect(screen.queryByPlaceholderText('名称（如 Claude）')).toBeNull();
    expect(screen.queryByPlaceholderText('启动命令（如 claude）')).toBeNull();
  });

  it('offers every enabled CLI platform', () => {
    render(<AddAgentModal onClose={vi.fn()} />);

    for (const agent of ENABLED_AGENTS) {
      expect(screen.getByText(agent.name)).toBeTruthy();
      expect(screen.getByText(agent.cliLabel)).toBeTruthy();
    }
  });

  it('keeps submit disabled until a platform is selected', () => {
    render(<AddAgentModal onClose={vi.fn()} />);

    expect((screen.getAllByRole('button', { name: '添加' })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits only platform and avatar color', async () => {
    const onClose = vi.fn();
    render(<AddAgentModal onClose={onClose} />);

    const claudeButton = screen.getByText('Claude Code').closest('button');
    expect(claudeButton).toBeTruthy();
    fireEvent.click(claudeButton!);
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(mockedAddAgent).toHaveBeenCalledWith('claude-code', 'blue');
    });
    expect(onClose).toHaveBeenCalled();
  });
});
