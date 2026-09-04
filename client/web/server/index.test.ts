import request from 'supertest';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  getGitWorkspaceStatus: vi.fn(),
  getGitDiffForPath: vi.fn(),
  stageGitPath: vi.fn(),
  unstageGitPath: vi.fn(),
}));

vi.mock('./git.js', () => gitMocks);

import { createApp } from './app';

beforeEach(() => {
  vi.clearAllMocks();
  gitMocks.getGitWorkspaceStatus.mockReset();
  gitMocks.getGitDiffForPath.mockReset();
  gitMocks.stageGitPath.mockReset();
  gitMocks.unstageGitPath.mockReset();
});

function makeDeps(overrides: Record<string, any> = {}) {
  const member = { id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' };
  const group = {
    id: 'group-1', name: 'Test Group', ownerName: '群主', members: [member],
    workingDirectory: '/tmp/project', groupType: 'collaboration' as const, activeTaskSessionId: 'task-1', createdAt: Date.now() / 1000,
  };
  const agent = {
    id: 'agent-1',
    platform: 'claude-code',
    name: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    avatarColor: 'red',
  };

  return {
    store: {
      agents: [agent], groups: [group], roles: [{ id: 'role-developer', name: '代码审查', responsibility: '审查' }],
      addAgent: vi.fn(),
      updateAgent: vi.fn(),
      addGroup: vi.fn(),
      archiveGroup: vi.fn().mockReturnValue({ ...group, archivedAt: 123 }),
      unarchiveGroup: vi.fn().mockReturnValue({ ...group, archivedAt: undefined }),
      groupByResolvedWorkingDirectory: vi.fn().mockReturnValue(undefined),
      groupById: vi.fn().mockReturnValue(group),
      activeTaskSessionForGroup: vi.fn().mockReturnValue({
        id: 'task-1',
        groupId: 'group-1',
        title: '默认任务',
        status: 'active',
        currentPhaseId: 'phase-review',
        phases: [{ id: 'phase-review', roleId: 'role-developer' }],
        leaderSnapshot: { 'role-developer': 'member-1' },
        createdAt: Date.now() / 1000,
      }),
      taskSessionById: vi.fn().mockReturnValue({
        id: 'task-1',
        groupId: 'group-1',
        title: '默认任务',
        status: 'active',
        currentPhaseId: 'phase-review',
        phases: [{ id: 'phase-review', roleId: 'role-developer' }],
        leaderSnapshot: { 'role-developer': 'member-1' },
        createdAt: Date.now() / 1000,
      }),
      agentById: vi.fn().mockReturnValue(agent),
      writeTeamFiles: vi.fn(),
      markRequiredMemberOffline: vi.fn(),
      roleFileName: vi.fn().mockReturnValue(undefined),
      ...overrides.store,
    },
    hub: {
      messages: [] as any[], port: 9800, isRunning: true,
      broadcast: vi.fn(), addWsClient: vi.fn(),
      ...overrides.hub,
    },
    pm: {
      getRunningAgentIds: vi.fn().mockReturnValue([]),
      getRunningAgentIdsByGroup: vi.fn().mockReturnValue({}),
      getBusyAgentIdsByGroup: vi.fn().mockReturnValue({}),
      getRecentAgentErrorsByGroup: vi.fn().mockReturnValue({}),
      launchAgent: vi.fn().mockReturnValue('无法启动 PTY 进程，请检查 node-pty 是否已正确安装'),
      waitForAgentStartup: vi.fn().mockResolvedValue(undefined),
      waitForPtyReady: vi.fn().mockResolvedValue(true),
      isAgentRunning: vi.fn().mockReturnValue(false),
      hasPendingAgentResponse: vi.fn().mockReturnValue(false),
      killAgent: vi.fn(), sendKeys: vi.fn(), attachTerminal: vi.fn(), destroy: vi.fn(),
      startModelPicker: vi.fn(),
      getModelPicker: vi.fn(),
      chooseModelPickerOption: vi.fn(),
      sendModelPickerInput: vi.fn(),
      getAgentStartupPrompts: vi.fn().mockReturnValue([]),
      resolveAgentStartupPrompts: vi.fn().mockReturnValue({ resolved: 0, prompts: [] }),
      getWorkspaceTrustPrompts: vi.fn().mockReturnValue([]),
      confirmWorkspaceTrustPrompts: vi.fn().mockReturnValue({ confirmed: 0, prompts: [] }),
      ...overrides.pm,
    },
    port: 9800,
  };
}

describe('POST /api/groups/:id/members/:memberId/online', () => {
  it('returns an error when launching the agent fails', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/members/member-1/online')
      .send();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: '无法启动 PTY 进程，请检查 node-pty 是否已正确安装' });
    expect(deps.store.writeTeamFiles).not.toHaveBeenCalled();
  });

  it('returns an error when the agent exits during startup', async () => {
    const deps = makeDeps({
      pm: {
        launchAgent: vi.fn().mockReturnValue(undefined),
        waitForAgentStartup: vi.fn().mockResolvedValue('启动失败，启动日志如下：\nerror: out of pty devices'),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/members/member-1/online')
      .send();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: '启动失败，启动日志如下：\nerror: out of pty devices' });
    expect(deps.store.writeTeamFiles).not.toHaveBeenCalled();
  });
});

describe('POST /api/groups/:id/members/:memberId/offline', () => {
  it('kills the agent process for the specified group member', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/members/member-1/offline')
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(deps.pm.killAgent).toHaveBeenCalledWith('agent-1', 'group-1');
  });
});

describe('agent model picker API', () => {
  const picker = {
    agentId: 'agent-1',
    groupId: 'group-1',
    mode: 'model',
    status: 'selecting',
    options: [
      { id: 'model-0', label: 'Claude Sonnet 4.5', isCurrent: true },
      { id: 'model-1', label: 'Claude Opus 4.1' },
    ],
    selectedIndex: 0,
    rawPreview: '› Claude Sonnet 4.5\n  Claude Opus 4.1',
    startedAt: 123,
    updatedAt: 124,
  };

  it('starts the model picker for a running supported group member', async () => {
    const startModelPicker = vi.fn().mockReturnValue(picker);
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        startModelPicker,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/start')
      .send({ groupId: 'group-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, picker });
    expect(startModelPicker).toHaveBeenCalledWith('agent-1', 'group-1', 'model');
  });

  it('starts the effort picker when requested', async () => {
    const startModelPicker = vi.fn().mockReturnValue({ ...picker, mode: 'effort' });
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        startModelPicker,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/start')
      .send({ groupId: 'group-1', mode: 'effort' });

    expect(response.status).toBe(200);
    expect(response.body.picker.mode).toBe('effort');
    expect(startModelPicker).toHaveBeenCalledWith('agent-1', 'group-1', 'effort');
  });

  it('rejects model switching while the agent is busy', async () => {
    const startModelPicker = vi.fn();
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        getBusyAgentIdsByGroup: vi.fn().mockReturnValue({ 'group-1': ['agent-1'] }),
        startModelPicker,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/start')
      .send({ groupId: 'group-1' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('AI 正在工作，暂时不能切换模型，请等待当前任务完成后再试');
    expect(startModelPicker).not.toHaveBeenCalled();
  });

  it('rejects invalid model picker modes', async () => {
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/start')
      .send({ groupId: 'group-1', mode: 'other' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('mode must be model or effort');
  });

  it('chooses a parsed model option', async () => {
    const chooseModelPickerOption = vi.fn().mockReturnValue({ ...picker, status: 'chosen' });
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        chooseModelPickerOption,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/choose')
      .send({ groupId: 'group-1', optionIndex: 1 });

    expect(response.status).toBe(200);
    expect(response.body.picker.status).toBe('chosen');
    expect(chooseModelPickerOption).toHaveBeenCalledWith('agent-1', 'group-1', 1);
  });

  it('rejects a model choice when the agent became busy after opening the picker', async () => {
    const chooseModelPickerOption = vi.fn();
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        hasPendingAgentResponse: vi.fn().mockReturnValue(true),
        chooseModelPickerOption,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/choose')
      .send({ groupId: 'group-1', optionIndex: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('AI 正在工作，暂时不能切换模型，请等待当前任务完成后再试');
    expect(chooseModelPickerOption).not.toHaveBeenCalled();
  });

  it('sends fallback remote selector input', async () => {
    const sendModelPickerInput = vi.fn().mockReturnValue({ ...picker, status: 'fallback' });
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        sendModelPickerInput,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/input')
      .send({ groupId: 'group-1', action: 'down' });

    expect(response.status).toBe(200);
    expect(sendModelPickerInput).toHaveBeenCalledWith('agent-1', 'group-1', 'down');
  });

  it('rejects fallback confirmation when the agent became busy after opening the picker', async () => {
    const sendModelPickerInput = vi.fn();
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        hasPendingAgentResponse: vi.fn().mockReturnValue(true),
        sendModelPickerInput,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/input')
      .send({ groupId: 'group-1', action: 'enter' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('AI 正在工作，暂时不能切换模型，请等待当前任务完成后再试');
    expect(sendModelPickerInput).not.toHaveBeenCalled();
  });

  it('allows closing the fallback picker while the agent is busy', async () => {
    const sendModelPickerInput = vi.fn().mockReturnValue({ ...picker, status: 'cancelled' });
    const deps = makeDeps({
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        hasPendingAgentResponse: vi.fn().mockReturnValue(true),
        sendModelPickerInput,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/input')
      .send({ groupId: 'group-1', action: 'escape' });

    expect(response.status).toBe(200);
    expect(sendModelPickerInput).toHaveBeenCalledWith('agent-1', 'group-1', 'escape');
  });

  it('rejects unsupported platforms', async () => {
    const deps = makeDeps({
      store: {
        agentById: vi.fn().mockReturnValue({
          id: 'agent-1',
          platform: 'gemini-cli',
          name: 'Gemini CLI',
          command: 'gemini --yolo',
          avatarColor: 'blue',
        }),
      },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true) },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents/agent-1/model-picker/start')
      .send({ groupId: 'group-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('该 CLI 暂不支持原生模型切换');
  });
});

describe('POST /api/groups/:id/archive', () => {
  it('archives the group and stops its agents', async () => {
    const archiveGroup = vi.fn().mockReturnValue({
      id: 'group-1',
      name: 'Test Group',
      ownerName: '群主',
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' }],
      workingDirectory: '/tmp/project',
      groupType: 'execution',
      activeTaskSessionId: 'task-1',
      createdAt: Date.now() / 1000,
      archivedAt: 123,
    });
    const deps = makeDeps({ store: { archiveGroup } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/archive')
      .send();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.group.archivedAt).toBe(123);
    expect(archiveGroup).toHaveBeenCalledWith('group-1');
    expect(deps.pm.killAgent).toHaveBeenCalledWith('agent-1', 'group-1');
  });

  it('returns 404 when the group does not exist', async () => {
    const archiveGroup = vi.fn();
    const deps = makeDeps({
      store: {
        groupById: vi.fn().mockReturnValue(undefined),
        archiveGroup,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/missing/archive')
      .send();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'group not found' });
    expect(archiveGroup).not.toHaveBeenCalled();
    expect(deps.pm.killAgent).not.toHaveBeenCalled();
  });
});

describe('POST /api/groups/:id/unarchive', () => {
  it('restores an archived group', async () => {
    const unarchiveGroup = vi.fn().mockReturnValue({
      id: 'group-1',
      name: 'Test Group',
      ownerName: '群主',
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' }],
      workingDirectory: '/tmp/project',
      groupType: 'execution',
      activeTaskSessionId: 'task-1',
      createdAt: Date.now() / 1000,
    });
    const deps = makeDeps({ store: { unarchiveGroup } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/unarchive')
      .send();

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.group.archivedAt).toBeUndefined();
    expect(unarchiveGroup).toHaveBeenCalledWith('group-1');
    expect(deps.pm.killAgent).not.toHaveBeenCalled();
  });

  it('returns 404 when the group does not exist', async () => {
    const deps = makeDeps({
      store: {
        unarchiveGroup: vi.fn().mockReturnValue(undefined),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/missing/unarchive')
      .send();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'group not found' });
  });
});

describe('POST /api/messages', () => {
  it('rejects sending to archived groups', async () => {
    const deps = makeDeps({
      store: {
        groupById: vi.fn().mockReturnValue({
          id: 'group-1',
          name: 'Test Group',
          ownerName: '群主',
          members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' }],
          workingDirectory: '/tmp/project',
          groupType: 'execution',
          activeTaskSessionId: 'task-1',
          createdAt: Date.now() / 1000,
          archivedAt: 123,
        }),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: 'hello', groupId: 'group-1', taskSessionId: 'task-1' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: '会话已归档，请恢复后继续对话' });
  });
});

describe('mobile sync APIs', () => {
  it('returns mobile state without the full message list', async () => {
    const deps = makeDeps({
      hub: { messages: [{ id: 'm1', from: 'ai', to: 'user', body: 'large', ts: 1 }] },
      pm: {
        getRunningAgentIdsByGroup: vi.fn().mockReturnValue({ 'group-1': ['agent-1'] }),
        getBusyAgentIdsByGroup: vi.fn().mockReturnValue({ 'group-1': ['agent-1'] }),
        getRecentAgentErrorsByGroup: vi.fn().mockReturnValue({}),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/state/mobile');

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(1);
    expect(response.body.messages).toBeUndefined();
    expect(response.body.runningAgentIdsByGroup).toEqual({ 'group-1': ['agent-1'] });
    expect(response.body.busyAgentIdsByGroup).toEqual({ 'group-1': ['agent-1'] });
    expect(response.body.enabledAgentPlatforms).toEqual([
      'openai-codex-cli',
      'openclaude',
      'claude-code',
      'opencode',
      'github-copilot-cli',
      'gemini-cli',
      'cursor-cli',
      'kiro-cli',
      'qoder-cli',
      'codebuddy-cli',
    ]);
    expect(response.body.workspaceDataVersion).toBe(1);
  });

  it('returns incremental event envelopes with seq and serverTime', async () => {
    const eventsSince = vi.fn().mockReturnValue({
      events: [{ event: 'messages:update', data: { id: 'm1', body: 'hi' }, seq: 7, serverTime: 123 }],
      latestSeq: 7,
      resetRequired: false,
    });
    const deps = makeDeps({ hub: { eventsSince } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/events?since=6&limit=50');

    expect(response.status).toBe(200);
    expect(eventsSince).toHaveBeenCalledWith(6, 50);
    expect(response.body.events[0]).toMatchObject({ event: 'messages:update', seq: 7, serverTime: 123 });
  });

  it('paginates recent group messages by task session', async () => {
    const messages = [
      { id: 'old', from: 'user', to: '', body: 'old', ts: 1, groupId: 'group-1', taskSessionId: 'task-1' },
      { id: 'other-task', from: 'user', to: '', body: 'other', ts: 2, groupId: 'group-1', taskSessionId: 'task-2' },
      { id: 'mid', from: 'ai', to: 'user', body: 'mid', ts: 3, groupId: 'group-1', taskSessionId: 'task-1' },
      { id: 'new', from: 'ai', to: 'user', body: 'new', ts: 5, groupId: 'group-1', taskSessionId: 'task-1' },
    ];
    const deps = makeDeps({ hub: { messages } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .get('/api/groups/group-1/messages?taskSessionId=task-1&before=5&limit=1');

    expect(response.status).toBe(200);
    expect(response.body.messages.map((m: any) => m.id)).toEqual(['mid']);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.nextBefore).toBe(3);
  });
});

describe('POST /api/groups/:id/tasks', () => {
  it('rejects the legacy task endpoint in favor of the mission workflow', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/tasks')
      .send({ title: '全新任务' });

    expect(response.status).toBe(410);
    expect(response.body.error).toContain('/missions');
  });
});

describe('POST /api/groups/:id/worker-tasks', () => {
  it('rejects worktree creation because one mission stays on one machine and repository', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/worker-tasks')
      .send({ title: '修改字体' });

    expect(response.status).toBe(410);
    expect(response.body.error).toContain('Worktree');
  });
});

describe('POST /api/agents', () => {
  it('creates an agent from a supported platform', async () => {
    const deps = makeDeps({
      store: {
        agents: [], addAgent: vi.fn(),
        agentByName: vi.fn().mockReturnValue(undefined),
        nextAgentName: vi.fn().mockReturnValue('Claude Code'),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'claude-code', avatarColor: 'purple' });

    expect(response.status).toBe(200);
    expect(response.body.platform).toBe('claude-code');
    expect(response.body.name).toBe('Claude Code');
    expect(response.body.command).toBe('claude --permission-mode bypassPermissions');
    expect(response.body.avatarColor).toBe('purple');
    expect(deps.store.addAgent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'claude-code',
      name: 'Claude Code',
      command: 'claude --permission-mode bypassPermissions',
      avatarColor: 'purple',
    }));
  });

  it('rejects unsupported platforms', async () => {
    const deps = makeDeps({
      store: {
        agents: [], addAgent: vi.fn(),
        agentByName: vi.fn().mockReturnValue(undefined),
        nextAgentName: vi.fn().mockReturnValue('X'),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'unsupported-cli' });

    expect(response.status).toBe(400);
  });

  it('creates agents from formerly dormant supported platforms', async () => {
    const deps = makeDeps({
      store: {
        agents: [], addAgent: vi.fn(),
        agentByName: vi.fn().mockReturnValue(undefined),
        nextAgentName: vi.fn().mockReturnValue('OpenCode'),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'opencode' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      platform: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
    });
    expect(deps.store.addAgent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
    }));
  });

  it('allows creating a second agent on the same platform with auto-suffixed name', async () => {
    const store = {
      agents: [{
        id: 'agent-1', platform: 'claude-code', name: 'Claude Code',
        command: 'claude --permission-mode bypassPermissions', avatarColor: 'red',
      }],
      addAgent: vi.fn(),
      agentByName: vi.fn((name: string) => name === 'Claude Code' ? { id: 'agent-1' } : undefined),
      nextAgentName: vi.fn().mockReturnValue('Claude Code-2'),
    };
    const deps = makeDeps({ store });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'claude-code' });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Claude Code-2');
  });

  it('defaults avatar color to blue when omitted', async () => {
    const deps = makeDeps({
      store: {
        agents: [], addAgent: vi.fn(),
        agentByName: vi.fn().mockReturnValue(undefined),
        nextAgentName: vi.fn().mockReturnValue('Codex CLI'),
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'openai-codex-cli' });

    expect(response.status).toBe(200);
    expect(response.body.avatarColor).toBe('blue');
  });

  it('rejects duplicate displayName', async () => {
    const store = {
      agents: [{ id: 'agent-1', platform: 'claude-code', name: 'MyAgent' }],
      addAgent: vi.fn(),
      agentByName: vi.fn((name: string) => name === 'MyAgent' ? { id: 'agent-1' } : undefined),
      nextAgentName: vi.fn().mockReturnValue('Claude Code'),
    };
    const deps = makeDeps({ store });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/agents')
      .send({ platform: 'claude-code', displayName: 'MyAgent' });

    expect(response.status).toBe(409);
  });
});

describe('POST /api/groups', () => {
  it('creates a direct chat without role prompts or team files', async () => {
    const addGroup = vi.fn();
    const writeTeamFiles = vi.fn();
    const waitForPtyReady = vi.fn().mockResolvedValue(true);
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: { addGroup, writeTeamFiles },
      pm: {
        launchAgent: vi.fn().mockReturnValue(undefined),
        waitForPtyReady,
        sendKeys,
      },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: 'Claude 单聊',
        ownerName: '群主',
        workingDirectory: '/tmp/project',
        groupType: 'direct',
        members: [{ agentId: 'agent-1', roleId: 'role-developer' }],
      });

    expect(response.status).toBe(200);
    expect(response.body.groupType).toBe('direct');
    expect(response.body.members).toEqual([
      expect.objectContaining({ agentId: 'agent-1', roleId: null }),
    ]);
    expect(addGroup).toHaveBeenCalledWith(expect.objectContaining({ groupType: 'direct' }));
    expect(deps.pm.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }),
      9800,
      '/tmp/project',
      response.body.id,
    );
    expect(writeTeamFiles).not.toHaveBeenCalled();
    expect(waitForPtyReady).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('rejects direct chats with multiple members', async () => {
    const deps = makeDeps({ store: { addGroup: vi.fn() } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: 'Bad Direct',
        workingDirectory: '/tmp/project',
        groupType: 'direct',
        members: [
          { agentId: 'agent-1', roleId: null },
          { agentId: 'agent-2', roleId: null },
        ],
      });

    expect(response.status).toBe(400);
    expect(deps.store.addGroup).not.toHaveBeenCalled();
  });
});

describe('agent startup prompt API', () => {
  const prompt = {
    kind: 'bypass-permissions',
    agentId: 'agent-1',
    agentName: 'Claude Code',
    groupId: 'group-1',
    directory: '/tmp/project',
    rawPreview: 'WARNING: Claude Code running in Bypass Permissions mode',
    detectedAt: 123,
    updatedAt: 124,
  };

  it('returns pending prompts across groups for the web client', async () => {
    const getAgentStartupPrompts = vi.fn().mockReturnValue([prompt]);
    const deps = makeDeps({ pm: { getAgentStartupPrompts } });
    const app = createApp({ store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port });

    const response = await request(app).get('/api/agent-startup-prompts');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, prompts: [prompt] });
    expect(getAgentStartupPrompts).toHaveBeenCalledWith();
  });

  it('resolves a selected prompt with an explicit action', async () => {
    const resolveAgentStartupPrompts = vi.fn().mockReturnValue({ resolved: 1, prompts: [] });
    const deps = makeDeps({ pm: { resolveAgentStartupPrompts } });
    const app = createApp({ store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port });

    const response = await request(app)
      .post('/api/groups/group-1/agent-startup-prompts/resolve')
      .send({ action: 'accept', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, resolved: 1, prompts: [] });
    expect(resolveAgentStartupPrompts).toHaveBeenCalledWith('group-1', 'accept', ['agent-1']);
  });

  it('rejects invalid actions', async () => {
    const resolveAgentStartupPrompts = vi.fn();
    const deps = makeDeps({ pm: { resolveAgentStartupPrompts } });
    const app = createApp({ store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port });

    const response = await request(app)
      .post('/api/groups/group-1/agent-startup-prompts/resolve')
      .send({ action: 'continue' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('action must be accept or decline');
    expect(resolveAgentStartupPrompts).not.toHaveBeenCalled();
  });
});

describe('workspace trust API', () => {
  const prompt = {
    agentId: 'agent-1',
    agentName: 'Claude Code',
    groupId: 'group-1',
    directory: '/tmp/project',
    rawPreview: 'Accessing workspace:\n/tmp/project\n1. Yes, I trust this folder',
    detectedAt: 123,
    updatedAt: 124,
  };

  it('returns pending workspace trust prompts for a group', async () => {
    const getWorkspaceTrustPrompts = vi.fn().mockReturnValue([prompt]);
    const deps = makeDeps({
      pm: { getWorkspaceTrustPrompts },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .get('/api/groups/group-1/workspace-trust');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, prompts: [prompt] });
    expect(getWorkspaceTrustPrompts).toHaveBeenCalledWith('group-1');
  });

  it('confirms all pending workspace trust prompts by default', async () => {
    const confirmWorkspaceTrustPrompts = vi.fn().mockReturnValue({ confirmed: 1, prompts: [] });
    const deps = makeDeps({
      pm: { confirmWorkspaceTrustPrompts },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/workspace-trust/confirm')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, confirmed: 1, prompts: [] });
    expect(confirmWorkspaceTrustPrompts).toHaveBeenCalledWith('group-1', undefined);
  });

  it('confirms selected member prompts only', async () => {
    const confirmWorkspaceTrustPrompts = vi.fn().mockReturnValue({ confirmed: 1, prompts: [] });
    const deps = makeDeps({
      pm: { confirmWorkspaceTrustPrompts },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/workspace-trust/confirm')
      .send({ agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(confirmWorkspaceTrustPrompts).toHaveBeenCalledWith('group-1', ['agent-1']);
  });

  it('rejects confirmation for non-member agents', async () => {
    const confirmWorkspaceTrustPrompts = vi.fn();
    const deps = makeDeps({
      pm: { confirmWorkspaceTrustPrompts },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/workspace-trust/confirm')
      .send({ agentIds: ['agent-2'] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('agent is not a member of the group');
    expect(confirmWorkspaceTrustPrompts).not.toHaveBeenCalled();
  });

  it('rejects empty confirmation target lists', async () => {
    const confirmWorkspaceTrustPrompts = vi.fn();
    const deps = makeDeps({
      pm: { confirmWorkspaceTrustPrompts },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/workspace-trust/confirm')
      .send({ agentIds: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('agentIds must be a non-empty string array');
    expect(confirmWorkspaceTrustPrompts).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown groups', async () => {
    const deps = makeDeps({
      store: { groupById: vi.fn().mockReturnValue(undefined) },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .get('/api/groups/missing/workspace-trust');

    expect(response.status).toBe(404);
  });
});

describe('PUT /api/agents/:id', () => {
  it('rejects updates to platform-backed identity fields', async () => {
    const deps = makeDeps({ store: { updateAgent: vi.fn() } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .put('/api/agents/agent-1')
      .send({
        platform: 'cursor-cli',
        name: 'Cursor CLI',
        command: 'cursor',
      });

    expect(response.status).toBe(400);
    expect(deps.store.updateAgent).not.toHaveBeenCalled();
  });
});

describe('GET /api/system/directories', () => {
  it('defaults to the Mac user home directory', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/system/directories');

    expect(response.status).toBe(200);
    expect(response.body.path).toBe(homedir());
    expect(Array.isArray(response.body.entries)).toBe(true);
  });

  it('lists directories only for the requested path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-dir-browser-'));
    try {
      mkdirSync(join(root, 'zeta'));
      mkdirSync(join(root, 'alpha'));
      writeFileSync(join(root, 'file.txt'), 'x');
      const deps = makeDeps();
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .get('/api/system/directories')
        .query({ path: root });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe(root);
      expect(response.body.parentPath).toBe(dirname(root));
      expect(response.body.entries).toEqual([
        { name: 'alpha', path: join(root, 'alpha') },
        { name: 'zeta', path: join(root, 'zeta') },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects file paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-dir-file-'));
    try {
      const filePath = join(root, 'file.txt');
      writeFileSync(filePath, 'x');
      const deps = makeDeps();
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .get('/api/system/directories')
        .query({ path: filePath });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('path is not a directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for missing paths', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .get('/api/system/directories')
      .query({ path: '/tmp/__missing_octrix_directory__' });

    expect(response.status).toBe(404);
  });
});

describe('POST /api/system/permissions/files', () => {
  it('由 Host 主进程依次访问桌面、文稿和下载目录以触发 macOS 授权', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octrix-protected-folders-'));
    try {
      for (const folder of ['Desktop', 'Documents', 'Downloads']) {
        mkdirSync(join(home, folder));
      }
      const deps = makeDeps();
      const app = createApp({
        store: deps.store as any,
        hub: deps.hub as any,
        pm: deps.pm as any,
        port: deps.port,
        protectedFolderHome: home,
      });

      const response = await request(app).post('/api/system/permissions/files');

      expect(response.status).toBe(200);
      expect(response.body.folders).toEqual([
        { name: 'Desktop', granted: true },
        { name: 'Documents', granted: true },
        { name: 'Downloads', granted: true },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('GET /api/groups/:id/files', () => {
  it('returns 404 for unknown group', async () => {
    const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(undefined) } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/groups/unknown/files');
    expect(response.status).toBe(404);
  });

  it('returns empty files when group has no workingDirectory', async () => {
    const groupNoDir = {
      id: 'g-no-dir', name: 'No Dir', ownerName: '群主', members: [],
      groupType: 'execution' as const, createdAt: Date.now() / 1000,
    };
    const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(groupNoDir) } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get(`/api/groups/${groupNoDir.id}/files`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ path: '', files: [] });
  });

  it('returns empty files for non-existent directory', async () => {
    const groupBadDir = {
      id: 'g-bad', name: 'Bad', ownerName: '群主', members: [],
      workingDirectory: '/tmp/__nonexistent_dir_test__',
      groupType: 'execution' as const, createdAt: Date.now() / 1000,
    };
    const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(groupBadDir) } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get(`/api/groups/${groupBadDir.id}/files`);
    expect(response.status).toBe(200);
    expect(response.body.path).toBe('/tmp/__nonexistent_dir_test__');
    expect(response.body.files).toEqual([]);
  });

  it('lists dotfiles and dot-directories alongside normal entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-files-'));
    try {
      writeFileSync(join(root, 'visible.txt'), 'x');
      writeFileSync(join(root, '.hidden'), 'y');
      mkdirSync(join(root, '.dotdir'));
      writeFileSync(join(root, '.dotdir', 'inside.txt'), 'z');

      const group = {
        id: 'g-dot',
        name: 'Dot',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app).get(`/api/groups/${group.id}/files`);
      expect(response.status).toBe(200);
      expect(response.body.path).toBe(root);
      const names = response.body.files.map((f: { name: string }) => f.name);
      expect(names).toContain('.dotdir');
      expect(names).toContain('.hidden');
      expect(names).toContain('visible.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/groups/:id/files/read', () => {
  it('reads a text file from the group working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-read-'));
    try {
      writeFileSync(join(root, 'README.md'), '# Hello\n');
      const group = {
        id: 'g-read',
        name: 'Read',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .get(`/api/groups/${group.id}/files/read`)
        .query({ path: 'README.md' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe(join(root, 'README.md'));
      expect(response.body.content).toBe('# Hello\n');
      expect(response.body.isBinary).toBe(false);
      expect(response.body.truncated).toBe(false);
      expect(response.body.size).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the group working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-read-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-read-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      const group = {
        id: 'g-read-safe',
        name: 'Read Safe',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .get(`/api/groups/${group.id}/files/read`)
        .query({ path: `../${outside.split('/').pop()}/secret.txt` });

      expect(response.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-read-dir-'));
    try {
      mkdirSync(join(root, 'src'));
      const group = {
        id: 'g-read-dir',
        name: 'Read Dir',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .get(`/api/groups/${group.id}/files/read`)
        .query({ path: 'src' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('file required');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Workspace import APIs', () => {
  it('imports multipart files into the requested target directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-import-'));
    try {
      const group = {
        id: 'group-1',
        name: 'Test Group',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .post('/api/groups/group-1/files/import')
        .field('targetSubpath', 'src/assets')
        .attach('files', Buffer.from('hello world'), 'note.txt');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, imported: 1 });
      expect(existsSync(join(root, 'src/assets/note.txt'))).toBe(true);
      expect(readFileSync(join(root, 'src/assets/note.txt'), 'utf8')).toBe('hello world');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('imports native paths into the requested target directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-import-root-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'ai-agent-bridge-import-src-'));
    try {
      const sourceFile = join(sourceRoot, 'diagram.png');
      writeFileSync(sourceFile, 'png-bytes');
      const group = {
        id: 'group-1',
        name: 'Test Group',
        ownerName: '群主',
        members: [],
        workingDirectory: root,
        groupType: 'execution' as const,
        createdAt: Date.now() / 1000,
      };
      const deps = makeDeps({ store: { groupById: vi.fn().mockReturnValue(group) } });
      const app = createApp({
        store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
      });

      const response = await request(app)
        .post('/api/groups/group-1/files/import-from-paths')
        .send({ paths: [sourceFile], targetSubpath: 'images/raw' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, imported: 1 });
      expect(existsSync(join(root, 'images/raw/diagram.png'))).toBe(true);
      expect(readFileSync(join(root, 'images/raw/diagram.png'), 'utf8')).toBe('png-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('Git workspace APIs', () => {
  it('returns git status for a tracked workspace', async () => {
    gitMocks.getGitWorkspaceStatus.mockResolvedValue({
      isGitRepository: true,
      branch: 'main',
      repositoryRoot: '/tmp/project',
      entries: [
        { path: 'src/app.ts', section: 'unstaged', staged: false, kind: 'modified', x: ' ', y: 'M' },
      ],
    });
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/groups/group-1/git/status');

    expect(response.status).toBe(200);
    expect(response.body.branch).toBe('main');
    expect(response.body.entries).toHaveLength(1);
    expect(gitMocks.getGitWorkspaceStatus).toHaveBeenCalledWith('/tmp/project');
  });

  it('returns a diff payload for a selected file', async () => {
    gitMocks.getGitDiffForPath.mockResolvedValue({
      path: 'src/app.ts',
      kind: 'modified',
      section: 'unstaged',
      staged: false,
      before: { exists: true, isBinary: false, text: 'old line' },
      after: { exists: true, isBinary: false, text: 'new line' },
      beforeLabel: 'Index',
      afterLabel: 'Working tree',
      isBinary: false,
    });
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .get('/api/groups/group-1/git/diff')
      .query({ path: 'src/app.ts', section: 'unstaged', kind: 'modified' });

    expect(response.status).toBe(200);
    expect(response.body.after.text).toBe('new line');
    expect(gitMocks.getGitDiffForPath).toHaveBeenCalledWith('/tmp/project', {
      path: 'src/app.ts',
      section: 'unstaged',
      kind: 'modified',
    });
  });

  it('stages a file through the git API', async () => {
    gitMocks.stageGitPath.mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/git/stage')
      .send({ path: 'src/app.ts' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(gitMocks.stageGitPath).toHaveBeenCalledWith('/tmp/project', 'src/app.ts');
  });

  it('unstages a file through the git API', async () => {
    gitMocks.unstageGitPath.mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/groups/group-1/git/unstage')
      .send({ path: 'src/app.ts' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(gitMocks.unstageGitPath).toHaveBeenCalledWith('/tmp/project', 'src/app.ts');
  });
});

describe('POST /api/messages', () => {
  it('sends direct chat messages to the CLI without role wrapping', async () => {
    const sendKeys = vi.fn();
    const sendUserMessage = vi.fn();
    const directGroup = {
      id: 'direct-1',
      name: 'Claude 单聊',
      ownerName: '群主',
      members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
      workingDirectory: '/tmp/project',
      groupType: 'direct' as const,
      activeTaskSessionId: 'task-1',
      createdAt: Date.now() / 1000,
    };
    const deps = makeDeps({
      store: {
        groupById: vi.fn().mockReturnValue(directGroup),
        roleName: vi.fn().mockReturnValue(undefined),
      },
      hub: { sendUserMessage },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: 'hello', groupId: 'direct-1', to: 'Claude Code', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith('hello', 'direct-1', 'task-1', 'Claude Code');
    expect(sendKeys).toHaveBeenCalledWith('agent-1', 'hello', 'direct-1', 'task-1');
  });

  it('passes clientMsgId through to the hub when provided', async () => {
    const sendUserMessage = vi.fn();
    const deps = makeDeps({
      hub: { sendUserMessage },
      pm: { isAgentRunning: vi.fn().mockReturnValue(false) },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({
        body: 'hello',
        groupId: 'group-1',
        taskSessionId: 'task-1',
        to: '所有人',
        agentIds: ['agent-1'],
        clientMsgId: 'ios-msg-1',
      });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith('hello', 'group-1', 'task-1', '所有人', 'ios-msg-1');
  });

  it('strips a leading role mention before sending to the CLI', async () => {
    const sendKeys = vi.fn();
    const sendUserMessage = vi.fn();
    const deps = makeDeps({
      store: { roleName: vi.fn().mockReturnValue('代码审查') },
      hub: { sendUserMessage },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '@代码审查(OpenCode)-1 /status', groupId: 'group-1', to: '代码审查(OpenCode)-1', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith('@代码审查(OpenCode)-1 /status', 'group-1', 'task-1', '代码审查(OpenCode)-1');
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      '[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n/status',
      'group-1',
      'task-1',
    );
  });

  it('strips multiple leading mentions before sending to the CLI', async () => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: { roleName: vi.fn().mockReturnValue('代码审查') },
      hub: { sendUserMessage: vi.fn() },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '@代码审查 @测试 /help', groupId: 'group-1', to: '代码审查, 测试', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      '[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n/help',
      'group-1',
      'task-1',
    );
  });

  it('strips a leading @所有人 mention before sending to the CLI', async () => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: { roleName: vi.fn().mockReturnValue('代码审查') },
      hub: { sendUserMessage: vi.fn() },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '@所有人 继续', groupId: 'group-1', to: '所有人', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      '[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n继续',
      'group-1',
      'task-1',
    );
  });

  it('keeps non-leading mentions untouched for the CLI payload', async () => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: { roleName: vi.fn().mockReturnValue('代码审查') },
      hub: { sendUserMessage: vi.fn() },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '请 @代码审查 看一下', groupId: 'group-1', to: '代码审查', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      '[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n请 @代码审查 看一下',
      'group-1',
      'task-1',
    );
  });

  it('falls back to the original body when stripping would leave the CLI payload empty', async () => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: { roleName: vi.fn().mockReturnValue('代码审查') },
      hub: { sendUserMessage: vi.fn() },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '@代码审查(OpenCode)-1', groupId: 'group-1', to: '代码审查(OpenCode)-1', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      '[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n@代码审查(OpenCode)-1',
      'group-1',
      'task-1',
    );
  });

  it.each([
    ['cursor-cli', '/compact', '/compress'],
    ['cursor-cli', '/clear', '/clear'],
    ['cursor-cli', '/new', '/clear'],
    ['gemini-cli', '/compact', '/compress'],
    ['gemini-cli', '/new', '/clear'],
    ['claude-code', '/new', '/clear'],
    ['openclaude', '/new', '/clear'],
    ['kiro-cli', '/new', '/chat new'],
    ['opencode', '/compact', '/new'],
    ['opencode', '/clear', '/new'],
    ['opencode', '/new', '/new'],
    ['qoder-cli', '/new', '/clear'],
    ['codebuddy-cli', '/new', '/clear'],
  ] as const)('normalizes %s slash command %s to %s before sending to the CLI', async (platform, input, expected) => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      store: {
        roleName: vi.fn().mockReturnValue('代码审查'),
        agentById: vi.fn().mockReturnValue({
          id: 'agent-1',
          platform,
          name: platform,
          command: platform,
          avatarColor: 'blue',
        }),
      },
      hub: { sendUserMessage: vi.fn() },
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys },
    });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: input, groupId: 'group-1', to: '代码审查', agentIds: ['agent-1'] });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1',
      `[角色: 代码审查 | 正式状态变更仅使用 octrix-action 控制块]\n${expected}`,
      'group-1',
      'task-1',
    );
  });
});

describe('GET /api/messages/:id', () => {
  it('returns the message when it exists', async () => {
    const msg = { id: 'e1', from: 'ai', to: 'user', body: 'full content', ts: 42, groupId: 'g1' };
    const deps = makeDeps({ hub: { messages: [msg] } });
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/messages/e1');

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('e1');
    expect(response.body.body).toBe('full content');
  });

  it('returns 404 when the message does not exist', async () => {
    const deps = makeDeps();
    const app = createApp({
      store: deps.store as any, hub: deps.hub as any, pm: deps.pm as any, port: deps.port,
    });

    const response = await request(app).get('/api/messages/nonexistent');

    expect(response.status).toBe(404);
  });
});
