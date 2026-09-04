// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: apiMock,
}));

import { Dashboard, GettingStarted, Landing, Login, PrivacyPolicy, Security } from './main';

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe('Octrix Cloud 网站', () => {
  it('公开首页说明 Mac—Cloud—iPhone 工作方式和安全边界', () => {
    render(<Landing />);
    expect(screen.getByText('离开 Mac，', { exact: false })).toBeTruthy();
    expect(screen.getByText('工作不用停。')).toBeTruthy();
    expect(screen.getByRole('list', { name: '跨设备连接流程' })).toBeTruthy();
    expect(screen.getAllByText('Octrix Cloud').length).toBeGreaterThan(0);
    expect(screen.getByText('账号隔离')).toBeTruthy();
    const cliTable = screen.getByRole('table', { name: 'Octrix 当前支持的 Agent CLI' });
    const cliRows = Array.from(cliTable.querySelectorAll('tbody tr'));
    expect(cliRows).toHaveLength(10);
    expect(cliRows.map(row => row.querySelector('strong')?.textContent)).toEqual([
      'Codex CLI',
      'OpenClaude',
      'Claude Code',
      'OpenCode',
      'GitHub Copilot CLI',
      'Gemini CLI',
      'Cursor CLI',
      'Kiro CLI',
      'Qoder CLI',
      'CodeBuddy',
    ]);
    expect(cliRows.map(row => row.querySelector('code')?.textContent)).toEqual([
      'codex',
      'openclaude',
      'claude',
      'opencode',
      'copilot',
      'gemini',
      'agent',
      'kiro-cli',
      'qodercli',
      'codebuddy',
    ]);
    expect(screen.getAllByText('已开放')).toHaveLength(10);
    expect(screen.getByRole('link', { name: '登录并授权' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: '隐私政策' }).getAttribute('href')).toBe('/privacy');
  });

  it('隐私政策说明真实数据流、第三方服务和删除方式', () => {
    render(<PrivacyPolicy />);

    expect(screen.getByRole('heading', { name: '你的工作属于你。' })).toBeTruthy();
    expect(screen.getByText(/不会把这些内容写入 Octrix Cloud 的账号数据库/)).toBeTruthy();
    expect(screen.getByText(/官方服务的数据库备份按轮换计划最多保留 14 天/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看 Apple 隐私政策 ↗' }).getAttribute('href')).toContain('apple.com');
    expect(screen.getByRole('link', { name: '查看 DeepSeek 隐私政策 ↗' }).getAttribute('href')).toContain('deepseek.com');
    expect(screen.getByRole('link', { name: '发起隐私请求' }).getAttribute('href')).toContain('github.com/andforce/OctrixAI/issues/new');
  });

  it('安装指南以 Host 和本地 Web TUI 为唯一 Mac 主流程', async () => {
    apiMock.mockResolvedValueOnce({
      apple: true,
      google: true,
      sms: true,
      public_url: 'https://relay.example.com',
      sms_config: { resend_seconds: 60 },
    });

    render(<GettingStarted />);
    expect(screen.getByRole('heading', { name: '从安装 Host，到第一条回复。' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '安装 Octrix Host' })).toBeTruthy();
    await screen.findByText(/relay\.example\.com\/install-host\.sh/);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: '复制安装命令' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "curl -fsSL 'https://relay.example.com/install-host.sh' | OCTRIX_CLOUD_URL='https://relay.example.com' bash",
    ));
    expect(screen.getByRole('button', { name: '安装命令已复制' })).toBeTruthy();
    expect(screen.getByText('已复制')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/methods');
    expect(screen.getByText(/首次安装会提示按回车申请/)).toBeTruthy();
    expect(screen.getByText(/127\.0\.0\.1:39800/)).toBeTruthy();
    expect(screen.queryAllByRole('link').some(link => link.getAttribute('href')?.endsWith('.dmg'))).toBe(false);
    expect(screen.getByRole('heading', { name: '授权这台 Mac' })).toBeTruthy();
    expect(screen.getByText('Octrix 命令行工具')).toBeTruthy();
    expect(screen.getAllByText('octrix status').length).toBeGreaterThan(0);
    expect(screen.getAllByText('octrix auth').length).toBeGreaterThan(0);
    expect(screen.getAllByText('octrix webtui').length).toBeGreaterThan(0);
    expect(screen.getAllByText('octrix logout').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '登录同一个 Octrix 账号' })).toBeTruthy();
  });

  it('登录页提供 Apple 登录入口', async () => {
    apiMock.mockResolvedValueOnce({
      apple: true,
      google: true,
      sms: true,
      public_url: 'https://relay.example.com',
      sms_config: { resend_seconds: 60 },
    });

    render(<Login next="/dashboard" />);

    expect((await screen.findByRole('link', { name: '使用 Apple 登录' })).getAttribute('href'))
      .toBe('/auth/apple/start?next=%2Fdashboard');
  });

  it('授权中心没有 Mac 时只引导安装 Host', async () => {
    apiMock.mockResolvedValueOnce({
      user: { id: 'user-1', name: 'Alice', picture_url: null, primary_label: 'alice@example.com', identities: [] },
      devices: [], sessions: [], events: [],
      auth_methods: { apple: true, google: true, sms: true },
    });

    render(<Dashboard onLoggedOut={vi.fn()} />);

    await screen.findByText('还没有已授权的 Mac');
    expect(screen.getAllByText(/安装 Octrix Host/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '安装 Octrix Host' }).getAttribute('href')).toBe('/start');
    expect(screen.queryAllByRole('link').some(link => link.getAttribute('href')?.endsWith('.dmg'))).toBe(false);
  });

  it('Google 账号可在安全页完成短信身份绑定', async () => {
    apiMock.mockResolvedValueOnce({ challenge_id: 'sms-link-1' }).mockResolvedValueOnce({ user: {} });
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<Security data={{
      user: { id: 'user-1', name: 'Alice', picture_url: null, primary_label: 'alice@example.com', identities: [{ id: 'google-1', provider: 'google', label: 'alice@example.com' }] },
      devices: [], sessions: [], events: [],
      auth_methods: { apple: true, google: true, sms: true },
    }} reload={reload} />);

    expect(screen.getByRole('link', { name: '绑定 Apple' }).getAttribute('href'))
      .toBe('/auth/apple/start?mode=link&next=/dashboard');
    fireEvent.click(screen.getByRole('button', { name: '绑定手机号' }));
    fireEvent.change(screen.getByPlaceholderText('138 0000 0000'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/sms/challenges', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ phone: '13800138000', flow: 'link' }),
    })));

    fireEvent.change(await screen.findByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并绑定' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/sms/challenges/sms-link-1/verify', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ code: '123456' }),
    })));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('授权控制台显示明确的退出登录按钮并注销当前会话', async () => {
    apiMock
      .mockResolvedValueOnce({
        user: { id: 'user-1', name: 'Alice', picture_url: null, primary_label: 'alice@example.com', identities: [] },
        devices: [], sessions: [], events: [],
        auth_methods: { apple: true, google: true, sms: true },
      })
      .mockResolvedValueOnce(undefined);
    const onLoggedOut = vi.fn();

    render(<Dashboard onLoggedOut={onLoggedOut} />);
    await screen.findByText('你好，Alice');
    const logout = screen.getByRole('button', { name: '退出登录' });
    expect(logout.textContent).toContain('退出登录');
    fireEvent.click(logout);

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/logout', { method: 'POST' }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
  });

  it('授权控制台经过两次确认后永久删除账号', async () => {
    apiMock
      .mockResolvedValueOnce({
        user: { id: 'user-1', name: 'Alice', picture_url: null, primary_label: 'alice@example.com', identities: [] },
        devices: [], sessions: [], events: [],
        auth_methods: { apple: true, google: true, sms: true },
      })
      .mockResolvedValueOnce(undefined);
    const onLoggedOut = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<Dashboard onLoggedOut={onLoggedOut} />);
    await screen.findByText('你好，Alice');
    fireEvent.click(screen.getByRole('button', { name: '登录与安全' }));
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/account', { method: 'DELETE' }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
    confirm.mockRestore();
  });
});
