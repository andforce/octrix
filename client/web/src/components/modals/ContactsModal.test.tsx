import {
  cleanup, render, screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENABLED_AGENTS } from '../../agent-platforms';
import { ContactsModal } from './ContactsModal';

const mockedUseAppStore = vi.fn();

vi.mock('../../hooks/useStore', () => ({
  useAppStore: () => mockedUseAppStore(),
}));

afterEach(() => {
  cleanup();
});

describe('ContactsModal', () => {
  beforeEach(() => {
    mockedUseAppStore.mockReset();
  });

  it('lists every enabled platform with install status and no delete actions', () => {
    mockedUseAppStore.mockReturnValue({
      agents: [{
        id: 'agent-claude',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      platformInstallState: {
        'claude-code': true,
        opencode: true,
      },
    });

    render(<ContactsModal onClose={vi.fn()} />);

    for (const def of ENABLED_AGENTS) {
      expect(screen.getByText(def.name)).toBeTruthy();
      expect(screen.getByText(def.cliLabel)).toBeTruthy();
    }
    expect(screen.getAllByText('已安装')).toHaveLength(2);
    expect(screen.getAllByText('未安装').length).toBe(ENABLED_AGENTS.length - 2);

    const deleteButtons = screen.queryAllByRole('button', { name: '删除联系人' });
    expect(deleteButtons.length).toBe(0);
  });

  it('when agents is empty, shows no delete-contact action and every platform is not installed', () => {
    mockedUseAppStore.mockReturnValue({ agents: [], platformInstallState: {} });

    render(<ContactsModal onClose={vi.fn()} />);

    expect(screen.queryAllByRole('button', { name: '删除联系人' })).toHaveLength(0);
    expect(screen.queryAllByText('已安装')).toHaveLength(0);
    expect(screen.getAllByText('未安装').length).toBe(ENABLED_AGENTS.length);
  });

  it('exposes dialog semantics without add-contact action', () => {
    mockedUseAppStore.mockReturnValue({ agents: [], platformInstallState: {} });

    render(<ContactsModal onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '通讯录' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.queryByRole('button', { name: '添加联系人' })).toBeNull();
  });
});
