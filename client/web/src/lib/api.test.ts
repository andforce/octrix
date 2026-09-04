import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api.goOnline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the backend error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: vi.fn().mockResolvedValue({ error: '无法启动 PTY 进程，请检查 node-pty 是否已正确安装' }),
    }));

    await expect(api.goOnline('group-1', 'member-1')).rejects.toThrow('无法启动 PTY 进程，请检查 node-pty 是否已正确安装');
  });

  it('posts supported platform payload when adding an agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.addAgent('claude-code', 'blue');

    expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'claude-code', avatarColor: 'blue' }),
    }));
  });
});
