import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { createAgentGroup, createGroupMember, type Agent } from './models';
import { parseCollaborationControlBlocks } from './collaboration-protocol';
import { Store } from './store';

function makeGroup() {
  return {
    id: 'group-1',
    name: 'Test Group',
    ownerName: '群主',
    members: [{ id: 'member-1', agentId: 'agent-1', roleId: null }],
    workingDirectory: '/tmp/project',
    groupType: 'direct' as const,
    activeTaskSessionId: 'task-1',
    createdAt: Date.now() / 1000,
  };
}

function makeInterruptApp() {
  const group = makeGroup();
  const interruptAgent = vi.fn((agentId: string) => agentId === 'agent-1');
  const app = createApp({
    store: {
      groupById: vi.fn().mockReturnValue(group),
      activeTaskSessionForGroup: vi.fn().mockReturnValue({ id: 'task-1' }),
    } as any,
    hub: {} as any,
    pm: { interruptAgent } as any,
    port: 9800,
  });
  return { app, interruptAgent };
}

describe('POST /api/groups/:id/interrupt', () => {
  it('interrupts only the requested group agents in the active task session', async () => {
    const { app, interruptAgent } = makeInterruptApp();

    const response = await request(app)
      .post('/api/groups/group-1/interrupt')
      .send({
        taskSessionId: 'task-1',
        targets: [{ agentId: 'agent-1', responseId: 'response-1' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, interruptedAgentIds: ['agent-1'] });
    expect(interruptAgent).toHaveBeenCalledWith('agent-1', 'group-1', 'task-1', 'response-1');
  });

  it('does not let a stale task session interrupt the active conversation', async () => {
    const { app, interruptAgent } = makeInterruptApp();

    const response = await request(app)
      .post('/api/groups/group-1/interrupt')
      .send({
        taskSessionId: 'task-old',
        targets: [{ agentId: 'agent-1', responseId: 'response-1' }],
      });

    expect(response.status).toBe(409);
    expect(interruptAgent).not.toHaveBeenCalled();
  });

  it('rejects agents that are not members of the group', async () => {
    const { app, interruptAgent } = makeInterruptApp();

    const response = await request(app)
      .post('/api/groups/group-1/interrupt')
      .send({
        taskSessionId: 'task-1',
        targets: [{ agentId: 'agent-outside', responseId: 'response-1' }],
      });

    expect(response.status).toBe(400);
    expect(interruptAgent).not.toHaveBeenCalled();
  });
});

describe('POST /api/messages response identity', () => {
  it('records an unmentioned collaboration lobby message without broadcasting to AIs', async () => {
    const group = {
      ...makeGroup(),
      groupType: 'collaboration' as const,
      activeTaskSessionId: undefined,
      members: [
        { id: 'member-dev', agentId: 'agent-dev', roleId: 'role-developer' },
        { id: 'member-review', agentId: 'agent-review', roleId: 'role-code-reviewer' },
      ],
      roleLeaders: {
        'role-developer': 'member-dev',
        'role-code-reviewer': 'member-review',
      },
    };
    const sendUserMessage = vi.fn();
    const addSystemNotice = vi.fn();
    const sendKeys = vi.fn();
    const app = createApp({
      store: {
        groupById: vi.fn().mockReturnValue(group),
        activeTaskSessionForGroup: vi.fn().mockReturnValue(undefined),
      } as any,
      hub: { sendUserMessage, addSystemNotice } as any,
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys } as any,
      port: 9800,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({ body: '我们先聊一下目标', groupId: group.id, agentIds: [] });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith('我们先聊一下目标', group.id, undefined, '');
    expect(addSystemNotice).toHaveBeenCalledWith(
      group.id,
      undefined,
      expect.stringContaining('创建主任务'),
    );
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('passes clientMsgId to the pending CLI response', async () => {
    const group = makeGroup();
    const sendUserMessage = vi.fn();
    const sendKeys = vi.fn();
    const app = createApp({
      store: {
        groupById: vi.fn().mockReturnValue(group),
        activeTaskSessionForGroup: vi.fn().mockReturnValue({ id: 'task-1' }),
        agentById: vi.fn().mockReturnValue({ id: 'agent-1', platform: 'openai-codex-cli' }),
        roleName: vi.fn().mockReturnValue(undefined),
      } as any,
      hub: { sendUserMessage } as any,
      pm: {
        isAgentRunning: vi.fn().mockReturnValue(true),
        sendKeys,
      } as any,
      port: 9800,
    });

    const response = await request(app)
      .post('/api/messages')
      .send({
        body: 'hello',
        groupId: 'group-1',
        taskSessionId: 'task-1',
        to: 'OpenAI Codex CLI',
        agentIds: ['agent-1'],
        clientMsgId: 'ios-msg-1',
      });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledWith(
      'hello', 'group-1', 'task-1', 'OpenAI Codex CLI', 'ios-msg-1',
    );
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-1', 'hello', 'group-1', 'task-1', 'ios-msg-1',
    );
  });

  it('routes an unmentioned collaboration message only to the current phase Leader', async () => {
    const group = {
      ...makeGroup(),
      groupType: 'collaboration' as const,
      members: [
        { id: 'member-dev', agentId: 'agent-dev', roleId: 'role-developer' },
        { id: 'member-review', agentId: 'agent-review', roleId: 'role-code-reviewer' },
      ],
      roleLeaders: {
        'role-developer': 'member-dev',
        'role-code-reviewer': 'member-review',
      },
    };
    const sendKeys = vi.fn();
    const app = createApp({
      store: {
        groupById: vi.fn().mockReturnValue(group),
        activeTaskSessionForGroup: vi.fn().mockReturnValue({ id: 'task-1' }),
        taskSessionById: vi.fn().mockReturnValue({
          id: 'task-1',
          currentPhaseId: 'phase-dev',
          phases: [{ id: 'phase-dev', roleId: 'role-developer' }],
          leaderSnapshot: { 'role-developer': 'member-dev' },
        }),
        agentById: vi.fn((id: string) => ({ id, platform: 'openai-codex-cli', name: id })),
        roleName: vi.fn().mockReturnValue('研发'),
        roles: [
          { id: 'role-developer', name: '研发' },
          { id: 'role-code-reviewer', name: '代码审查' },
        ],
      } as any,
      hub: { sendUserMessage: vi.fn() } as any,
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys } as any,
      port: 9800,
    });

    const response = await request(app).post('/api/messages').send({
      body: '请汇报当前进度',
      groupId: group.id,
      taskSessionId: 'task-1',
      agentIds: ['agent-dev', 'agent-review'],
    });

    expect(response.status).toBe(200);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith(
      'agent-dev',
      '[角色: 研发 | 正式状态变更仅使用 octrix-action 控制块]\n请汇报当前进度',
      group.id,
      'task-1',
    );
  });

  it('records an unmentioned group message without broadcasting when no mission phase is active', async () => {
    const group = {
      ...makeGroup(),
      groupType: 'collaboration' as const,
      members: [
        { id: 'member-dev', agentId: 'agent-dev', roleId: 'role-developer' },
        { id: 'member-review', agentId: 'agent-review', roleId: 'role-code-reviewer' },
      ],
    };
    const sendUserMessage = vi.fn();
    const sendKeys = vi.fn();
    const app = createApp({
      store: {
        groupById: vi.fn().mockReturnValue(group),
        activeTaskSessionForGroup: vi.fn().mockReturnValue({ id: 'task-1' }),
        taskSessionById: vi.fn().mockReturnValue({ id: 'task-1', phases: [] }),
        roles: [],
      } as any,
      hub: { sendUserMessage } as any,
      pm: { isAgentRunning: vi.fn().mockReturnValue(true), sendKeys } as any,
      port: 9800,
    });

    const response = await request(app).post('/api/messages').send({
      body: '先记录这个想法',
      groupId: group.id,
      taskSessionId: 'task-1',
      agentIds: ['agent-dev', 'agent-review'],
    });

    expect(response.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

{
// app.ts collaboration group composition cases
function makeApp() {
  const store = {
    agents: [],
    groups: [],
    roles: [],
    taskSessions: [],
    groupByResolvedWorkingDirectory: vi.fn().mockReturnValue(undefined),
    addGroup: vi.fn(),
    agentById: vi.fn(),
    writeTeamFiles: vi.fn(),
    roleFileName: vi.fn(),
  };
  const hub = {
    messages: [],
    port: 9800,
    isRunning: true,
  };
  const pm = {
    getRunningAgentIdsByGroup: vi.fn().mockReturnValue({}),
    getRecentAgentErrorsByGroup: vi.fn().mockReturnValue({}),
    launchAgent: vi.fn(),
    waitForPtyReady: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn(),
  };

  return {
    app: createApp({ store: store as any, hub: hub as any, pm: pm as any, port: 9800 }),
    store,
  };
}

describe('app collaboration group composition', () => {
  it('rejects a collaboration group with fewer than two AI members', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '研发协作群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [{ agentId: 'agent-1', roleId: 'role-developer' }],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: '群聊至少需要两个 AI；一个 AI 请创建单聊' });
    expect(store.addGroup).not.toHaveBeenCalled();
  });

  it('rejects assigning the same AI to more than one role in a group', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '重复成员群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [
          { agentId: 'agent-1', roleId: 'role-developer' },
          { agentId: 'agent-1', roleId: 'role-code-reviewer' },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: '一个 AI 在同一群内只能拥有一个角色' });
    expect(store.addGroup).not.toHaveBeenCalled();
  });

  it('requires exactly one base role for every collaboration member', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '缺少角色群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [
          { agentId: 'agent-1', roleId: 'role-developer' },
          { agentId: 'agent-2', roleId: null },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: '群聊中的每个 AI 都必须且只能分配一个基础角色' });
    expect(store.addGroup).not.toHaveBeenCalled();
  });

  it('allows at most one committer in a collaboration group', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '重复提交专员群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [
          { agentId: 'agent-1', roleId: 'role-committer' },
          { agentId: 'agent-2', roleId: 'role-committer' },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: '每个群最多只能有一个提交专员' });
    expect(store.addGroup).not.toHaveBeenCalled();
  });

  it('requires an explicit Leader when a role has multiple members', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '双研发群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [
          { agentId: 'agent-1', roleId: 'role-developer' },
          { agentId: 'agent-2', roleId: 'role-developer' },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: '角色「研发」有多名成员，请指定一个 Leader' });
    expect(store.addGroup).not.toHaveBeenCalled();
  });

  it('persists explicit and automatic role Leaders for a valid group', async () => {
    const { app, store } = makeApp();

    const response = await request(app)
      .post('/api/groups')
      .send({
        name: '完整协作群',
        ownerName: '群主',
        groupType: 'collaboration',
        workingDirectory: '/tmp/octrix-project',
        members: [
          { agentId: 'agent-1', roleId: 'role-developer' },
          { agentId: 'agent-2', roleId: 'role-developer' },
          { agentId: 'agent-3', roleId: 'role-tester' },
        ],
        roleLeaders: {
          'role-developer': 'agent-2',
        },
      });

    expect(response.status).toBe(200);
    expect(store.addGroup).toHaveBeenCalledOnce();
    const group = store.addGroup.mock.calls[0][0] as any;
    const developerLeader = group.members.find((member: any) => member.agentId === 'agent-2');
    const testerLeader = group.members.find((member: any) => member.agentId === 'agent-3');
    expect(group.groupType).toBe('collaboration');
    expect(group.compositionStatus).toBe('active');
    expect(group.roleLeaders).toEqual({
      'role-developer': developerLeader.id,
      'role-tester': testerLeader.id,
    });
  });
});
}

{
// app.ts mission API cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initializeGitWorkspace(workspace: string) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Octrix Test'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'octrix@example.com'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Initial\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: workspace });
}

function makeApp() {
  const storageDir = makeTempDir('octrix-mission-store-');
  const workspace = makeTempDir('octrix-mission-workspace-');
  const store = new Store(storageDir);
  const roles = [
    'role-product-manager',
    'role-developer',
    'role-code-reviewer',
    'role-tester',
    'role-committer',
  ];
  const members = roles.map((roleId, index) => {
    const agent: Agent = {
      id: `agent-${index + 1}`,
      platform: 'claude-code',
      name: `Claude Code ${index + 1}`,
      command: 'claude --permission-mode bypassPermissions',
      avatarColor: 'blue',
    };
    store.addAgent(agent);
    return createGroupMember(agent.id, roleId);
  });
  const roleLeaders = Object.fromEntries(members.map(member => [member.roleId!, member.id]));
  const group = createAgentGroup(
    '完整研发群',
    '群主',
    members,
    workspace,
    'collaboration',
    roleLeaders,
  );
  store.addGroup(group);

  const hub = { messages: [], port: 9800, isRunning: true };
  const pm = {
    getRunningAgentIdsByGroup: vi.fn().mockReturnValue({}),
    getRecentAgentErrorsByGroup: vi.fn().mockReturnValue({}),
    killAgent: vi.fn(),
    launchAgent: vi.fn().mockReturnValue(undefined),
    waitForAgentStartup: vi.fn().mockResolvedValue(undefined),
    waitForPtyReady: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn(),
  };
  const app = createApp({ store, hub: hub as any, pm: pm as any, port: 9800 });
  return { app, store, group, workspace, pm };
}

describe('app mission API', () => {
  it('generates an editable charter preview from one natural-language goal', async () => {
    const { app, group } = makeApp();

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/preview`)
      .send({ goal: '修复登录错误并完成回归测试' });

    expect(response.status).toBe(200);
    expect(response.body.draft).toEqual(expect.objectContaining({
      template: 'bugfix',
      objective: '修复登录错误并完成回归测试',
      qualityPolicy: {
        blockingSeverities: ['blocker', 'major'],
        sharedStateTestExecution: 'serial',
      },
    }));
    expect(response.body.draft.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('creates a draft mission and its server-managed Markdown plan', async () => {
    const { app, store, group, workspace } = makeApp();

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '优化登录流程',
        objective: '让用户可以使用一次性验证码登录',
        template: 'feature',
        acceptanceCriteria: ['验证码正确时登录成功', '验证码错误时显示明确提示'],
      });

    expect(response.status).toBe(201);
    expect(response.body.mission).toEqual(expect.objectContaining({
      groupId: group.id,
      title: '优化登录流程',
      objective: '让用户可以使用一次性验证码登录',
      template: 'feature',
      status: 'draft',
      revision: 0,
      initialOwnerMemberId: group.roleLeaders['role-product-manager'],
    }));
    expect(response.body.mission.phases.map((phase: any) => phase.roleId)).toEqual([
      'role-product-manager',
      'role-developer',
      'role-code-reviewer',
      'role-tester',
      'role-committer',
    ]);
    expect(store.taskSessions).toHaveLength(1);

    const missionDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      response.body.mission.id,
    );
    expect(fs.readFileSync(path.join(missionDir, 'mission.md'), 'utf-8')).toContain('status: draft');
    expect(fs.readFileSync(path.join(missionDir, 'plan.md'), 'utf-8')).toContain('代码审查');
    expect(fs.readFileSync(path.join(missionDir, 'events.md'), 'utf-8')).toContain('mission.created');
  });

  it('lets the owner edit the generated charter and quality policy before start', async () => {
    const { app, group } = makeApp();
    const created = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '初始标题',
        objective: '初始目标',
        template: 'review',
        acceptanceCriteria: ['初始标准'],
      });

    const response = await request(app)
      .put(`/api/groups/${group.id}/missions/${created.body.mission.id}/charter`)
      .send({
        title: '最终审查任务',
        objective: '审查登录改动的安全性与回归风险',
        acceptanceCriteria: ['完整记录审查范围', '所有重大问题关闭'],
        qualityPolicy: {
          blockingSeverities: ['blocker', 'major', 'minor'],
          sharedStateTestExecution: 'serial',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.mission).toEqual(expect.objectContaining({
      title: '最终审查任务',
      revision: 1,
      qualityPolicy: {
        blockingSeverities: ['blocker', 'major', 'minor'],
        sharedStateTestExecution: 'serial',
      },
    }));
  });

  it('initializes Git before starting a submission mission', async () => {
    const { app, group, workspace } = makeApp();
    const created = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '提交当前改动',
        objective: 'push 任务分支并创建 Draft PR',
        template: 'submission',
        acceptanceCriteria: ['Draft PR 已创建'],
      });

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${created.body.mission.id}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.mission.gitBaseline).toEqual(expect.objectContaining({
      repositoryRoot: fs.realpathSync(workspace),
      baseBranch: 'main',
      taskBranch: expect.stringMatching(/^octrix\//),
    }));
    expect(created.body.mission.phases.map((phase: any) => phase.roleId)).toEqual([
      'role-developer',
      'role-committer',
    ]);
  });

  it('binds a standalone test mission to owner requirements and the clean Git baseline', async () => {
    const { app, group, workspace } = makeApp();
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Octrix Test'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'octrix@example.com'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Test target\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: workspace });
    const created = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '独立回归测试',
        objective: '验证当前 Git 基线上的登录流程',
        template: 'test',
        acceptanceCriteria: ['记录真实命令和业务验收证据'],
      });

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${created.body.mission.id}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.mission).toEqual(expect.objectContaining({
      currentRequirementsRevision: 1,
      currentImplementationRevisionId: 'R000',
    }));
    expect(response.body.workItem).toEqual(expect.objectContaining({
      roleId: 'role-tester',
      requirementsRevision: 1,
      implementationRevisionId: 'R000',
    }));
    expect(response.body.mission.implementationRevisions).toEqual([
      expect.objectContaining({ id: 'R000', changedFiles: [] }),
    ]);
  });

  it('lets the owner reorder and trim the fixed phase plan before start', async () => {
    const { app, group, workspace } = makeApp();
    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '先测后审的修复',
        objective: '按任务风险调整阶段顺序',
        template: 'bugfix',
        acceptanceCriteria: ['阶段计划按群主确认版本执行'],
      });
    const missionId = draftResponse.body.mission.id as string;

    const response = await request(app)
      .put(`/api/groups/${group.id}/missions/${missionId}/plan`)
      .send({
        roleIds: ['role-developer', 'role-tester', 'role-code-reviewer', 'role-committer'],
        autoMergeAuthorized: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.mission.phases.map((phase: any) => phase.roleId)).toEqual([
      'role-developer',
      'role-tester',
      'role-code-reviewer',
      'role-committer',
    ]);
    expect(response.body.mission.phases.map((phase: any) => phase.order)).toEqual([1, 2, 3, 4]);
    expect(response.body.mission.autoMergeAuthorized).toBe(true);
    const plan = fs.readFileSync(path.join(workspace, '.ai-team', 'tasks', missionId, 'plan.md'), 'utf-8');
    expect(plan.indexOf('测试')).toBeLessThan(plan.indexOf('代码审查'));
    expect(plan).toContain('自动合并预授权：是');
  });

  it('starts a confirmed draft and offers the first phase work item', async () => {
    const { app, store, group, workspace, pm } = makeApp();
    initializeGitWorkspace(workspace);
    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '优化登录流程',
        objective: '让用户可以使用一次性验证码登录',
        template: 'feature',
        acceptanceCriteria: ['验证码正确时登录成功'],
      });
    const missionId = draftResponse.body.mission.id as string;

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.mission).toEqual(expect.objectContaining({
      id: missionId,
      status: 'active',
      revision: 3,
      currentPhaseId: 'phase-1-product-manager',
    }));
    expect(response.body.workItem).toEqual(expect.objectContaining({
      taskSessionId: missionId,
      roleId: 'role-product-manager',
      ownerMemberId: group.roleLeaders['role-product-manager'],
      status: 'offered',
    }));
    expect(store.taskCards).toHaveLength(1);
    expect(pm.killAgent).toHaveBeenCalledTimes(5);

    const missionDir = path.join(workspace, '.ai-team', 'tasks', missionId);
    expect(fs.readFileSync(path.join(missionDir, 'mission.md'), 'utf-8')).toContain('status: active');
    expect(fs.readFileSync(path.join(missionDir, 'events.md'), 'utf-8')).toContain('mission.started');
  });

  it('initializes a local Git repository before starting a code mission', async () => {
    const { app, group, workspace } = makeApp();
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Existing project\n', 'utf-8');
    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '初始化本地项目',
        objective: '在普通文件夹中启动代码协作',
        template: 'feature',
        acceptanceCriteria: ['自动建立本地 Git 基线'],
      });
    const missionId = draftResponse.body.mission.id as string;

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.mission.gitBaseline).toEqual(expect.objectContaining({
      repositoryRoot: fs.realpathSync(workspace),
      baseBranch: 'main',
      taskBranch: expect.stringMatching(/^octrix\//),
    }));
    expect(execFileSync('git', ['show', 'HEAD:README.md'], {
      cwd: workspace,
      encoding: 'utf-8',
    })).toBe('# Existing project\n');
    expect(execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: workspace,
      encoding: 'utf-8',
    })).toBe('');
  });

  it('requires the owner to record a valid missing-role decision before start', async () => {
    const { app, store, group } = makeApp();
    const testerLeaderId = group.roleLeaders['role-tester'];
    group.members = group.members.filter(member => member.id !== testerLeaderId);
    delete group.roleLeaders['role-tester'];

    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '缺少测试的登录任务',
        objective: '实现一次性验证码登录',
        template: 'feature',
        acceptanceCriteria: ['验证码正确时登录成功'],
      });
    const missionId = draftResponse.body.mission.id as string;

    const blocked = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();
    expect(blocked.status).toBe(409);
    expect(blocked.body.missingRoleIds).toContain('role-tester');

    const decision = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-tester`)
      .send({ resolution: 'waive', note: '群主接受无独立测试风险' });

    expect(decision.status).toBe(200);
    expect(decision.body.mission.missingRoleDecisions).toContainEqual(expect.objectContaining({
      roleId: 'role-tester',
      resolution: 'waive',
      note: '群主接受无独立测试风险',
    }));
    expect(
      decision.body.mission.phases.find((phase: any) => phase.roleId === 'role-tester').status,
    ).toBe('waived');
    expect(store.taskSessionById(missionId)?.revision).toBe(1);
  });

  it('waits for and imports an owner-provided implementation when the developer role is missing', async () => {
    const { app, group, workspace, pm } = makeApp();
    initializeGitWorkspace(workspace);
    const developerLeaderId = group.roleLeaders['role-developer'];
    group.members = group.members.filter(member => member.id !== developerLeaderId);
    delete group.roleLeaders['role-developer'];
    const draft = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '外部实现后审查',
        objective: '由群主在系统外完成登录修复，再交团队审查与测试',
        template: 'bugfix',
        acceptanceCriteria: ['外部实现被版本化后才能审查'],
      });
    const missionId = draft.body.mission.id as string;
    await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-developer`)
      .send({
        resolution: 'external_implementation',
        note: '群主负责在任务分支实现，完成后显式导入',
      });

    const started = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(started.status).toBe(200);
    expect(started.body.mission).toEqual(expect.objectContaining({
      status: 'waiting_human',
      interruptionReason: 'awaiting_external_implementation',
      currentRequirementsRevision: 1,
    }));
    expect(started.body.workItem).toEqual(expect.objectContaining({
      roleId: 'role-code-reviewer',
      status: 'waiting_human',
      resumeStatus: 'offered',
    }));
    expect(pm.sendKeys.mock.calls.some(call => String(call[1]).includes('[新工作项]'))).toBe(false);

    fs.writeFileSync(path.join(workspace, 'README.md'), '# Owner external implementation\n', 'utf-8');
    const imported = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/external-implementation`)
      .send({ note: '群主核对了登录修复的完整 diff，授权导入 R001' });

    expect(imported.status).toBe(201);
    expect(imported.body.revision).toEqual(expect.objectContaining({
      id: 'R001',
      changedFiles: ['README.md'],
    }));
    expect(imported.body.mission).toEqual(expect.objectContaining({
      status: 'active',
      currentImplementationRevisionId: 'R001',
    }));
    expect(imported.body.workItem).toEqual(expect.objectContaining({
      id: started.body.workItem.id,
      status: 'offered',
      requirementsRevision: 1,
      implementationRevisionId: 'R001',
      contextRevision: 1,
    }));
    expect(pm.sendKeys).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('群主已导入外部实现 R001'),
      group.id,
      missionId,
    );
  });

  it('starts directly at owner review when every AI phase was explicitly waived', async () => {
    const { app, group, workspace } = makeApp();
    initializeGitWorkspace(workspace);
    const reviewerLeaderId = group.roleLeaders['role-code-reviewer'];
    group.members = group.members.filter(member => member.id !== reviewerLeaderId);
    delete group.roleLeaders['role-code-reviewer'];
    const draft = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '群主豁免独立审查',
        objective: '记录本次独立审查豁免',
        template: 'review',
        acceptanceCriteria: ['豁免决定进入最终记录'],
      });
    const missionId = draft.body.mission.id as string;
    await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-code-reviewer`)
      .send({ resolution: 'waive', note: '群主明确接受没有独立审查的风险' });

    const started = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(started.status).toBe(200);
    expect(started.body.mission.status).toBe('ready_for_owner');
    expect(started.body.workItem).toBeUndefined();
    expect(started.body.collaborationWorkItems).toEqual([]);
    expect(fs.readFileSync(
      path.join(workspace, '.ai-team', 'tasks', missionId, 'events.md'),
      'utf-8',
    )).toContain('mission.all_phases_waived');
  });

  it('imports an external implementation and becomes owner-ready when no AI phase remains', async () => {
    const { app, group, workspace } = makeApp();
    initializeGitWorkspace(workspace);
    const developerLeaderId = group.roleLeaders['role-developer'];
    group.members = group.members.filter(member => member.id !== developerLeaderId);
    delete group.roleLeaders['role-developer'];
    const draft = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '群主独立完成通用实现',
        objective: '没有研发 AI 时由群主完成并导入实现',
        template: 'generic',
        acceptanceCriteria: ['外部实现形成不可变修订'],
      });
    const missionId = draft.body.mission.id as string;
    await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-developer`)
      .send({ resolution: 'external_implementation', note: '群主在任务分支独立实现' });
    const started = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();
    expect(started.status).toBe(200);
    expect(started.body.mission).toEqual(expect.objectContaining({
      status: 'waiting_human',
      interruptionReason: 'awaiting_external_implementation',
    }));
    expect(started.body.workItem).toBeUndefined();

    fs.writeFileSync(path.join(workspace, 'README.md'), '# Owner-only implementation\n', 'utf-8');
    const imported = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/external-implementation`)
      .send({ note: '群主已核对全部外部实现 diff' });

    expect(imported.status).toBe(201);
    expect(imported.body.revision.id).toBe('R001');
    expect(imported.body.mission.status).toBe('ready_for_owner');
    expect(imported.body.workItem).toBeUndefined();
  });

  it('pauses a product handoff at a missing external developer and offers review only after import', async () => {
    const { app, store, group, workspace } = makeApp();
    initializeGitWorkspace(workspace);
    const developerLeaderId = group.roleLeaders['role-developer'];
    group.members = group.members.filter(member => member.id !== developerLeaderId);
    delete group.roleLeaders['role-developer'];
    const draft = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '产品确认后外部实现',
        objective: '产品冻结需求，群主外部实现，再进入审查',
        template: 'feature',
        acceptanceCriteria: ['外部实现绑定最新产品需求'],
      });
    const missionId = draft.body.mission.id as string;
    await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-developer`)
      .send({ resolution: 'external_implementation', note: '产品交接后由群主外部实现' });
    const started = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();
    const productItem = store.taskCardById(started.body.workItem.id)!;
    const productAgentId = productItem.ownerAgentId;
    const control = (action: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${action}`,
        `requestId: ${requestId}`,
        `missionId: ${missionId}`,
        `workItemId: ${productItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgentId,
      control('work.accept', 'external-product-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgentId,
      control('work.started', 'external-product-start', 1),
    );
    const productDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      missionId,
      'work-items',
      productItem.id,
    );
    fs.writeFileSync(path.join(productDir, 'requirements.md'), '# 冻结产品需求\n', 'utf-8');
    fs.mkdirSync(path.join(productDir, 'handoffs'), { recursive: true });
    fs.writeFileSync(path.join(productDir, 'handoffs', 'to-dev.md'), '# 外部研发交接\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      productAgentId,
      control('work.submit', 'external-product-submit', 2, ['artifact: requirements.md']),
    );
    const handoff = store.applyCollaborationAction(
      group.id,
      productAgentId,
      control('handoff.request', 'external-product-handoff', 3, [
        'targetRole: 研发',
        'artifact: handoffs/to-dev.md',
      ]),
    );
    expect(handoff.createdWorkItem).toBeUndefined();
    expect(handoff.mission).toEqual(expect.objectContaining({
      status: 'waiting_human',
      interruptionReason: 'awaiting_external_implementation',
      currentRequirementsRevision: 2,
    }));

    fs.writeFileSync(path.join(workspace, 'README.md'), '# Product-approved external implementation\n', 'utf-8');
    const imported = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/external-implementation`)
      .send({ note: '群主按 requirements-v2 完成并核对外部实现' });

    expect(imported.status).toBe(201);
    expect(imported.body.workItem).toEqual(expect.objectContaining({
      roleId: 'role-code-reviewer',
      status: 'offered',
      requirementsRevision: 2,
      implementationRevisionId: 'R001',
      dependsOn: [productItem.id],
    }));
    expect(store.taskCardById(productItem.id)?.status).toBe('completed');
  });

  it('starts at the first staffed phase after the owner supplies a missing product brief', async () => {
    const { app, group, workspace } = makeApp();
    initializeGitWorkspace(workspace);
    const productLeaderId = group.roleLeaders['role-product-manager'];
    group.members = group.members.filter(member => member.id !== productLeaderId);
    delete group.roleLeaders['role-product-manager'];

    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '明确需求的修复',
        objective: '修复已经有验收标准的登录错误',
        template: 'feature',
        acceptanceCriteria: ['错误验证码不会登录'],
      });
    const missionId = draftResponse.body.mission.id as string;
    await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/missing-roles/role-product-manager`)
      .send({ resolution: 'owner_supplies', note: '群主提供以上需求和验收标准' });

    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.mission.currentPhaseId).toBe('phase-2-developer');
    expect(response.body.workItem.roleId).toBe('role-developer');
  });

  it('offers independent same-role work while the role Leader owns aggregation', async () => {
    const { app, store, group } = makeApp();
    const peerAgent: Agent = {
      id: 'agent-product-peer',
      platform: 'openai-codex-cli',
      name: '产品顾问',
      command: 'codex --yolo',
      avatarColor: 'purple',
    };
    store.addAgent(peerAgent);
    const peerMember = createGroupMember(peerAgent.id, 'role-product-manager');
    group.members.push(peerMember);

    const draftResponse = await request(app)
      .post(`/api/groups/${group.id}/missions`)
      .send({
        title: '讨论登录产品方案',
        objective: '形成一致的登录产品方案',
        template: 'discussion',
        acceptanceCriteria: ['输出方案和分歧记录'],
      });
    const missionId = draftResponse.body.mission.id as string;
    const response = await request(app)
      .post(`/api/groups/${group.id}/missions/${missionId}/start`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.workItem.ownerMemberId).toBe(group.roleLeaders['role-product-manager']);
    expect(response.body.collaborationWorkItems).toEqual([
      expect.objectContaining({
        kind: 'discussion',
        roleId: 'role-product-manager',
        ownerMemberId: peerMember.id,
        parentWorkItemId: response.body.workItem.id,
        status: 'offered',
      }),
    ]);
    expect(store.taskCards.filter(card => card.taskSessionId === missionId)).toHaveLength(2);
  });

  it('allows only one active collaboration mission per canonical Git repository', async () => {
    const {
      app, store, group, workspace,
    } = makeApp();
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Octrix Test'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'octrix@example.com'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Project\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: workspace });

    const firstDraft = await request(app).post(`/api/groups/${group.id}/missions`).send({
      title: '第一个代码任务',
      objective: '实现第一项功能',
      template: 'feature',
      acceptanceCriteria: ['第一项完成'],
    });
    const firstStart = await request(app)
      .post(`/api/groups/${group.id}/missions/${firstDraft.body.mission.id}/start`)
      .send();
    expect(firstStart.status).toBe(200);

    const secondWorkspace = path.join(workspace, 'packages', 'second');
    fs.mkdirSync(secondWorkspace, { recursive: true });
    const secondMembers = group.members.map(member => createGroupMember(member.agentId, member.roleId));
    const secondGroup = createAgentGroup(
      '同仓库第二群',
      '群主',
      secondMembers,
      secondWorkspace,
      'collaboration',
      Object.fromEntries(secondMembers.map(member => [member.roleId!, member.id])),
    );
    store.addGroup(secondGroup);
    const secondDraft = await request(app).post(`/api/groups/${secondGroup.id}/missions`).send({
      title: '第二个代码任务',
      objective: '实现第二项功能',
      template: 'feature',
      acceptanceCriteria: ['第二项完成'],
    });

    const secondStart = await request(app)
      .post(`/api/groups/${secondGroup.id}/missions/${secondDraft.body.mission.id}/start`)
      .send();

    expect(secondStart.status).toBe(409);
    expect(secondStart.body.error).toContain('同一 Git 仓库已有活跃协作任务');
    expect(secondStart.body.conflictingMissionId).toBe(firstDraft.body.mission.id);
  });
});
}
