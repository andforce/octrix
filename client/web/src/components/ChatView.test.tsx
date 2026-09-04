import type { ComponentProps } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreContext, DispatchContext } from '../hooks/useStore';
import { WsContext, type WsApi } from '../hooks/useWebSocket';
import { ChatView, WORKSPACE_RELPATH_MIME } from './ChatView';
import type { AgentGroup, Envelope, AppState } from '../types';
import { api } from '../lib/api';

type TestStoreState = Omit<AppState, 'taskSessions'> & {
  taskSessions?: AppState['taskSessions'];
  initializingByGroup: Record<string, string[]>;
  streamingByGroup: Record<string, string[]>;
  selectedGroupId: string | null;
  selectedTaskSessionIdByGroup?: Record<string, string>;
  terminalAgentId: string | null;
  terminalGroupId: string | null;
  platformInstallState: NonNullable<AppState['platformInstallState']>;
};

vi.mock('./WorkspaceTerminalView', () => ({
  WorkspaceTerminalView: ({ groupId, terminalId }: { groupId: string; terminalId: string; terminalName: string }) => (
    <div>{`workspace-terminal:${groupId}:${terminalId}`}</div>
  ),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
});

afterEach(cleanup);

vi.mock('../lib/api', () => ({
  api: {
    sendMessage: vi.fn(),
    importWorkspaceFiles: vi.fn().mockResolvedValue({ ok: true, imported: 1 }),
    importWorkspaceFromPaths: vi.fn().mockResolvedValue({ ok: true, imported: 1 }),
    listGroupFiles: vi.fn().mockResolvedValue({ path: '', files: [] }),
    listCliCommands: vi.fn().mockImplementation((platform: string) => {
      const byPlatform: Record<string, Array<Record<string, string>>> = {
        'claude-code': [
          { id: 'claude-code:init', platform: 'claude-code', name: 'init', description: '初始化 Claude Code 项目配置', insertText: '/init' },
          { id: 'claude-code:clear', platform: 'claude-code', name: 'clear', description: '清空当前会话上下文', insertText: '/clear' },
        ],
        openclaude: [
          { id: 'openclaude:init', platform: 'openclaude', name: 'init', description: '初始化 OpenClaude 项目配置', insertText: '/init' },
          { id: 'openclaude:clear', platform: 'openclaude', name: 'clear', description: '清空当前会话上下文', insertText: '/clear' },
        ],
        opencode: [
          { id: 'opencode:themes', platform: 'opencode', name: 'themes', description: '切换 OpenCode 主题', insertText: '/themes' },
          { id: 'opencode:new', platform: 'opencode', name: 'new', description: '开始新会话', insertText: '/new' },
          { id: 'opencode:compat:clear', platform: 'opencode', name: 'clear', description: '兼容入口，实际会发送 /new', insertText: '/clear' },
          { id: 'opencode:compat:compact', platform: 'opencode', name: 'compact', description: '兼容入口，实际会发送 /new', insertText: '/compact' },
        ],
        'github-copilot-cli': [
          { id: 'github-copilot-cli:help', platform: 'github-copilot-cli', name: 'help', description: '显示 GitHub Copilot CLI 帮助', insertText: '/help' },
        ],
        'gemini-cli': [
          { id: 'gemini-cli:chat save', platform: 'gemini-cli', name: 'chat save', description: '保存会话快照', insertText: '/chat save' },
          { id: 'gemini-cli:compat:new', platform: 'gemini-cli', name: 'new', description: '统一入口，实际会发送 /clear', insertText: '/new' },
          { id: 'gemini-cli:compat:compact', platform: 'gemini-cli', name: 'compact', description: '兼容入口，实际会发送 /compress', insertText: '/compact' },
        ],
        'openai-codex-cli': [
          { id: 'openai-codex-cli:model', platform: 'openai-codex-cli', name: 'model', description: '切换 Codex 模型', insertText: '/model' },
        ],
        'cursor-cli': [
          { id: 'cursor-cli:compat:new', platform: 'cursor-cli', name: 'new', description: '统一入口，实际会发送 /clear', insertText: '/new' },
          { id: 'cursor-cli:compat:clear', platform: 'cursor-cli', name: 'clear', description: '兼容入口，实际会发送 /clear', insertText: '/clear' },
          { id: 'cursor-cli:compat:compact', platform: 'cursor-cli', name: 'compact', description: '兼容入口，实际会发送 /compress', insertText: '/compact' },
          { id: 'cursor-cli:summarize', platform: 'cursor-cli', name: 'summarize', description: '总结长对话', insertText: '/summarize' },
        ],
        'kiro-cli': [
          { id: 'kiro-cli:compat:new', platform: 'kiro-cli', name: 'new', description: '统一入口，实际会发送 /chat new', insertText: '/new' },
          { id: 'kiro-cli:chat new', platform: 'kiro-cli', name: 'chat new', description: '开始新对话', insertText: '/chat new' },
        ],
        'qoder-cli': [
          { id: 'qoder-cli:compat:new', platform: 'qoder-cli', name: 'new', description: '统一入口，实际会发送 /clear', insertText: '/new' },
          { id: 'qoder-cli:config', platform: 'qoder-cli', name: 'config', description: '管理 Qoder 配置', insertText: '/config' },
        ],
        'codebuddy-cli': [
          { id: 'codebuddy-cli:compat:new', platform: 'codebuddy-cli', name: 'new', description: '统一入口，实际会发送 /clear', insertText: '/new' },
          { id: 'codebuddy-cli:resume', platform: 'codebuddy-cli', name: 'resume', description: '恢复历史会话', insertText: '/resume' },
        ],
      };
      return Promise.resolve({ ok: true, commands: byPlatform[platform] ?? [] });
    }),
    listSkills: vi.fn().mockResolvedValue({
      ok: true,
      skills: [
        {
          id: 't::alpha',
          name: 'alpha',
          skillMdPath: '/home/x/.claude/skills/alpha/SKILL.md',
          rootPath: '/home/x/.claude/skills',
          sourceTag: 'claude',
          summary: 'Alpha skill',
        },
        {
          id: 't::beta',
          name: 'beta',
          skillMdPath: '/home/x/.cursor/skills/beta/SKILL.md',
          rootPath: '/home/x/.cursor/skills',
          sourceTag: 'cursor',
          summary: 'Beta skill',
        },
      ],
    }),
    getGitStatus: vi.fn().mockResolvedValue({
      isGitRepository: false,
      branch: null,
      repositoryRoot: null,
      entries: [],
    }),
    getGitDiff: vi.fn(),
    stageGitPath: vi.fn().mockResolvedValue({ ok: true }),
    unstageGitPath: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const group: AgentGroup = {
  id: 'g1',
  name: 'Test Group',
  ownerName: 'Owner',
  members: [],
  groupType: 'collaboration',
  activeTaskSessionId: 'ts-1',
  createdAt: Date.now() / 1000,
};

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: 'msg-1',
    from: 'AI',
    to: 'user',
    body: 'initial body',
    ts: Date.now() / 1000,
    groupId: 'g1',
    taskSessionId: 'ts-1',
    ...overrides,
  };
}

function renderWithStore(messages: Envelope[]) {
  const state: TestStoreState = {
    agents: [],
    groups: [group],
    roles: [],
    taskSessions: [{ id: 'ts-1', groupId: 'g1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }],
    messages,
    runningAgentIdsByGroup: {},
    initializingByGroup: {},
    streamingByGroup: {},
    agentErrorsByGroup: {},
    port: 9800,
    isRunning: true,
    platformInstallState: {},
    selectedGroupId: 'g1',
    selectedTaskSessionIdByGroup: { g1: 'ts-1' },
    terminalAgentId: null,
    terminalGroupId: null,
  };

  return render(
    <StoreContext.Provider value={state as any}>
      <DispatchContext.Provider value={() => {}}>
        <WsContext.Provider value={defaultWsApi}>
          <ChatView group={group} />
        </WsContext.Provider>
      </DispatchContext.Provider>
    </StoreContext.Provider>,
  );
}

const defaultWsApi: WsApi = {
  sendMessage: () => {},
  addHandler: () => () => {},
};

function renderCustomChatView(
  state: TestStoreState,
  activeGroup: AgentGroup,
  wsApi: WsApi = defaultWsApi,
  props?: Partial<ComponentProps<typeof ChatView>>,
) {
  const normalizedState = {
    ...state,
    taskSessions: state.taskSessions ?? [{ id: 'ts-1', groupId: activeGroup.id, title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }],
    selectedTaskSessionIdByGroup: state.selectedTaskSessionIdByGroup ?? { [activeGroup.id]: activeGroup.activeTaskSessionId ?? 'ts-1' },
  };
  return render(
    <StoreContext.Provider value={normalizedState as any}>
      <DispatchContext.Provider value={() => {}}>
        <WsContext.Provider value={wsApi}>
          <ChatView group={activeGroup} {...props} />
        </WsContext.Provider>
      </DispatchContext.Provider>
    </StoreContext.Provider>,
  );
}

function getModalPre(): HTMLPreElement | null {
  return document.querySelector('.fixed pre');
}

describe('ChatView detail modal', () => {
  it('opens detail modal showing full message body', () => {
    const msg = makeEnvelope({ body: 'Line 1\nLine 2\nLine 3' });
    renderWithStore([msg]);

    const bubble = screen.getByText(/Line 1/);
    fireEvent.click(bubble);

    const pre = getModalPre();
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('Line 1\nLine 2\nLine 3');
  });

  it('detail modal reflects latest message body after re-render', () => {
    const msg = makeEnvelope({ body: 'short' });
    const { rerender } = renderWithStore([msg]);

    const bubble = screen.getByText('short');
    fireEvent.click(bubble);

    expect(getModalPre()!.textContent).toBe('short');

    const updatedMsg = { ...msg, body: 'short plus much longer content added during streaming' };
    const updatedState: TestStoreState = {
      agents: [],
      groups: [group],
      roles: [],
      taskSessions: [{ id: 'ts-1', groupId: 'g1', title: '默认任务', status: 'active', createdAt: Date.now() / 1000 }],
      messages: [updatedMsg],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      selectedTaskSessionIdByGroup: { g1: 'ts-1' },
      terminalAgentId: null,
      terminalGroupId: null,
    };

    rerender(
      <StoreContext.Provider value={updatedState as any}>
        <DispatchContext.Provider value={() => {}}>
          <WsContext.Provider value={defaultWsApi}>
            <ChatView group={group} />
          </WsContext.Provider>
        </DispatchContext.Provider>
      </StoreContext.Provider>,
    );

    expect(getModalPre()!.textContent).toBe('short plus much longer content added during streaming');
  });
});

describe('ChatView mentions', () => {
  it('shows role with contact name, but inserts and sends only the role name', () => {
    const groupWithMember: AgentGroup = {
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
      groups: [groupWithMember],
      roles: [{ id: 'role-pm', name: '产品经理', responsibility: '负责产品规划' }],
      messages: [],
      runningAgentIdsByGroup: { 'g1': ['agent-1'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);

    const input = screen.getByLabelText(/输入消息/);
    fireEvent.change(input, { target: { value: '@' } });

    const option = screen.getByText('产品经理（Claude Code）');
    expect(option).toBeTruthy();

    fireEvent.click(option);
    expect((input as HTMLTextAreaElement).value).toBe('@产品经理 ');

    fireEvent.change(input, { target: { value: '@产品经理 你好' } });
    fireEvent.click(screen.getByText('发送'));

    expect(api.sendMessage).toHaveBeenCalledWith('@产品经理 你好', 'g1', 'ts-1', '产品经理', ['agent-1']);
  });

  it('does not send when Enter confirms IME composition', () => {
    renderWithStore([]);

    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'txt' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 });

    expect(api.sendMessage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 });

    expect(api.sendMessage).toHaveBeenCalledWith('txt', 'g1', 'ts-1', '', []);
  });

  it('does not send on Shift+Enter (newline)', () => {
    renderWithStore([]);

    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'line1' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('ChatView slash picker', () => {
  it('触发 / 后仅显示内置命令，Enter 插入 /new ', async () => {
    renderWithStore([]);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });

    expect(await screen.findByText('/new')).toBeTruthy();
    expect(screen.getByText('统一新会话入口')).toBeTruthy();
    expect(screen.queryByText('/alpha')).toBeNull();
    expect(api.listSkills).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '/ne', selectionStart: 3 } });

    expect(screen.queryByText('/clear')).toBeNull();
    expect(screen.getByText('/new')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(input.value).toBe('/new ');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('普通 / 菜单会把 /new /clear /compact 放在最上面', async () => {
    renderWithStore([]);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('/new');
    const slashItems = [...document.querySelectorAll<HTMLElement>('[data-slash-index]')];
    expect(slashItems.slice(0, 3).map(node => node.textContent ?? '')).toEqual([
      expect.stringContaining('/new'),
      expect.stringContaining('/clear'),
      expect.stringContaining('/compact'),
    ]);
    expect(screen.queryByText('/alpha')).toBeNull();
  });

  it('当最近一次 @ 指向 Claude Agent 时，/ 展示 CLI 命令并插入命令文本', async () => {
    const groupWithMember: AgentGroup = {
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
      groups: [groupWithMember],
      roles: [{ id: 'role-pm', name: '产品经理', responsibility: '负责产品规划' }],
      messages: [],
      runningAgentIdsByGroup: { g1: ['agent-1'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);

    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    const value = '@产品经理 /in';
    fireEvent.change(input, { target: { value, selectionStart: value.length } });

    expect(await screen.findByText('/init')).toBeTruthy();
    expect(screen.getByText('初始化 Claude Code 项目配置')).toBeTruthy();
    expect(api.listCliCommands).toHaveBeenCalledWith('claude-code');
    expect(api.listSkills).toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(input.value).toBe('@产品经理 /init ');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('多个 @Agent 时按最后一次提及的 Agent 决定 CLI 命令来源', async () => {
    const groupWithMembers: AgentGroup = {
      ...group,
      members: [
        { id: 'member-1', agentId: 'agent-1', roleId: 'role-pm' },
        { id: 'member-2', agentId: 'agent-2', roleId: 'role-dev' },
      ],
    };
    const state: TestStoreState = {
      agents: [
        {
          id: 'agent-1',
          platform: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          avatarColor: 'blue',
        },
        {
          id: 'agent-2',
          platform: 'opencode',
          name: 'OpenCode',
          command: 'opencode',
          avatarColor: 'green',
        },
      ],
      groups: [groupWithMembers],
      roles: [
        { id: 'role-pm', name: '产品经理', responsibility: '负责产品规划' },
        { id: 'role-dev', name: '研发', responsibility: '负责研发实现' },
      ],
      messages: [],
      runningAgentIdsByGroup: { g1: ['agent-1', 'agent-2'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMembers);

    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@产品经理 @研发 /', selectionStart: 11 } });

    expect(await screen.findByText('/themes')).toBeTruthy();
    expect(screen.queryByText('/init')).toBeNull();
    expect(api.listCliCommands).toHaveBeenCalledWith('opencode');
  });

  it('输入统一的 /compact 查询时，会显示当前 CLI 的兼容命令入口', async () => {
    const groupWithMember: AgentGroup = {
      ...group,
      members: [{ id: 'member-cursor', agentId: 'agent-cursor', roleId: null }],
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-cursor',
        platform: 'cursor-cli',
        name: 'Cursor CLI',
        command: 'cursor-agent',
        avatarColor: 'blue',
      }],
      groups: [groupWithMember],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: { g1: ['agent-cursor'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@Cursor CLI /com', selectionStart: 15 } });

    expect((await screen.findAllByText('/compact')).length).toBeGreaterThan(0);
    expect(screen.getByText('兼容入口，实际会发送 /compress')).toBeTruthy();
  });

  it('输入统一的 /new 查询时，会显示当前 CLI 的兼容新会话入口', async () => {
    const groupWithMember: AgentGroup = {
      ...group,
      members: [{ id: 'member-kiro', agentId: 'agent-kiro', roleId: null }],
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-kiro',
        platform: 'kiro-cli',
        name: 'Kiro CLI',
        command: 'kiro',
        avatarColor: 'blue',
      }],
      groups: [groupWithMember],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: { g1: ['agent-kiro'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@Kiro CLI /ne', selectionStart: 13 } });

    expect((await screen.findAllByText('/new')).length).toBeGreaterThan(0);
    expect(screen.getByText('统一入口，实际会发送 /chat new')).toBeTruthy();
  });

  it('当最近一次 @ 指向某个 CLI 时，/ 同时展示 Skill 与该 CLI 命令', async () => {
    const groupWithMember: AgentGroup = {
      ...group,
      members: [{ id: 'member-opencode', agentId: 'agent-opencode', roleId: null }],
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-opencode',
        platform: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        avatarColor: 'green',
      }],
      groups: [groupWithMember],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: { g1: ['agent-opencode'] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@OpenCode /', selectionStart: 11 } });

    expect(await screen.findByText('/alpha')).toBeTruthy();
    expect(screen.getByText('/themes')).toBeTruthy();
    expect(api.listCliCommands).toHaveBeenCalledWith('opencode');
    expect(api.listSkills).toHaveBeenCalled();
  });

  it('输入旧 /assign 时不再显示已移除的协议提示', async () => {
    renderWithStore([]);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/assign', selectionStart: 7 } });

    expect(screen.queryByText(/assign、\/wf 为群内消息协议/)).toBeNull();
    expect(screen.queryByText('/alpha')).toBeNull();
  });

  it.each([
    ['claude-code', 'Claude Code', '/init'],
    ['openclaude', 'OpenClaude', '/init'],
    ['opencode', 'OpenCode', '/themes'],
    ['github-copilot-cli', 'GitHub Copilot CLI', '/help'],
    ['gemini-cli', 'Gemini CLI', '/chat save'],
    ['openai-codex-cli', 'Codex CLI', '/model'],
    ['cursor-cli', 'Cursor CLI', '/summarize'],
    ['kiro-cli', 'Kiro CLI', '/chat new'],
    ['qoder-cli', 'Qoder CLI', '/config'],
    ['codebuddy-cli', 'CodeBuddy', '/resume'],
  ])('会根据 @%s 对应 CLI 展示 slash 命令', async (platform, agentName, expectedCommand) => {
    const groupWithMember: AgentGroup = {
      ...group,
      members: [{ id: `member-${platform}`, agentId: `agent-${platform}`, roleId: null }],
    };
    const state: TestStoreState = {
      agents: [{
        id: `agent-${platform}`,
        platform: platform as TestStoreState['agents'][number]['platform'],
        name: agentName,
        command: agentName.toLowerCase(),
        avatarColor: 'blue',
      }],
      groups: [groupWithMember],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: { g1: [`agent-${platform}`] },
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithMember);
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;
    const value = `@${agentName} /`;
    fireEvent.change(input, { target: { value, selectionStart: value.length } });

    expect(await screen.findByText(expectedCommand)).toBeTruthy();
    expect(api.listCliCommands).toHaveBeenCalledWith(platform);
  });
});

describe('ChatView online status', () => {
  it('renders a sidebar toggle button and calls back on click', () => {
    const onToggleSidebar = vi.fn();
    renderCustomChatView(renderWithSidebarState(), group, defaultWsApi, {
      isSidebarVisible: true,
      onToggleSidebar,
    });

    const button = screen.getByRole('button', { name: '隐藏侧边栏' });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('shows the expand label when the sidebar is hidden', () => {
    renderCustomChatView(renderWithSidebarState(), group, defaultWsApi, {
      isSidebarVisible: false,
      onToggleSidebar: vi.fn(),
    });

    expect(screen.getByRole('button', { name: '显示侧边栏' })).toBeTruthy();
  });
});

function renderWithSidebarState(): TestStoreState {
  return {
    agents: [],
    groups: [group],
    roles: [],
    messages: [],
    runningAgentIdsByGroup: {},
    initializingByGroup: {},
    streamingByGroup: {},
    agentErrorsByGroup: {},
    port: 9800,
    isRunning: true,
    platformInstallState: {},
    selectedGroupId: 'g1',
    terminalAgentId: null,
    terminalGroupId: null,
  };
}

describe('ChatView workspace section', () => {
  it('shows empty state when no working directory', async () => {
    renderWithStore([]);

    expect(screen.getByText('工作空间')).toBeTruthy();
    expect(await screen.findByText('未配置工作目录')).toBeTruthy();
  });

  it('toggles workspace panel visibility', async () => {
    renderWithStore([]);

    expect(screen.getByText('工作空间')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '隐藏工作空间' }));
    await waitFor(() => {
      expect(screen.queryByText('工作空间')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '显示工作空间' }));
    expect(await screen.findByText('工作空间')).toBeTruthy();
  });

  it('renders workspace files from API', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: '/tmp/test-project',
      files: [
        { name: 'src', type: 'directory' },
        { name: 'README.md', type: 'file' },
      ],
    });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);

    const srcEntry = await screen.findByText('src');
    expect(srcEntry).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it('refreshes the workspace tree when the server reports file changes', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        path: '/tmp/test-project',
        files: [{ name: 'src', type: 'directory' }],
      })
      .mockResolvedValueOnce({
        path: '/tmp/test-project/src',
        files: [{ name: 'before.txt', type: 'file' }],
      })
      .mockResolvedValueOnce({
        path: '/tmp/test-project',
        files: [
          { name: 'src', type: 'directory' },
          { name: 'README.md', type: 'file' },
        ],
      })
      .mockResolvedValueOnce({
        path: '/tmp/test-project/src',
        files: [{ name: 'after.txt', type: 'file' }],
      });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    const rawHandlerRef: { current: ((event: string, data: unknown) => void) | null } = {
      current: null,
    };
    const wsApi: WsApi = {
      sendMessage: () => {},
      addHandler: (handler) => {
        rawHandlerRef.current = handler;
        return () => {
          rawHandlerRef.current = null;
        };
      },
    };

    renderCustomChatView(state, groupWithDir, wsApi);

    const folder = await screen.findByText('src');
    fireEvent.click(folder);
    expect(await screen.findByText('before.txt')).toBeTruthy();

    vi.useFakeTimers();
    try {
      rawHandlerRef.current?.('workspace:files-changed', { groupId: 'g1' });
      await vi.advanceTimersByTimeAsync(250);
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByText('README.md')).toBeTruthy();
    expect(await screen.findByText('after.txt')).toBeTruthy();
  });

  it('imports external files into the hovered directory', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/tmp/test-project',
      files: [{ name: 'src', type: 'directory' }],
    });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);

    const folder = await screen.findByText('src');
    const droppedFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = {
      types: ['Files'],
      files: {
        length: 1,
        item: (index: number) => (index === 0 ? droppedFile : null),
      },
      items: [],
      dropEffect: 'copy',
      effectAllowed: 'copy',
    };

    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    await waitFor(() => {
      expect(api.importWorkspaceFiles).toHaveBeenCalledWith(
        'g1',
        [{ relativePath: 'notes.txt', file: droppedFile }],
        'src',
      );
    });
  });

  it('auto-expands a collapsed directory after hovering with external files', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        path: '/tmp/test-project',
        files: [{ name: 'src', type: 'directory' }],
      })
      .mockResolvedValueOnce({
        path: '/tmp/test-project/src',
        files: [{ name: 'nested.txt', type: 'file' }],
      });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);

    const folder = await screen.findByText('src');
    const droppedFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = {
      types: ['Files'],
      files: {
        length: 1,
        item: (index: number) => (index === 0 ? droppedFile : null),
      },
      items: [],
      dropEffect: 'copy',
      effectAllowed: 'copy',
    };

    vi.useFakeTimers();
    try {
      fireEvent.dragOver(folder, { dataTransfer });
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByText('nested.txt')).toBeTruthy();
    expect(api.listGroupFiles).toHaveBeenCalledWith('g1', 'src');
  });

  it('inserts workspace path ref when dropping onto the chat input', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: '/tmp/test-project',
      files: [{ name: 'README.md', type: 'file' }],
    });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);

    await screen.findByText('README.md');
    const input = screen.getByLabelText(/输入消息/) as HTMLTextAreaElement;

    const dataTransfer = {
      getData: (format: string) => {
        if (format === WORKSPACE_RELPATH_MIME) return 'README.md';
        if (format === 'text/plain') return 'README.md';
        return '';
      },
      dropEffect: 'copy',
      effectAllowed: 'copy',
    };

    fireEvent.drop(input, { dataTransfer });
    expect(input.value).toBe('`file:README.md` ');
  });
});

describe('ChatView git changes view', () => {
  it('opens the git changes page from the workspace path area and renders a diff', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: '/tmp/test-project',
      files: [{ name: 'weather.py', type: 'file' }],
    });
    (api.getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      isGitRepository: true,
      branch: 'main',
      repositoryRoot: '/tmp/test-project',
      entries: [{ path: 'weather.py', section: 'unstaged', staged: false, kind: 'modified', x: ' ', y: 'M' }],
    });
    (api.getGitDiff as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: 'weather.py',
      kind: 'modified',
      section: 'unstaged',
      staged: false,
      before: { exists: true, isBinary: false, text: 'old line' },
      after: { exists: true, isBinary: false, text: 'new line' },
      beforeLabel: 'Index',
      afterLabel: 'Working tree',
      isBinary: false,
    });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);
    await screen.findByText('weather.py');

    fireEvent.click(screen.getByTitle('打开 Git Changes'));

    expect(await screen.findByRole('dialog', { name: 'Git Changes' })).toBeTruthy();
    expect(await screen.findByText('Git Changes')).toBeTruthy();
    expect(await screen.findByText('分支 main')).toBeTruthy();
    expect(await screen.findByText('old line')).toBeTruthy();
    expect(await screen.findByText('new line')).toBeTruthy();
    expect(api.getGitDiff).toHaveBeenCalledWith('g1', 'weather.py', 'unstaged', 'modified');
  });

  it('stages a selected file from the git changes page', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: '/tmp/test-project',
      files: [{ name: 'weather.py', type: 'file' }],
    });
    (api.getGitStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        isGitRepository: true,
        branch: 'main',
        repositoryRoot: '/tmp/test-project',
        entries: [{ path: 'weather.py', section: 'unstaged', staged: false, kind: 'modified', x: ' ', y: 'M' }],
      })
      .mockResolvedValueOnce({
        isGitRepository: true,
        branch: 'main',
        repositoryRoot: '/tmp/test-project',
        entries: [{ path: 'weather.py', section: 'staged', staged: true, kind: 'modified', x: 'M', y: ' ' }],
      });
    (api.getGitDiff as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        path: 'weather.py',
        kind: 'modified',
        section: 'unstaged',
        staged: false,
        before: { exists: true, isBinary: false, text: 'old line' },
        after: { exists: true, isBinary: false, text: 'new line' },
        beforeLabel: 'Index',
        afterLabel: 'Working tree',
        isBinary: false,
      })
      .mockResolvedValueOnce({
        path: 'weather.py',
        kind: 'modified',
        section: 'staged',
        staged: true,
        before: { exists: true, isBinary: false, text: 'old line' },
        after: { exists: true, isBinary: false, text: 'new line' },
        beforeLabel: 'HEAD',
        afterLabel: 'Index',
        isBinary: false,
      });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);
    await screen.findByText('weather.py');

    fireEvent.click(screen.getByTitle('打开 Git Changes'));
    await screen.findByRole('dialog', { name: 'Git Changes' });

    const stageButtons = await screen.findAllByRole('button', { name: 'Stage' });
    fireEvent.click(stageButtons[0]);

    await waitFor(() => {
      expect(api.stageGitPath).toHaveBeenCalledWith('g1', 'weather.py');
    });
    expect(await screen.findByText('Staged Changes')).toBeTruthy();
    expect(await screen.findByText('1 files')).toBeTruthy();
  });

  it('closes the git changes dialog when clicking the close action', async () => {
    const groupWithDir: AgentGroup = {
      ...group,
      workingDirectory: '/tmp/test-project',
    };
    (api.listGroupFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: '/tmp/test-project',
      files: [{ name: 'weather.py', type: 'file' }],
    });
    (api.getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      isGitRepository: true,
      branch: 'main',
      repositoryRoot: '/tmp/test-project',
      entries: [],
    });

    const state: TestStoreState = {
      agents: [],
      groups: [groupWithDir],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithDir);
    await screen.findByText('weather.py');

    fireEvent.click(screen.getByTitle('打开 Git Changes'));
    expect(await screen.findByRole('dialog', { name: 'Git Changes' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '返回工作空间' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Git Changes' })).toBeNull();
    });
  });
});

describe('ChatView workspace terminal', () => {
  it('renders the workspace terminal trigger before the workspace toggle in the header', () => {
    const groupWithTerminal: AgentGroup = {
      ...group,
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
      workingDirectory: '/tmp/test-project',
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      groups: [groupWithTerminal],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithTerminal);

    const terminalButton = screen.getByRole('button', { name: '新建工作空间终端' });
    const workspaceButton = screen.getByRole('button', { name: '隐藏工作空间' });
    expect(terminalButton.compareDocumentPosition(workspaceButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('opens the workspace terminal dock when clicking the trigger', () => {
    const groupWithTerminal: AgentGroup = {
      ...group,
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
      workingDirectory: '/tmp/test-project',
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      groups: [groupWithTerminal],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithTerminal);

    fireEvent.click(screen.getByRole('button', { name: /新建工作空间终端/i }));

    expect(screen.getByText(/workspace-terminal:g1:ws-term-g1-1/)).toBeTruthy();
    expect(screen.getByText('终端(1)')).toBeTruthy();
    expect(screen.getByTitle('关闭所有终端')).toBeTruthy();
  });

  it('supports multiple workspace terminal tabs and closing them independently', () => {
    const groupWithTerminal: AgentGroup = {
      ...group,
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
      workingDirectory: '/tmp/test-project',
    };
    const state: TestStoreState = {
      agents: [{
        id: 'agent-1',
        platform: 'claude-code',
        name: 'Claude Code',
        command: 'claude',
        avatarColor: 'blue',
      }],
      groups: [groupWithTerminal],
      roles: [],
      messages: [],
      runningAgentIdsByGroup: {},
      initializingByGroup: {},
      streamingByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
      platformInstallState: {},
      selectedGroupId: 'g1',
      terminalAgentId: null,
      terminalGroupId: null,
    };

    renderCustomChatView(state, groupWithTerminal);

    fireEvent.click(screen.getByRole('button', { name: '新建工作空间终端' }));
    expect(screen.getByText(/workspace-terminal:g1:ws-term-g1-1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新建终端' }));
    expect(screen.getByText(/workspace-terminal:g1:ws-term-g1-2/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '切换到 终端(1)' }));
    expect(screen.getByText(/workspace-terminal:g1:ws-term-g1-1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭 终端(1)' }));
    expect(screen.queryByRole('button', { name: '关闭 终端(1)' })).toBeNull();
    expect(screen.getByText(/workspace-terminal:g1:ws-term-g1-2/)).toBeTruthy();
  });
});
