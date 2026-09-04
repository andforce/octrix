import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentGroup,
  createGroupMember,
  type Agent,
  type TaskCard,
} from './models';
import {
  parseCollaborationControlBlocks,
  type CollaborationActionName,
} from './collaboration-protocol';
import { captureImplementationRevision, prepareMissionGitBranch } from './git';
import { Store } from './store';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bridge-store-'));
  tempDirs.push(dir);
  return dir;
}

describe('Store legacy agent cleanup', () => {
  it('removes unsupported legacy agents and their group members on load', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      workspaceDataVersion: Store.WORKSPACE_DATA_VERSION,
      collaborationSchemaVersion: Store.COLLABORATION_SCHEMA_VERSION,
      agents: [
        {
          id: 'legacy-1',
          name: 'Custom Claude',
          command: 'claude --unsafe',
          avatarColor: 'red',
        },
        {
          id: 'agent-2',
          platform: 'cursor-cli',
          name: 'Cursor CLI',
          command: 'cursor',
          avatarColor: 'blue',
        },
      ],
      groups: [
        {
          id: 'group-1',
          name: 'Test Group',
          ownerName: '群主',
          members: [
            { id: 'member-1', agentId: 'legacy-1', roleId: null },
            { id: 'member-2', agentId: 'agent-2', roleId: null },
          ],
          groupType: 'collaboration',
          compositionStatus: 'active',
          roleLeaders: {},
          createdAt: Date.now() / 1000,
        },
      ],
      taskCards: [],
    }), 'utf-8');

    const store = new Store(dir);

    expect(store.agents).toHaveLength(1);
    expect(store.agents[0].platform).toBe('cursor-cli');
    expect(store.groups[0].members).toEqual([
      { id: 'member-2', agentId: 'agent-2', roleId: null },
    ]);
  });

  it('normalizes managed agent commands to the current platform defaults on load', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      workspaceDataVersion: Store.WORKSPACE_DATA_VERSION,
      collaborationSchemaVersion: Store.COLLABORATION_SCHEMA_VERSION,
      agents: [
        {
          id: 'agent-1',
          platform: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          avatarColor: 'red',
        },
        {
          id: 'agent-2',
          platform: 'cursor-cli',
          name: 'Cursor CLI',
          command: 'agent',
          avatarColor: 'blue',
        },
      ],
      groups: [],
      taskCards: [],
    }), 'utf-8');

    const store = new Store(dir);

    expect(store.agents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        platform: 'claude-code',
        command: 'claude --permission-mode bypassPermissions',
      }),
      expect.objectContaining({
        id: 'agent-2',
        platform: 'cursor-cli',
        command: 'agent --yolo',
      }),
    ]);
  });
});

describe('workspace data v1 reset', () => {
  it('clears all development work data while preserving unrelated workspace files', () => {
    const dir = makeTempDir();
    const collaborationWorkspace = path.join(dir, 'collaboration-workspace');
    const directWorkspace = path.join(dir, 'direct-workspace');
    fs.mkdirSync(path.join(collaborationWorkspace, '.ai-team'), { recursive: true });
    fs.mkdirSync(directWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(collaborationWorkspace, '.ai-team', 'context.md'),
      '# AI 团队协作入口\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(collaborationWorkspace, 'README.md'), '# keep\n', 'utf-8');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      agents: [
        {
          id: 'agent-1',
          platform: 'claude-code',
          name: 'Claude Code',
          command: 'claude --permission-mode bypassPermissions',
          avatarColor: 'red',
        },
      ],
      groups: [
        {
          id: 'legacy-group',
          name: '旧协作群',
          ownerName: '群主',
          members: [{ id: 'member-1', agentId: 'agent-1', roleId: 'role-developer' }],
          workingDirectory: collaborationWorkspace,
          groupType: 'execution',
          activeTaskSessionId: 'legacy-task',
          createdAt: 1,
        },
        {
          id: 'direct-group',
          name: '保留的单聊',
          ownerName: '群主',
          members: [{ id: 'member-2', agentId: 'agent-1', roleId: null }],
          workingDirectory: directWorkspace,
          groupType: 'direct',
          activeTaskSessionId: 'direct-task',
          createdAt: 2,
        },
      ],
      taskCards: [
        {
          id: 'legacy-card',
          title: '旧卡片',
          description: '',
          groupId: 'legacy-group',
          creatorName: '群主',
          ownerAgentId: 'agent-1',
          collaboratorAgentIds: [],
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      taskSessions: [
        { id: 'legacy-task', groupId: 'legacy-group', title: '旧任务', status: 'active', createdAt: 1 },
        { id: 'direct-task', groupId: 'direct-group', title: '单聊', status: 'active', createdAt: 2 },
      ],
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'workflows.json'), JSON.stringify({
      workflows: [
        { id: 'workflow-1', name: '旧工作流', groupId: 'legacy-group', steps: [], createdAt: 1 },
      ],
      runs: [
        {
          id: 'run-1',
          workflowId: 'workflow-1',
          workflowName: '旧工作流',
          groupId: 'legacy-group',
          status: 'running',
          stepRuns: [],
          input: '',
          createdAt: 1,
        },
      ],
    }, null, 2), 'utf-8');

    const store = new Store(dir);

    expect(store.agents).toEqual([]);
    expect(store.groups).toEqual([]);
    expect(store.taskCards).toEqual([]);
    expect(store.taskSessions).toEqual([]);
    expect(store.workflows).toEqual([]);
    expect(store.workflowRuns).toEqual([]);
    expect(store.removedLegacyGroupIds).toEqual(['legacy-group', 'direct-group']);
    expect(store.didResetWorkData).toBe(true);
    expect(fs.existsSync(path.join(collaborationWorkspace, '.ai-team'))).toBe(false);
    expect(fs.readFileSync(path.join(collaborationWorkspace, 'README.md'), 'utf-8')).toBe('# keep\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).workspaceDataVersion)
      .toBe(Store.WORKSPACE_DATA_VERSION);
  });

  it('preserves a legacy direct chat that still uses memberIds', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      workspaceDataVersion: Store.WORKSPACE_DATA_VERSION,
      agents: [
        {
          id: 'agent-1',
          platform: 'claude-code',
          name: 'Claude Code',
          command: 'claude --permission-mode bypassPermissions',
          avatarColor: 'red',
        },
      ],
      groups: [
        {
          id: 'direct-group',
          name: '旧单聊',
          ownerName: '群主',
          memberIds: ['agent-1'],
          groupType: 'direct',
          createdAt: 2,
        },
      ],
      taskCards: [],
      taskSessions: [],
    }), 'utf-8');

    const store = new Store(dir);

    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]).toEqual(expect.objectContaining({
      id: 'direct-group',
      groupType: 'direct',
      compositionStatus: 'active',
      roleLeaders: {},
      members: [{ id: 'migrated-agent-1', agentId: 'agent-1', roleId: null }],
    }));
  });
});

describe('groupByResolvedWorkingDirectory', () => {
  it('matches trailing path separators and equivalent paths', () => {
    const dir = makeTempDir();
    const store = new Store(dir);
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws);
    const g = createAgentGroup('A', '群主', [], ws, 'execution');
    store.addGroup(g);
    expect(store.groupByResolvedWorkingDirectory(`${ws}${path.sep}`)?.id).toBe(g.id);
    expect(store.groupByResolvedWorkingDirectory(path.join(ws, '..', path.basename(ws)))?.id).toBe(g.id);
  });
});

describe('direct chat task session defaults', () => {
  it('creates an internal single-chat session title for direct groups', () => {
    const dir = makeTempDir();
    const store = new Store(dir);
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws);
    const group = createAgentGroup('Claude 单聊', '群主', [], ws, 'direct');

    store.addGroup(group);

    const session = store.activeTaskSessionForGroup(group.id);
    expect(session?.title).toBe('单聊');
  });
});

describe('collaboration team files', () => {
  it('records role Leaders and the structured protocol without temporary dual-role rules', () => {
    const dir = makeTempDir();
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace);
    const store = new Store(dir);
    const agents: Agent[] = [
      {
        id: 'agent-1',
        platform: 'claude-code',
        name: '研发 Leader',
        command: 'claude --permission-mode bypassPermissions',
        avatarColor: 'blue',
      },
      {
        id: 'agent-2',
        platform: 'openai-codex-cli',
        name: '研发顾问',
        command: 'codex --yolo',
        avatarColor: 'green',
      },
    ];
    agents.forEach(agent => store.addAgent(agent));
    const leader = createGroupMember('agent-1', 'role-developer');
    const adviser = createGroupMember('agent-2', 'role-developer');
    const group = createAgentGroup(
      '研发协作群',
      '群主',
      [leader, adviser],
      workspace,
      'collaboration',
      { 'role-developer': leader.id },
    );
    store.addGroup(group);

    store.writeTeamFiles(group);

    const members = fs.readFileSync(path.join(workspace, '.ai-team', 'members.md'), 'utf-8');
    const dispatch = fs.readFileSync(path.join(workspace, '.ai-team', 'dispatch.md'), 'utf-8');
    const leaderRole = fs.readFileSync(
      path.join(workspace, '.ai-team', 'roles', 'role-研发-研发 Leader.md'),
      'utf-8',
    );
    const adviserRole = fs.readFileSync(
      path.join(workspace, '.ai-team', 'roles', 'role-研发-研发顾问.md'),
      'utf-8',
    );

    expect(members).toContain('| 研发 Leader | 研发 | Leader |');
    expect(dispatch).toContain('```octrix-action');
    expect(dispatch).toContain('一个 AI 在本群只能承担一个基础角色，禁止兼职');
    expect(dispatch).not.toContain('/assign @');
    expect(leaderRole).toContain('你是本群研发角色的默认 Leader');
    expect(leaderRole).toContain('你是项目文件的唯一写入者');
    expect(adviserRole).toContain('你不是研发 Leader');
    expect(adviserRole).toContain('不得修改任何项目文件');
  });
});

describe('Markdown mission recovery', () => {
  it('rebuilds missing mission and work-item state from server-managed Markdown snapshots', () => {
    const storage = makeTempDir();
    const workspace = makeTempDir();
    const store = new Store(storage);
    const agents: Agent[] = [
      {
        id: 'recover-dev',
        platform: 'openai-codex-cli',
        name: '恢复研发',
        command: 'codex --yolo',
        avatarColor: 'green',
      },
      {
        id: 'recover-review',
        platform: 'claude-code',
        name: '恢复审查',
        command: 'claude --permission-mode bypassPermissions',
        avatarColor: 'blue',
      },
    ];
    agents.forEach(agent => store.addAgent(agent));
    const developer = createGroupMember(agents[0].id, 'role-developer');
    const reviewer = createGroupMember(agents[1].id, 'role-code-reviewer');
    const group = createAgentGroup(
      '恢复群',
      '群主',
      [developer, reviewer],
      workspace,
      'collaboration',
      {
        'role-developer': developer.id,
        'role-code-reviewer': reviewer.id,
      },
    );
    store.addGroup(group);
    const mission = store.createMission(group.id, {
      title: '恢复任务',
      objective: '验证 Markdown 恢复',
      template: 'generic',
      acceptanceCriteria: ['恢复后可由群主确认继续'],
    });
    const started = store.startMission(group.id, mission.id);

    const configPath = path.join(storage, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.taskSessions = [];
    config.taskCards = [];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const recovered = new Store(storage);

    expect(recovered.taskSessionById(mission.id)).toEqual(expect.objectContaining({
      id: mission.id,
      status: 'interrupted',
      interruptionReason: 'service_restarted',
    }));
    expect(recovered.taskCardById(started.workItem.id)).toEqual(expect.objectContaining({
      id: started.workItem.id,
      status: 'interrupted',
    }));
  });
});

{
// store.ts actions cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStoreWithStartedMission(
  template: 'discussion' | 'documentation' = 'discussion',
  withProductPeer = false,
) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-action-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-action-workspace-'));
  tempDirs.push(storageDir, workspace);
  const store = new Store(storageDir);
  const productAgent: Agent = {
    id: 'agent-product',
    platform: 'claude-code',
    name: '产品 AI',
    command: 'claude --permission-mode bypassPermissions',
    avatarColor: 'blue',
  };
  const developerAgent: Agent = {
    id: 'agent-developer',
    platform: 'openai-codex-cli',
    name: '研发 AI',
    command: 'codex --yolo',
    avatarColor: 'green',
  };
  store.addAgent(productAgent);
  store.addAgent(developerAgent);
  const productMember = createGroupMember(productAgent.id, 'role-product-manager');
  const developerMember = createGroupMember(developerAgent.id, 'role-developer');
  const peerAgent: Agent | undefined = withProductPeer ? {
    id: 'agent-product-peer',
    platform: 'gemini-cli',
    name: '产品顾问 AI',
    command: 'gemini --yolo',
    avatarColor: 'purple',
  } : undefined;
  if (peerAgent) store.addAgent(peerAgent);
  const peerMember = peerAgent
    ? createGroupMember(peerAgent.id, 'role-product-manager')
    : undefined;
  const group = createAgentGroup(
    '产品讨论群',
    '群主',
    [productMember, ...(peerMember ? [peerMember] : []), developerMember],
    workspace,
    'collaboration',
    {
      'role-product-manager': productMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '讨论登录方案',
    objective: '形成登录流程方案',
    template,
    acceptanceCriteria: ['输出明确方案'],
  });
  const started = store.startMission(group.id, mission.id);
  return {
    store,
    group,
    mission: started.mission,
    workItem: started.workItem,
    collaborationWorkItems: started.collaborationWorkItems,
    productAgent,
    developerAgent,
    peerAgent,
    workspace,
  };
}

describe('Store collaboration actions', () => {
  it('accepts an offered work item once and records the state transition', () => {
    const { store, group, mission, workItem, productAgent, workspace } = makeStoreWithStartedMission();
    const content = [
      '```octrix-action',
      'action: work.accept',
      'requestId: accept-001',
      `missionId: ${mission.id}`,
      `workItemId: ${workItem.id}`,
      'expectedRevision: 0',
      'contextRevision: 0',
      '```',
    ].join('\n');
    const action = parseCollaborationControlBlocks(content).actions[0];

    const result = store.applyCollaborationAction(group.id, productAgent.id, action);

    expect(result.duplicate).toBe(false);
    expect(result.workItem).toEqual(expect.objectContaining({
      id: workItem.id,
      status: 'accepted',
      revision: 1,
      contextRevision: 0,
    }));
    expect(result.mission.revision).toBe(2);
    expect(
      fs.readFileSync(
        path.join(workspace, '.ai-team', 'tasks', mission.id, 'events.md'),
        'utf-8',
      ),
    ).toContain('work.accept');
  });

  it('treats a repeated requestId as an idempotent duplicate', () => {
    const { store, group, mission, workItem, productAgent } = makeStoreWithStartedMission();
    const content = [
      '```octrix-action',
      'action: work.accept',
      'requestId: accept-repeat',
      `missionId: ${mission.id}`,
      `workItemId: ${workItem.id}`,
      'expectedRevision: 0',
      'contextRevision: 0',
      '```',
    ].join('\n');
    const action = parseCollaborationControlBlocks(content).actions[0];

    const first = store.applyCollaborationAction(group.id, productAgent.id, action);
    const repeated = store.applyCollaborationAction(group.id, productAgent.id, action);

    expect(first.duplicate).toBe(false);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.workItem.revision).toBe(1);
    expect(repeated.mission.revision).toBe(2);
  });

  it('moves an accepted work item into active work with work.started', () => {
    const { store, group, mission, workItem, productAgent } = makeStoreWithStartedMission();
    const accept = parseCollaborationControlBlocks([
      '```octrix-action',
      'action: work.accept',
      'requestId: accept-start',
      `missionId: ${mission.id}`,
      `workItemId: ${workItem.id}`,
      'expectedRevision: 0',
      'contextRevision: 0',
      '```',
    ].join('\n')).actions[0];
    store.applyCollaborationAction(group.id, productAgent.id, accept);
    const start = parseCollaborationControlBlocks([
      '```octrix-action',
      'action: work.started',
      'requestId: start-001',
      `missionId: ${mission.id}`,
      `workItemId: ${workItem.id}`,
      'expectedRevision: 1',
      '```',
    ].join('\n')).actions[0];

    const result = store.applyCollaborationAction(group.id, productAgent.id, start);

    expect(result.workItem.status).toBe('active');
    expect(result.workItem.revision).toBe(2);
    expect(result.workItem.startedAt).toEqual(expect.any(Number));
  });

  it('records meaningful progress without treating plain terminal output as state', () => {
    const { store, group, mission, workItem, productAgent } = makeStoreWithStartedMission();
    const action = (name: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${name}`,
        `requestId: ${requestId}`,
        `missionId: ${mission.id}`,
        `workItemId: ${workItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.accept', 'accept-progress', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.started', 'start-progress', 1),
    );

    const result = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.progress', 'progress-001', 2, ['summary: 已完成竞品分析，下一步整理验收标准']),
    );

    expect(result.workItem).toEqual(expect.objectContaining({
      status: 'active',
      revision: 3,
      progressSummary: '已完成竞品分析，下一步整理验收标准',
      lastProgressAt: expect.any(Number),
    }));
  });

  it('pauses for a structured owner-attention request and resumes the same owner afterward', () => {
    const { store, group, mission, workItem, productAgent, workspace } = makeStoreWithStartedMission();
    const action = (name: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${name}`,
        `requestId: ${requestId}`,
        `missionId: ${mission.id}`,
        `workItemId: ${workItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.accept', 'attention-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.started', 'attention-start', 1),
    );
    const itemDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', workItem.id);
    fs.writeFileSync(path.join(itemDir, 'risk.md'), '# 范围变化\n\n需要新增第三方账号体系。\n', 'utf-8');

    const paused = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('mission.owner_attention', 'attention-request', 2, [
        'reasonCode: scope_change',
        'summary: 需求已超出初始登录范围',
        'artifact: risk.md',
      ]),
    );

    expect(paused.mission).toEqual(expect.objectContaining({
      status: 'waiting_human',
      interruptionReason: 'owner_attention:scope_change',
    }));
    expect(paused.workItem).toEqual(expect.objectContaining({
      status: 'waiting_human',
      resumeStatus: 'active',
      ownerMemberId: workItem.ownerMemberId,
    }));

    const resumed = store.resumeMission(group.id, mission.id, '群主已确认范围并核对工作区');
    expect(resumed.status).toBe('active');
    expect(store.taskCardById(workItem.id)?.status).toBe('active');
  });

  it('submits an active work item only with an existing Markdown deliverable', () => {
    const { store, group, mission, workItem, productAgent, workspace } = makeStoreWithStartedMission();
    const control = (action: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${action}`,
        `requestId: ${requestId}`,
        `missionId: ${mission.id}`,
        `workItemId: ${workItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.accept', 'accept-submit', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.started', 'start-submit', 1),
    );
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'deliverable.md'), '# 登录方案\n', 'utf-8');

    const result = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.submit', 'submit-001', 2, ['artifact: deliverable.md']),
    );

    expect(result.workItem.status).toBe('submitted');
    expect(result.workItem.revision).toBe(3);
    expect(result.workItem.artifact).toBe('deliverable.md');
  });

  it('keeps responsibility with the source Leader until the next Leader accepts', () => {
    const {
      store, group, mission, workItem, productAgent, developerAgent, workspace,
    } = makeStoreWithStartedMission('documentation');
    const control = (action: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${action}`,
        `requestId: ${requestId}`,
        `missionId: ${mission.id}`,
        `workItemId: ${workItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.accept', 'accept-handoff', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.started', 'start-handoff', 1),
    );
    const sourceDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(sourceDir, 'deliverable.md'), '# 登录文档方案\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('work.submit', 'submit-handoff', 2, ['artifact: deliverable.md']),
    );
    fs.writeFileSync(
      path.join(sourceDir, 'handoffs', '001-product-to-dev.md'),
      '# 产品到研发交接\n\n请实现正式项目文档。\n',
      'utf-8',
    );

    const result = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      control('handoff.request', 'handoff-001', 3, [
        'targetRole: 研发',
        'artifact: handoffs/001-product-to-dev.md',
      ]),
    );

    expect(result.workItem.status).toBe('submitted');
    expect(result.createdWorkItem).toEqual(expect.objectContaining({
      roleId: 'role-developer',
      ownerMemberId: group.roleLeaders['role-developer'],
      status: 'offered',
      dependsOn: [workItem.id],
    }));
    expect(result.mission.currentPhaseId).toBe('phase-1-product-manager');
    expect(result.mission.phases?.map(phase => phase.status)).toEqual(['active', 'planned']);

    const target = result.createdWorkItem!;
    const accepted = store.applyCollaborationAction(
      group.id,
      developerAgent.id,
      parseCollaborationControlBlocks([
        '```octrix-action',
        'action: work.accept',
        'requestId: accept-handoff-target',
        `missionId: ${mission.id}`,
        `workItemId: ${target.id}`,
        'expectedRevision: 0',
        'contextRevision: 0',
        '```',
      ].join('\n')).actions[0],
    );

    expect(accepted.mission.currentPhaseId).toBe('phase-2-developer');
    expect(accepted.mission.phases?.map(phase => phase.status)).toEqual(['passed', 'active']);
    expect(store.taskCardById(workItem.id)?.status).toBe('completed');
  });

  it('requires two discussion rounds and lets the role Leader explicitly add one more', () => {
    const {
      store,
      group,
      mission,
      workItem,
      collaborationWorkItems,
      productAgent,
      peerAgent,
      workspace,
    } = makeStoreWithStartedMission('documentation', true);
    const action = (name: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      parseCollaborationControlBlocks([
        '```octrix-action',
        `action: ${name}`,
        `requestId: ${requestId}`,
        `missionId: ${mission.id}`,
        `workItemId: ${workItem.id}`,
        `expectedRevision: ${expectedRevision}`,
        ...extra,
        '```',
      ].join('\n')).actions[0]
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.accept', 'leader-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.started', 'leader-start', 1),
    );
    const leaderDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(leaderDir, 'deliverable.md'), '# Leader 汇总\n', 'utf-8');
    fs.writeFileSync(path.join(leaderDir, 'handoffs', 'to-dev.md'), '# 交接\n', 'utf-8');
    expect(collaborationWorkItems).toHaveLength(1);
    expect(() => store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.submit', 'leader-submit-too-early', 2, ['artifact: deliverable.md']),
    )).toThrow('必须完成独立提案和交叉评议');

    const peerItem = collaborationWorkItems[0];
    const peerAction = (
      item: typeof peerItem,
      name: string,
      requestId: string,
      expectedRevision: number,
      extra: string[] = [],
    ) => parseCollaborationControlBlocks([
      '```octrix-action',
      `action: ${name}`,
      `requestId: ${requestId}`,
      `missionId: ${mission.id}`,
      `workItemId: ${item.id}`,
      `expectedRevision: ${expectedRevision}`,
      ...extra,
      '```',
    ].join('\n')).actions[0];
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(peerItem, 'work.accept', 'peer-r1-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(peerItem, 'work.started', 'peer-r1-start', 1),
    );
    const peerDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      peerItem.id,
    );
    fs.writeFileSync(path.join(peerDir, 'proposal.md'), '# 独立提案\n', 'utf-8');
    const firstRound = store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(peerItem, 'work.submit', 'peer-r1-submit', 2, ['artifact: proposal.md']),
    );
    expect(firstRound.createdWorkItems).toEqual([
      expect.objectContaining({ discussionRound: 2, discussionStage: 'critique', status: 'offered' }),
    ]);

    const critique = firstRound.createdWorkItems![0];
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(critique, 'work.accept', 'peer-r2-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(critique, 'work.started', 'peer-r2-start', 1),
    );
    const critiqueDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      critique.id,
    );
    fs.writeFileSync(path.join(critiqueDir, 'critique.md'), '# 交叉评议\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(critique, 'work.submit', 'peer-r2-submit', 2, ['artifact: critique.md']),
    );

    const extended = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('discussion.extend', 'leader-extend-discussion', 2, [
        'summary: 聚焦验证码降级方案的安全边界',
      ]),
    );
    expect(extended.createdWorkItems).toEqual([
      expect.objectContaining({ discussionRound: 3, status: 'offered' }),
    ]);
    const thirdRound = extended.createdWorkItems![0];
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(thirdRound, 'work.accept', 'peer-r3-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(thirdRound, 'work.started', 'peer-r3-start', 1),
    );
    const thirdRoundDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      thirdRound.id,
    );
    fs.writeFileSync(path.join(thirdRoundDir, 'round-3.md'), '# 补充讨论\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      peerAgent!.id,
      peerAction(thirdRound, 'work.submit', 'peer-r3-submit', 2, ['artifact: round-3.md']),
    );

    const submitted = store.applyCollaborationAction(
      group.id,
      productAgent.id,
      action('work.submit', 'leader-submit-after-rounds', 3, ['artifact: deliverable.md']),
    );
    expect(submitted.workItem.status).toBe('submitted');
  });
});
}

{
// store.ts lifecycle cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setupActiveMission() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-lifecycle-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-lifecycle-workspace-'));
  tempDirs.push(storage, workspace);
  const store = new Store(storage);
  const product: Agent = {
    id: 'product', platform: 'claude-code', name: '产品 AI', command: 'claude', avatarColor: 'blue',
  };
  const developer: Agent = {
    id: 'developer', platform: 'openai-codex-cli', name: '研发 AI', command: 'codex', avatarColor: 'green',
  };
  store.addAgent(product);
  store.addAgent(developer);
  const productMember = createGroupMember(product.id, 'role-product-manager');
  const developerMember = createGroupMember(developer.id, 'role-developer');
  const group = createAgentGroup(
    '生命周期群',
    '群主',
    [productMember, developerMember],
    workspace,
    'collaboration',
    {
      'role-product-manager': productMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '讨论任务',
    objective: '产出方案',
    template: 'documentation',
    acceptanceCriteria: ['方案完整'],
  });
  const started = store.startMission(group.id, mission.id);
  const action = parseCollaborationControlBlocks([
    '```octrix-action',
    'action: work.accept',
    'requestId: accept-lifecycle',
    `missionId: ${mission.id}`,
    `workItemId: ${started.workItem.id}`,
    'expectedRevision: 0',
    'contextRevision: 0',
    '```',
  ].join('\n')).actions[0];
  store.applyCollaborationAction(group.id, product.id, action);
  const startAction = parseCollaborationControlBlocks([
    '```octrix-action',
    'action: work.started',
    'requestId: start-lifecycle',
    `missionId: ${mission.id}`,
    `workItemId: ${started.workItem.id}`,
    'expectedRevision: 1',
    '```',
  ].join('\n')).actions[0];
  store.applyCollaborationAction(group.id, product.id, startAction);
  return { storage, workspace, store, group, mission, workItem: started.workItem };
}

describe('Store mission owner lifecycle', () => {
  it('marks running work interrupted after a service restart and restores it only after owner resume', () => {
    const { storage, group, mission, workItem } = setupActiveMission();

    const restored = new Store(storage);
    expect(restored.taskSessionById(mission.id)).toEqual(expect.objectContaining({
      status: 'interrupted',
      interruptionReason: 'service_restarted',
      interruptedAt: expect.any(Number),
    }));
    expect(restored.taskCardById(workItem.id)).toEqual(expect.objectContaining({
      status: 'interrupted',
      interruptedFromStatus: 'active',
    }));

    const resumed = restored.resumeMission(group.id, mission.id, '确认工作区无外部变化，继续执行');
    expect(resumed.status).toBe('active');
    expect(restored.taskCardById(workItem.id)?.status).toBe('active');
    expect(resumed.ownerDecisionHistory?.at(-1)).toEqual(expect.objectContaining({ action: 'resume' }));
  });

  it('cancels collaboration without rolling back or deleting project files', () => {
    const { store, workspace, group, mission, workItem } = setupActiveMission();
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'unfinished work\n', 'utf-8');

    const cancelled = store.cancelMission(group.id, mission.id, '群主决定终止任务');

    expect(cancelled.status).toBe('cancelled');
    expect(store.taskCardById(workItem.id)?.status).toBe('cancelled');
    expect(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf-8')).toBe('unfinished work\n');
    expect(store.groupById(group.id)?.activeTaskSessionId).toBeUndefined();
  });

  it('pauses active work without losing its previous state and resumes only with an owner note', () => {
    const { store, group, mission, workItem } = setupActiveMission();

    const paused = store.pauseMission(group.id, mission.id, '群主需要先确认外部依赖');

    expect(paused.status).toBe('waiting_human');
    expect(paused.interruptionReason).toBe('owner_paused');
    expect(store.taskCardById(workItem.id)).toEqual(expect.objectContaining({
      status: 'waiting_human',
      resumeStatus: 'active',
    }));
    expect(() => store.resumeMission(group.id, mission.id, '')).toThrow('核对结果');

    const resumed = store.resumeMission(group.id, mission.id, '外部依赖已确认，可以继续');
    expect(resumed.status).toBe('active');
    expect(store.taskCardById(workItem.id)?.status).toBe('active');
    expect(resumed.ownerDecisionHistory?.map(item => item.action).slice(-2)).toEqual(['pause', 'resume']);
  });

  it('turns protocol failures into an explicit human checkpoint after two retries', () => {
    const { store, group, mission, workItem } = setupActiveMission();
    const memberId = workItem.ownerMemberId!;

    expect(store.recordProtocolFailure(group.id, mission.id, memberId, '缺少 expectedRevision')).toBe(1);
    expect(store.recordProtocolFailure(group.id, mission.id, memberId, '缺少 expectedRevision')).toBe(2);
    expect(store.taskSessionById(mission.id)?.status).toBe('active');
    expect(store.recordProtocolFailure(group.id, mission.id, memberId, '缺少 expectedRevision')).toBe(3);

    expect(store.taskSessionById(mission.id)).toEqual(expect.objectContaining({
      status: 'protocol_error',
      protocolErrorMemberId: memberId,
    }));
    expect(store.taskCardById(workItem.id)?.status).toBe('interrupted');

    const resumed = store.resumeMission(group.id, mission.id, '已修正控制块模板并核对上下文');
    expect(resumed.status).toBe('active');
    expect(resumed.protocolFailureCounts?.[memberId]).toBe(0);
  });

  it('creates a new developer-owned rework item when the owner requests changes after delivery', () => {
    const { store, group, mission, workItem } = setupActiveMission();
    const stored = store.taskSessionById(mission.id)!;
    stored.status = 'ready_for_owner';
    stored.phases?.forEach(phase => { phase.status = 'passed'; });
    workItem.status = 'completed';

    const result = store.requestMissionChanges(
      group.id,
      mission.id,
      '补充空状态说明并再次走完审查流程',
    );

    expect(result.mission.status).toBe('active');
    expect(result.mission.currentPhaseId).toBe('phase-2-developer');
    expect(result.workItem).toEqual(expect.objectContaining({
      roleId: 'role-developer',
      kind: 'rework',
      status: 'offered',
    }));
    expect(result.mission.ownerDecisionHistory?.at(-1)).toEqual(expect.objectContaining({
      action: 'request_changes',
    }));
  });

  it('reassigns a work item only to another member of the same role and keeps both assignments', () => {
    const { store, group, mission, workItem } = setupActiveMission();
    const peer: Agent = {
      id: 'product-peer', platform: 'claude-code', name: '产品 AI 二号', command: 'claude', avatarColor: 'purple',
    };
    store.addAgent(peer);
    const peerMember = createGroupMember(peer.id, 'role-product-manager');
    store.addMember(peerMember, group.id);

    const result = store.reassignMissionWorkItem(
      group.id,
      mission.id,
      workItem.id,
      peerMember.id,
      '原负责人失联，由同角色成员接替',
    );

    expect(store.taskCardById(workItem.id)).toEqual(expect.objectContaining({
      status: 'cancelled',
      reassignedToWorkItemId: result.workItem?.id,
    }));
    expect(result.workItem).toEqual(expect.objectContaining({
      status: 'offered',
      ownerMemberId: peerMember.id,
      roleId: 'role-product-manager',
      reassignedFromWorkItemId: workItem.id,
    }));
    expect(result.mission.leaderSnapshot?.['role-product-manager']).toBe(peerMember.id);
  });

  it('records an explicit owner risk acceptance without deleting the original issue', () => {
    const { store, group, mission, workItem } = setupActiveMission();
    store.issues.push({
      id: 'RISK-1',
      missionId: mission.id,
      groupId: group.id,
      workItemId: workItem.id,
      reporterMemberId: workItem.ownerMemberId!,
      roleId: 'role-product-manager',
      title: '外部接口仍有波动',
      summary: '供应方偶发超时',
      severity: 'major',
      status: 'open',
      evidenceArtifact: 'evidence.md',
      reopenCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.taskSessionById(mission.id)!.status = 'ready_for_owner';

    const result = store.acceptMissionRisk(
      group.id,
      mission.id,
      ['RISK-1'],
      '群主接受供应方短期波动，后续单独追踪',
    );

    expect(store.issues.find(issue => issue.id === 'RISK-1')).toEqual(expect.objectContaining({
      status: 'accepted_risk',
      resolution: '群主接受供应方短期波动，后续单独追踪',
    }));
    expect(result.mission.status).toBe('ready_for_owner');
    expect(result.mission.ownerDecisionHistory?.at(-1)?.action).toBe('accept_risk');
  });

  it('uses the mission quality policy when deciding whether accepted risks unblock the next phase', () => {
    const { store, group, mission, workItem } = setupActiveMission();
    const reviewer: Agent = {
      id: 'reviewer', platform: 'claude-code', name: '审查 AI', command: 'claude', avatarColor: 'orange',
    };
    store.addAgent(reviewer);
    const reviewerMember = createGroupMember(reviewer.id, 'role-code-reviewer');
    store.addMember(reviewerMember, group.id);
    const developerMemberId = group.roleLeaders['role-developer'];
    mission.phases = [
      {
        id: 'phase-review', name: '代码审查', roleId: 'role-code-reviewer',
        leaderMemberId: reviewerMember.id, status: 'blocked', required: true, order: 1,
      },
      {
        id: 'phase-developer', name: '研发', roleId: 'role-developer',
        leaderMemberId: developerMemberId, status: 'planned', required: true, order: 2,
      },
    ];
    mission.leaderSnapshot = {
      'role-code-reviewer': reviewerMember.id,
      'role-developer': developerMemberId,
    };
    mission.qualityPolicy = {
      blockingSeverities: ['blocker', 'minor'],
      sharedStateTestExecution: 'serial',
    };
    mission.status = 'waiting_human';
    workItem.roleId = 'role-code-reviewer';
    workItem.phaseId = 'phase-review';
    workItem.ownerAgentId = reviewer.id;
    workItem.ownerMemberId = reviewerMember.id;
    workItem.status = 'changes_requested';
    for (const [id, severity] of [['MAJOR-1', 'major'], ['MINOR-1', 'minor']] as const) {
      store.issues.push({
        id,
        missionId: mission.id,
        groupId: group.id,
        workItemId: workItem.id,
        reporterMemberId: reviewerMember.id,
        roleId: 'role-code-reviewer',
        title: `${severity} issue`,
        summary: '等待群主决策',
        severity,
        status: 'open',
        evidenceArtifact: 'evidence.md',
        reopenCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const majorAccepted = store.acceptMissionRisk(
      group.id,
      mission.id,
      ['MAJOR-1'],
      'major 不在本任务阻断集合内，先接受',
    );
    expect(majorAccepted.mission.status).toBe('waiting_human');
    expect(majorAccepted.workItem).toBeUndefined();
    expect(workItem.status).toBe('changes_requested');

    const minorAccepted = store.acceptMissionRisk(
      group.id,
      mission.id,
      ['MINOR-1'],
      '群主明确接受剩余 minor 风险',
    );
    expect(minorAccepted.mission.status).toBe('active');
    expect(workItem.status).toBe('completed');
    expect(minorAccepted.workItem).toEqual(expect.objectContaining({
      roleId: 'role-developer',
      status: 'offered',
    }));
  });

  it('completes only a ready-for-owner mission with an immutable owner note', () => {
    const { store, group, mission } = setupActiveMission();
    expect(() => store.completeMission(group.id, mission.id, '接受交付')).toThrow('只有等待群主处理的任务可以完成');
    const stored = store.taskSessionById(mission.id)!;
    stored.status = 'ready_for_owner';

    const completed = store.completeMission(group.id, mission.id, '已检查交付物并接受');

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toEqual(expect.any(Number));
    expect(completed.ownerDecisionHistory?.at(-1)).toEqual(expect.objectContaining({
      action: 'complete',
      note: '已检查交付物并接受',
    }));
  });

  it('deletes all local collaboration records and the generated team directory with the group', () => {
    const { store, workspace, group, mission } = setupActiveMission();
    expect(fs.existsSync(path.join(workspace, '.ai-team'))).toBe(true);

    store.removeGroup(group.id);

    expect(store.groupById(group.id)).toBeUndefined();
    expect(store.taskSessionsForGroup(group.id)).toEqual([]);
    expect(store.taskCards.some(item => item.groupId === group.id)).toBe(false);
    expect(store.issues.some(issue => issue.groupId === group.id)).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.ai-team'))).toBe(false);
    expect(store.taskSessionById(mission.id)).toBeUndefined();
  });
});
}

{
// store.ts membership cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-members-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-members-workspace-'));
  tempDirs.push(storage, workspace);
  const store = new Store(storage);
  const addAgent = (id: string, name: string): Agent => {
    const agent: Agent = {
      id, platform: 'claude-code', name, command: 'claude', avatarColor: 'blue',
    };
    store.addAgent(agent);
    return agent;
  };
  const first = addAgent('dev-1', '研发一号');
  const firstMember = createGroupMember(first.id, 'role-developer');
  const group = createAgentGroup(
    '成员管理群',
    '群主',
    [firstMember],
    workspace,
    'collaboration',
    { 'role-developer': firstMember.id },
  );
  store.addGroup(group);
  return { store, workspace, group, first, firstMember, addAgent };
}

describe('Store collaboration membership invariants', () => {
  it('activates group composition at two members and keeps one base role per AI', () => {
    const { store, group, first, addAgent } = setup();
    expect(group.compositionStatus).toBe('composition_insufficient');
    const reviewer = addAgent('review-1', '审查一号');
    const reviewerMember = createGroupMember(reviewer.id, 'role-code-reviewer');

    store.addMember(reviewerMember, group.id);

    expect(group.compositionStatus).toBe('active');
    expect(group.roleLeaders['role-code-reviewer']).toBe(reviewerMember.id);
    expect(() => store.addMember(createGroupMember(first.id, 'role-tester'), group.id)).toThrow(
      '一个 AI 在同一群内只能拥有一个角色',
    );
  });

  it('allows only one committer', () => {
    const { store, group, addAgent } = setup();
    const firstCommitter = addAgent('commit-1', '提交一号');
    const secondCommitter = addAgent('commit-2', '提交二号');
    store.addMember(createGroupMember(firstCommitter.id, 'role-committer'), group.id);

    expect(() => store.addMember(
      createGroupMember(secondCommitter.id, 'role-committer'),
      group.id,
    )).toThrow('每个群最多只能有一个提交专员');
  });

  it('requires an explicit successor before removing a Leader with multiple peers', () => {
    const {
      store, group, firstMember, addAgent,
    } = setup();
    const second = createGroupMember(addAgent('dev-2', '研发二号').id, 'role-developer');
    const third = createGroupMember(addAgent('dev-3', '研发三号').id, 'role-developer');
    store.addMember(second, group.id);
    store.addMember(third, group.id);

    expect(() => store.removeMember(firstMember, group.id)).toThrow('必须指定继任 Leader');
    store.removeMember(firstMember, group.id, third.id);
    expect(group.roleLeaders['role-developer']).toBe(third.id);
  });

  it('pauses an active mission when a required member is removed without silently changing its Leader snapshot', () => {
    const {
      store, group, firstMember, addAgent,
    } = setup();
    const reviewer = createGroupMember(addAgent('review-1', '审查一号').id, 'role-code-reviewer');
    store.addMember(reviewer, group.id);
    const mission = store.createMission(group.id, {
      title: '通用研发任务',
      objective: '完成实现',
      template: 'generic',
      acceptanceCriteria: ['实现完成'],
    });
    store.startMission(group.id, mission.id);

    store.removeMember(firstMember, group.id);

    expect(mission.status).toBe('waiting_human');
    expect(mission.interruptionReason).toBe(`required_member_removed:${firstMember.id}`);
    expect(mission.leaderSnapshot?.['role-developer']).toBe(firstMember.id);
    expect(store.taskCards.find(item => item.taskSessionId === mission.id)?.status).toBe('interrupted');
  });

  it('pauses rather than silently reassigning when a required member goes offline', () => {
    const { store, group, firstMember, addAgent } = setup();
    store.addMember(createGroupMember(addAgent('review-1', '审查一号').id, 'role-code-reviewer'), group.id);
    const mission = store.createMission(group.id, {
      title: '离线处理任务',
      objective: '验证离线暂停',
      template: 'generic',
      acceptanceCriteria: ['不自动改派'],
    });
    store.startMission(group.id, mission.id);

    store.markRequiredMemberOffline(group.id, firstMember.id);

    expect(mission.status).toBe('waiting_human');
    expect(mission.interruptionReason).toBe(`required_member_offline:${firstMember.id}`);
    expect(store.taskCards.find(item => item.taskSessionId === mission.id)?.status).toBe('interrupted');
  });

  it('does not block when an observer without a planned work item goes offline', () => {
    const { store, group, addAgent } = setup();
    const observer = createGroupMember(addAgent('review-observer', '旁听审查').id, 'role-code-reviewer');
    store.addMember(observer, group.id);
    const mission = store.createMission(group.id, {
      title: '研发单阶段任务',
      objective: '旁听成员不参与计划',
      template: 'generic',
      acceptanceCriteria: ['旁听离线不阻塞'],
    });
    store.startMission(group.id, mission.id);

    store.markRequiredMemberOffline(group.id, observer.id);

    expect(mission.requiredMemberIds).not.toContain(observer.id);
    expect(mission.status).toBe('active');
    expect(mission.interruptionReason).toBeUndefined();
  });

  it('allows the owner to override a role Leader only while the mission is a draft', () => {
    const {
      store, group, firstMember, addAgent,
    } = setup();
    const second = createGroupMember(addAgent('dev-2', '研发二号').id, 'role-developer');
    store.addMember(second, group.id);
    const mission = store.createMission(group.id, {
      title: '改派任务 Leader',
      objective: '验证 Leader 快照',
      template: 'generic',
      acceptanceCriteria: ['由指定 Leader 承担'],
    });
    expect(mission.initialOwnerMemberId).toBe(firstMember.id);

    store.setMissionRoleLeader(group.id, mission.id, 'role-developer', second.id);
    expect(mission.leaderSnapshot?.['role-developer']).toBe(second.id);
    expect(mission.initialOwnerMemberId).toBe(second.id);
    store.startMission(group.id, mission.id);
    expect(() => store.setMissionRoleLeader(
      group.id,
      mission.id,
      'role-developer',
      firstMember.id,
    )).toThrow('只有草稿任务可以覆盖任务 Leader');
  });
});
}

{
// store.ts quality cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeReviewMission() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-quality-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-quality-workspace-'));
  tempDirs.push(storageDir, workspace);
  const store = new Store(storageDir);
  const reviewer: Agent = {
    id: 'agent-reviewer',
    platform: 'claude-code',
    name: '代码审查 AI',
    command: 'claude --permission-mode bypassPermissions',
    avatarColor: 'blue',
  };
  const developer: Agent = {
    id: 'agent-developer',
    platform: 'openai-codex-cli',
    name: '研发 AI',
    command: 'codex --yolo',
    avatarColor: 'green',
  };
  store.addAgent(reviewer);
  store.addAgent(developer);
  const reviewerMember = createGroupMember(reviewer.id, 'role-code-reviewer');
  const developerMember = createGroupMember(developer.id, 'role-developer');
  const group = createAgentGroup(
    '审查群',
    '群主',
    [reviewerMember, developerMember],
    workspace,
    'collaboration',
    {
      'role-code-reviewer': reviewerMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '审查登录改动',
    objective: '确认登录实现没有阻断问题',
    template: 'review',
    acceptanceCriteria: ['不存在鉴权绕过'],
  });
  mission.currentRequirementsRevision = 1;
  mission.requirementsRevisions = [{
    version: 1,
    artifact: 'requirements/requirements-v1.md',
    contentHash: 'requirements-hash',
    createdAt: 1,
  }];
  mission.currentImplementationRevisionId = 'R001';
  mission.implementationRevisions = [{
    id: 'R001',
    baseCommit: 'base',
    branch: 'task',
    contentHash: 'implementation-hash',
    changedFiles: ['src/login.ts'],
    patchArtifact: 'R001.patch',
    manifestArtifact: 'R001.md',
    createdAt: 1,
  }];
  const started = store.startMission(group.id, mission.id);
  const action = (
    name: string,
    requestId: string,
    expectedRevision: number,
    extra: string[] = [],
  ) => parseCollaborationControlBlocks([
    '```octrix-action',
    `action: ${name}`,
    `requestId: ${requestId}`,
    `missionId: ${mission.id}`,
    `workItemId: ${started.workItem.id}`,
    `expectedRevision: ${expectedRevision}`,
    ...extra,
    '```',
  ].join('\n')).actions[0];
  store.applyCollaborationAction(
    group.id,
    reviewer.id,
    action('work.accept', 'accept-review', 0, ['contextRevision: 0']),
  );
  store.applyCollaborationAction(
    group.id,
    reviewer.id,
    action('work.started', 'start-review', 1),
  );
  return { store, workspace, group, mission, workItem: started.workItem, reviewer, action };
}

function completeReviewReport(title = '代码审查报告') {
  return [
    `# ${title}`,
    '## 审查范围\n- 文件：src/login.ts\n- Diff：当前实现修订',
    '## 需求符合性\n符合',
    '## 逻辑正确性\n通过',
    '## 回归风险\n已覆盖',
    '## 错误处理\n符合预期',
    '## 安全性\n未发现新增风险',
    '## 可维护性\n结构清晰',
    '## 测试充分性\n已有对应测试',
  ].join('\n');
}

describe('Store quality findings', () => {
  it('requires a quality conclusion to bind both current requirements and implementation revisions', () => {
    const { store, workspace, group, mission, workItem, reviewer, action } = makeReviewMission();
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'review.md'), completeReviewReport(), 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('work.submit', 'unbound-submit', 2, ['artifact: review.md']),
    );
    delete workItem.requirementsRevision;

    expect(() => store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('stage.pass', 'unbound-pass', 3, ['artifact: review.md']),
    )).toThrow('绑定当前冻结需求版本');

    workItem.requirementsRevision = mission.currentRequirementsRevision;
    delete workItem.implementationRevisionId;
    expect(() => store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('stage.pass', 'unbound-pass-2', 3, ['artifact: review.md']),
    )).toThrow('绑定当前批准实现修订');
  });

  it('uses the mission quality policy to decide whether an ordinary issue blocks', () => {
    const { store, workspace, group, mission, workItem, reviewer, action } = makeReviewMission();
    mission.qualityPolicy = {
      blockingSeverities: ['blocker', 'major', 'minor'],
      sharedStateTestExecution: 'serial',
    };
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'minor.md'), '# 可维护性问题\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('issue.report', 'minor-policy', 2, [
        'issueId: MINOR-1',
        'severity: minor',
        'title: 重复的错误映射',
        'summary: 当前任务策略要求 minor 也阻断',
        'artifact: minor.md',
      ]),
    );
    fs.writeFileSync(path.join(workItemDir, 'review.md'), completeReviewReport(), 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('work.submit', 'minor-submit', 3, ['artifact: review.md']),
    );

    expect(() => store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('stage.pass', 'minor-pass', 4, ['artifact: review.md']),
    )).toThrow('MINOR-1');
  });

  it('records a blocker with stable identity, severity and Markdown evidence', () => {
    const { store, workspace, group, mission, workItem, reviewer, action } = makeReviewMission();
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'evidence.md'), '# 鉴权绕过复现\n', 'utf-8');

    const result = store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('issue.report', 'report-issue-1', 2, [
        'issueId: AUTH-001',
        'severity: blocker',
        'title: 错误验证码可以绕过鉴权',
        'summary: 使用错误验证码仍会创建登录会话',
        'artifact: evidence.md',
      ]),
    );

    expect(result.issue).toEqual(expect.objectContaining({
      id: 'AUTH-001',
      severity: 'blocker',
      status: 'open',
      reporterMemberId: group.roleLeaders['role-code-reviewer'],
      evidenceArtifact: 'evidence.md',
    }));
    expect(store.issues).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(workspace, '.ai-team', 'tasks', mission.id, 'issues', 'AUTH-001', 'v001.md'),
        'utf-8',
      ),
    ).toContain('severity: blocker');
  });

  it('does not let a quality Leader pass a stage with an open blocker', () => {
    const { store, workspace, group, mission, workItem, reviewer, action } = makeReviewMission();
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'evidence.md'), '# 阻断问题\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('issue.report', 'report-blocker', 2, [
        'issueId: AUTH-002',
        'severity: blocker',
        'title: 登录鉴权绕过',
        'summary: 错误验证码仍然登录',
        'artifact: evidence.md',
      ]),
    );
    fs.writeFileSync(path.join(workItemDir, 'review.md'), completeReviewReport(), 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('work.submit', 'submit-review', 3, ['artifact: review.md']),
    );

    expect(() => store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('stage.pass', 'pass-review', 4, ['artifact: review.md']),
    )).toThrow('存在未关闭的阻断问题：AUTH-002');
  });

  it('allows the quality Leader to pass after evidence-backed issue resolution', () => {
    const { store, workspace, group, mission, workItem, reviewer, action } = makeReviewMission();
    const workItemDir = path.join(
      workspace,
      '.ai-team',
      'tasks',
      mission.id,
      'work-items',
      workItem.id,
    );
    fs.writeFileSync(path.join(workItemDir, 'evidence.md'), '# 修复验证\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('issue.report', 'report-resolved', 2, [
        'issueId: AUTH-003',
        'severity: blocker',
        'title: 登录鉴权绕过',
        'summary: 错误验证码仍然登录',
        'artifact: evidence.md',
      ]),
    );

    const resolved = store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('issue.resolve', 'resolve-issue', 3, [
        'issueId: AUTH-003',
        'summary: 已验证错误验证码不再创建会话',
        'artifact: evidence.md',
      ]),
    );
    expect(resolved.issue?.status).toBe('resolved');

    fs.writeFileSync(
      path.join(workItemDir, 'review.md'),
      completeReviewReport('审查通过报告'),
      'utf-8',
    );
    store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('work.submit', 'submit-resolved-review', 4, ['artifact: review.md']),
    );
    const passed = store.applyCollaborationAction(
      group.id,
      reviewer.id,
      action('stage.pass', 'pass-resolved-review', 5, ['artifact: review.md']),
    );

    expect(passed.mission.status).toBe('ready_for_owner');
    expect(passed.workItem.status).toBe('completed');
  });
});
}

{
// store.ts rework cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function control(
  action: string,
  requestId: string,
  missionId: string,
  workItem: TaskCard,
  expectedRevision: number,
  extra: string[] = [],
) {
  return parseCollaborationControlBlocks([
    '```octrix-action',
    `action: ${action}`,
    `requestId: ${requestId}`,
    `missionId: ${missionId}`,
    `workItemId: ${workItem.id}`,
    `expectedRevision: ${expectedRevision}`,
    ...extra,
    '```',
  ].join('\n')).actions[0];
}

describe('Store quality rework loop', () => {
  it('returns an open blocker to the sole technical Leader as a rework item', () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-rework-store-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-rework-workspace-'));
    tempDirs.push(storageDir, workspace);
    const store = new Store(storageDir);
    const roleAgents: Array<[string, string, string]> = [
      ['agent-dev', '研发 AI', 'role-developer'],
      ['agent-review', '审查 AI', 'role-code-reviewer'],
      ['agent-test', '测试 AI', 'role-tester'],
      ['agent-commit', '提交 AI', 'role-committer'],
    ];
    const members = roleAgents.map(([id, name, roleId]) => {
      const agent: Agent = {
        id,
        platform: 'claude-code',
        name,
        command: 'claude --permission-mode bypassPermissions',
        avatarColor: 'blue',
      };
      store.addAgent(agent);
      return createGroupMember(id, roleId);
    });
    const roleLeaders = Object.fromEntries(members.map(member => [member.roleId!, member.id]));
    const group = createAgentGroup(
      '修复群',
      '群主',
      members,
      workspace,
      'collaboration',
      roleLeaders,
    );
    store.addGroup(group);
    const mission = store.createMission(group.id, {
      title: '修复登录鉴权',
      objective: '阻止错误验证码登录',
      template: 'bugfix',
      acceptanceCriteria: ['错误验证码不会创建会话'],
    });
    const developer = roleAgents[0][0];
    const reviewer = roleAgents[1][0];
    const started = store.startMission(group.id, mission.id);
    const devItem = started.workItem;
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.accept', 'dev-accept', mission.id, devItem, 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.started', 'dev-start', mission.id, devItem, 1),
    );
    const devDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', devItem.id);
    fs.writeFileSync(path.join(devDir, 'deliverable.md'), '# 实现修订 R001\n', 'utf-8');
    fs.writeFileSync(path.join(devDir, 'handoffs', 'to-review.md'), '# 研发到审查\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.submit', 'dev-submit', mission.id, devItem, 2, ['artifact: deliverable.md']),
    );
    const handoff = store.applyCollaborationAction(
      group.id,
      developer,
      control('handoff.request', 'dev-handoff', mission.id, devItem, 3, [
        'targetRole: 代码审查',
        'artifact: handoffs/to-review.md',
      ]),
    );
    const reviewItem = handoff.createdWorkItem!;
    store.applyCollaborationAction(
      group.id,
      reviewer,
      control('work.accept', 'review-accept', mission.id, reviewItem, 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      reviewer,
      control('work.started', 'review-start', mission.id, reviewItem, 1),
    );
    const reviewDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', reviewItem.id);
    fs.writeFileSync(path.join(reviewDir, 'evidence.md'), '# 鉴权绕过证据\n', 'utf-8');
    fs.writeFileSync(path.join(reviewDir, 'review.md'), '# 审查未通过\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      reviewer,
      control('issue.report', 'review-issue', mission.id, reviewItem, 2, [
        'issueId: AUTH-101',
        'severity: blocker',
        'title: 错误验证码仍可登录',
        'summary: 验证码校验结果没有阻止会话创建',
        'artifact: evidence.md',
      ]),
    );
    store.applyCollaborationAction(
      group.id,
      reviewer,
      control('work.submit', 'review-submit', mission.id, reviewItem, 3, ['artifact: review.md']),
    );

    const returned = store.applyCollaborationAction(
      group.id,
      reviewer,
      control('defect.return', 'review-return', mission.id, reviewItem, 4, [
        'targetRole: 研发',
        'issueId: AUTH-101',
        'artifact: review.md',
      ]),
    );

    expect(returned.workItem.status).toBe('changes_requested');
    expect(returned.createdWorkItem).toEqual(expect.objectContaining({
      kind: 'rework',
      roleId: 'role-developer',
      ownerMemberId: roleLeaders['role-developer'],
      returnIssueId: 'AUTH-101',
      parentWorkItemId: reviewItem.id,
      status: 'offered',
    }));
    expect(returned.mission.currentPhaseId).toBe('phase-1-developer');
    expect(returned.mission.reworkRound).toBe(1);

    const reworkItem = returned.createdWorkItem!;
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.accept', 'rework-accept', mission.id, reworkItem, 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.started', 'rework-start', mission.id, reworkItem, 1),
    );
    const reworkDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', reworkItem.id);
    fs.writeFileSync(path.join(reworkDir, 'deliverable.md'), '# 实现修订 R002\n', 'utf-8');
    fs.writeFileSync(path.join(reworkDir, 'handoffs', 'back-to-review.md'), '# 返工到复审\n', 'utf-8');
    store.applyCollaborationAction(
      group.id,
      developer,
      control('work.submit', 'rework-submit', mission.id, reworkItem, 2, ['artifact: deliverable.md']),
    );
    const backToReview = store.applyCollaborationAction(
      group.id,
      developer,
      control('handoff.request', 'rework-handoff', mission.id, reworkItem, 3, [
        'targetRole: 代码审查',
        'artifact: handoffs/back-to-review.md',
      ]),
    );

    expect(backToReview.createdWorkItem).toEqual(expect.objectContaining({
      roleId: 'role-code-reviewer',
      ownerMemberId: roleLeaders['role-code-reviewer'],
      status: 'offered',
      dependsOn: [reworkItem.id],
    }));
    expect(backToReview.mission.currentPhaseId).toBe('phase-1-developer');
    expect(
      backToReview.mission.phases?.find(phase => phase.id === 'phase-2-code-reviewer')?.status,
    ).toBe('blocked');

    const reviewAccepted = store.applyCollaborationAction(
      group.id,
      reviewer,
      control('work.accept', 're-review-accept', mission.id, backToReview.createdWorkItem!, 0, [
        'contextRevision: 0',
      ]),
    );
    expect(reviewAccepted.mission.currentPhaseId).toBe('phase-2-code-reviewer');
    expect(
      reviewAccepted.mission.phases?.find(phase => phase.id === 'phase-2-code-reviewer')?.status,
    ).toBe('active');
  });
});
}

{
// store.ts routing cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(template: 'documentation' | 'discussion' = 'documentation') {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-routing-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-routing-workspace-'));
  tempDirs.push(storage, workspace);
  const store = new Store(storage);
  const product: Agent = {
    id: 'product-agent', platform: 'claude-code', name: '产品 AI', command: 'claude', avatarColor: 'blue',
  };
  const developer: Agent = {
    id: 'developer-agent', platform: 'openai-codex-cli', name: '研发 AI', command: 'codex', avatarColor: 'green',
  };
  store.addAgent(product);
  store.addAgent(developer);
  const productMember = createGroupMember(product.id, 'role-product-manager');
  const developerMember = createGroupMember(developer.id, 'role-developer');
  const group = createAgentGroup(
    '协作路由群',
    '群主',
    [productMember, developerMember],
    workspace,
    'collaboration',
    {
      'role-product-manager': productMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '编写协作文档',
    objective: '完成需求和正式文档',
    template,
    acceptanceCriteria: ['产物完整'],
  });
  const started = store.startMission(group.id, mission.id);

  const control = (
    action: CollaborationActionName,
    requestId: string,
    item: TaskCard,
    expectedRevision: number,
    extra: string[] = [],
  ) => parseCollaborationControlBlocks([
    '```octrix-action',
    `action: ${action}`,
    `requestId: ${requestId}`,
    `missionId: ${mission.id}`,
    `workItemId: ${item.id}`,
    `expectedRevision: ${expectedRevision}`,
    ...extra,
    '```',
  ].join('\n')).actions[0];

  return { store, workspace, group, mission, started, product, developer, control };
}

function createHandoff() {
  const state = setup('documentation');
  const {
    store, workspace, group, mission, started, product, control,
  } = state;
  const source = started.workItem;
  store.applyCollaborationAction(group.id, product.id, control('work.accept', 'accept-source', source, 0, ['contextRevision: 0']));
  store.applyCollaborationAction(group.id, product.id, control('work.started', 'start-source', source, 1));
  const dir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', source.id);
  fs.writeFileSync(path.join(dir, 'deliverable.md'), '# 需求方案\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'handoffs', 'to-dev.md'), '# 研发交接\n', 'utf-8');
  store.applyCollaborationAction(group.id, product.id, control('work.submit', 'submit-source', source, 2, ['artifact: deliverable.md']));
  const handed = store.applyCollaborationAction(group.id, product.id, control('handoff.request', 'handoff-source', source, 3, [
    'targetRole: 研发',
    'artifact: handoffs/to-dev.md',
  ]));
  return { ...state, source, target: handed.createdWorkItem! };
}

describe('Store formal collaboration routing', () => {
  it('freezes an immutable requirements version before product hands work to development', () => {
    const {
      workspace, mission, source, target,
    } = createHandoff();

    expect(mission.currentRequirementsRevision).toBe(2);
    expect(mission.requirementsRevisions).toEqual([
      expect.objectContaining({
        version: 1,
        artifact: 'requirements/requirements-v1.md',
        sourceWorkItemId: undefined,
      }),
      expect.objectContaining({
        version: 2,
        artifact: 'requirements/requirements-v2.md',
        sourceWorkItemId: source.id,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(target.requirementsRevision).toBe(2);
    expect(fs.readFileSync(
      path.join(workspace, '.ai-team', 'tasks', mission.id, 'requirements', 'requirements-v2.md'),
      'utf-8',
    )).toContain('# 需求方案');
  });

  it('lets a target reject a handoff while the source keeps responsibility', () => {
    const {
      store, group, mission, developer, source, target, control,
    } = createHandoff();

    const rejected = store.applyCollaborationAction(
      group.id,
      developer.id,
      control('work.reject', 'reject-target', target, 0, ['summary: 交接包缺少验收边界']),
    );

    expect(rejected.workItem.status).toBe('cancelled');
    expect(store.taskCardById(source.id)?.status).toBe('submitted');
    expect(rejected.mission.currentPhaseId).toBe('phase-1-product-manager');
    expect(rejected.mission.phases?.map(phase => phase.status)).toEqual(['active', 'planned']);
  });

  it('creates a versioned clarification and reoffers the handoff after the answer', () => {
    const {
      store, workspace, group, mission, product, developer, source, target, control,
    } = createHandoff();
    const requested = store.applyCollaborationAction(
      group.id,
      developer.id,
      control('work.clarify', 'clarify-target', target, 0, ['summary: 请补充异常流程验收标准']),
    );
    const clarification = requested.createdWorkItem!;
    expect(requested.workItem.status).toBe('waiting_dependency');
    expect(clarification).toEqual(expect.objectContaining({
      kind: 'clarification',
      ownerAgentId: product.id,
      parentWorkItemId: target.id,
      status: 'offered',
    }));

    store.applyCollaborationAction(group.id, product.id, control('work.accept', 'accept-clarification', clarification, 0, ['contextRevision: 0']));
    store.applyCollaborationAction(group.id, product.id, control('work.started', 'start-clarification', clarification, 1));
    const clarificationDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', clarification.id);
    fs.writeFileSync(path.join(clarificationDir, 'answer.md'), '# 异常流程验收标准\n', 'utf-8');
    store.applyCollaborationAction(group.id, product.id, control('work.submit', 'submit-clarification', clarification, 2, ['artifact: answer.md']));

    const reoffered = store.taskCardById(target.id)!;
    expect(reoffered).toEqual(expect.objectContaining({ status: 'offered', contextRevision: 1 }));
    const accepted = store.applyCollaborationAction(
      group.id,
      developer.id,
      control('work.accept', 'accept-after-clarification', reoffered, reoffered.revision ?? 0, ['contextRevision: 1']),
    );
    expect(accepted.mission.currentPhaseId).toBe('phase-2-developer');
    expect(store.taskCardById(source.id)?.status).toBe('completed');
  });

  it('runs a consultation without transferring or blocking current responsibility', () => {
    const {
      store, workspace, group, mission, started, product, developer, control,
    } = setup('documentation');
    const source = started.workItem;
    store.applyCollaborationAction(group.id, product.id, control('work.accept', 'consult-source-accept', source, 0, ['contextRevision: 0']));
    store.applyCollaborationAction(group.id, product.id, control('work.started', 'consult-source-start', source, 1));
    const requested = store.applyCollaborationAction(group.id, product.id, control('consultation.request', 'consult-dev', source, 2, [
      'targetRole: 研发',
      'summary: 请评估文档方案的技术可实现性',
    ]));
    const consultation = requested.createdWorkItem!;
    expect(requested.workItem.status).toBe('active');
    expect(consultation.ownerAgentId).toBe(developer.id);

    store.applyCollaborationAction(group.id, developer.id, control('work.accept', 'consult-accept', consultation, 0, ['contextRevision: 0']));
    store.applyCollaborationAction(group.id, developer.id, control('work.started', 'consult-start', consultation, 1));
    const consultationDir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', consultation.id);
    fs.writeFileSync(path.join(consultationDir, 'answer.md'), '# 技术评估\n', 'utf-8');
    store.applyCollaborationAction(group.id, developer.id, control('work.submit', 'consult-submit', consultation, 2, ['artifact: answer.md']));

    expect(store.taskCardById(source.id)).toEqual(expect.objectContaining({
      status: 'active',
      nextStep: expect.stringContaining('咨询产物'),
    }));
  });

  it('lets the final role Leader declare a non-quality mission ready for the owner', () => {
    const {
      store, workspace, group, mission, started, product, control,
    } = setup('discussion');
    const item = started.workItem;
    store.applyCollaborationAction(group.id, product.id, control('work.accept', 'ready-accept', item, 0, ['contextRevision: 0']));
    store.applyCollaborationAction(group.id, product.id, control('work.started', 'ready-start', item, 1));
    const dir = path.join(workspace, '.ai-team', 'tasks', mission.id, 'work-items', item.id);
    fs.writeFileSync(path.join(dir, 'deliverable.md'), '# 最终方案\n', 'utf-8');
    store.applyCollaborationAction(group.id, product.id, control('work.submit', 'ready-submit', item, 2, ['artifact: deliverable.md']));
    const ready = store.applyCollaborationAction(group.id, product.id, control('mission.ready_for_owner', 'ready-owner', item, 3, [
      'artifact: deliverable.md',
      'summary: 方案已完成，请群主确认是否采纳',
    ]));
    expect(ready.mission.status).toBe('ready_for_owner');
    expect(ready.workItem.status).toBe('completed');
  });
});
}

{
// store.ts submission cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-submit-store-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-submit-repo-'));
  tempDirs.push(storage, repository);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Octrix Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'octrix@example.com'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), '# Initial\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repository });

  const store = new Store(storage);
  const committer: Agent = {
    id: 'committer', platform: 'claude-code', name: '提交 AI', command: 'claude', avatarColor: 'blue',
  };
  const developer: Agent = {
    id: 'developer', platform: 'openai-codex-cli', name: '研发 AI', command: 'codex', avatarColor: 'green',
  };
  store.addAgent(committer);
  store.addAgent(developer);
  const committerMember = createGroupMember(committer.id, 'role-committer');
  const developerMember = createGroupMember(developer.id, 'role-developer');
  const group = createAgentGroup(
    '提交群',
    '群主',
    [committerMember, developerMember],
    repository,
    'collaboration',
    {
      'role-committer': committerMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '提交批准修订',
    objective: '提交代码并创建 Draft PR',
    template: 'submission',
    acceptanceCriteria: ['提交内容与批准修订一致'],
  });
  const baseline = await prepareMissionGitBranch(repository, mission.id, mission.title);
  store.setMissionGitBaseline(group.id, mission.id, baseline);
  const started = store.startMission(group.id, mission.id);
  const developerItem = started.workItem;
  const control = (
    item: TaskCard,
    action: string,
    requestId: string,
    expectedRevision: number,
    extra: string[] = [],
  ) => (
    parseCollaborationControlBlocks([
      '```octrix-action',
      `action: ${action}`,
      `requestId: ${requestId}`,
      `missionId: ${mission.id}`,
      `workItemId: ${item.id}`,
      `expectedRevision: ${expectedRevision}`,
      ...extra,
      '```',
    ].join('\n')).actions[0]
  );
  store.applyCollaborationAction(
    group.id,
    developer.id,
    control(developerItem, 'work.accept', 'dev-accept', 0, ['contextRevision: 0']),
  );
  store.applyCollaborationAction(
    group.id,
    developer.id,
    control(developerItem, 'work.started', 'dev-start', 1),
  );

  fs.writeFileSync(path.join(repository, 'README.md'), '# Approved change\n', 'utf-8');
  const snapshot = await captureImplementationRevision(repository, baseline, 1);
  const { revision } = store.recordImplementationRevision(
    group.id,
    mission.id,
    developerItem.id,
    developer.id,
    snapshot,
  );
  const developerItemDir = path.join(
    repository,
    '.ai-team',
    'tasks',
    mission.id,
    'work-items',
    developerItem.id,
  );
  fs.writeFileSync(path.join(developerItemDir, 'deliverable.md'), '# 批准实现修订 R001\n', 'utf-8');
  fs.mkdirSync(path.join(developerItemDir, 'handoffs'), { recursive: true });
  fs.writeFileSync(
    path.join(developerItemDir, 'handoffs', 'to-committer.md'),
    '# 提交交接\n\n请仅提交 R001。\n',
    'utf-8',
  );
  store.applyCollaborationAction(
    group.id,
    developer.id,
    control(developerItem, 'work.submit', 'dev-submit', 2, [
      'artifact: deliverable.md',
      `implementationRevisionId: ${revision.id}`,
    ]),
  );
  const handoff = store.applyCollaborationAction(
    group.id,
    developer.id,
    control(developerItem, 'handoff.request', 'dev-handoff', 3, [
      'targetRole: 提交专员',
      'artifact: handoffs/to-committer.md',
    ]),
  );
  const item = handoff.createdWorkItem!;
  store.applyCollaborationAction(
    group.id,
    committer.id,
    control(item, 'work.accept', 'submit-accept', 0, ['contextRevision: 0']),
  );
  store.applyCollaborationAction(
    group.id,
    committer.id,
    control(item, 'work.started', 'submit-start', 1),
  );
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'feat: approved change'], { cwd: repository });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
  const itemDir = path.join(repository, '.ai-team', 'tasks', mission.id, 'work-items', item.id);
  fs.writeFileSync(path.join(itemDir, 'submission.md'), '# 提交与 Draft PR 证明\n', 'utf-8');
  store.applyCollaborationAction(
    group.id,
    committer.id,
    control(item, 'work.submit', 'submit-proof', 2, ['artifact: submission.md']),
  );
  return {
    store,
    repository,
    group,
    mission,
    item,
    developerItem,
    committer,
    developer,
    control: (action: string, requestId: string, expectedRevision: number, extra: string[] = []) => (
      control(item, action, requestId, expectedRevision, extra)
    ),
    controlFor: control,
    baseline,
    revision,
    commitSha,
  };
}

describe('Store committer submission gate', () => {
  it('records a Draft PR only when HEAD exactly matches the approved immutable revision', async () => {
    const {
      store, group, mission, item, committer, control, baseline, revision, commitSha,
    } = await setup();

    const ready = store.applyCollaborationAction(group.id, committer.id, control('mission.ready_for_owner', 'ready-proof', 3, [
      'artifact: submission.md',
      'summary: 已提交并创建 Draft PR，请群主处理',
      `branch: ${baseline.taskBranch}`,
      `commitSha: ${commitSha}`,
      'prUrl: https://github.com/example/project/pull/42',
      'draftPr: true',
    ]));

    expect(ready.mission.status).toBe('ready_for_owner');
    expect(ready.mission.submission).toEqual({
      revisionId: revision.id,
      revisionContentHash: revision.contentHash,
      branch: baseline.taskBranch,
      commitSha,
      prUrl: 'https://github.com/example/project/pull/42',
      draft: true,
      recordedAt: expect.any(Number),
    });
    expect(ready.workItem.status).toBe('completed');
    expect(item.id).toBe(ready.workItem.id);
  });

  it('rejects a submission proof after unapproved content is committed', async () => {
    const {
      store, repository, group, mission, committer, developer, control, controlFor, baseline,
    } = await setup();
    fs.writeFileSync(path.join(repository, 'README.md'), '# Unapproved second change\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'feat: unapproved'], { cwd: repository });
    const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();

    expect(() => store.applyCollaborationAction(group.id, committer.id, control('mission.ready_for_owner', 'ready-bad-proof', 3, [
      'artifact: submission.md',
      'summary: 尝试提交未批准内容',
      `branch: ${baseline.taskBranch}`,
      `commitSha: ${newHead}`,
      'prUrl: https://github.com/example/project/pull/43',
      'draftPr: true',
    ]))).toThrow('检测到批准实现修订之外的项目文件变化');
    expect(mission.status).toBe('external_change_detected');
    expect(() => store.resumeMission(
      group.id,
      mission.id,
      '尝试不做决策直接继续',
    )).toThrow('必须明确选择纳入变更、移除变更或取消任务');

    const incorporated = store.resolveExternalChanges(
      group.id,
      mission.id,
      'incorporate',
      '群主确认这部分变更属于任务范围，交技术 Leader 重新核对',
    );
    expect(incorporated.mission.status).toBe('active');
    expect(incorporated.workItem).toEqual(expect.objectContaining({
      roleId: 'role-developer',
      ownerAgentId: developer.id,
      kind: 'rework',
      status: 'offered',
      returnToPhaseId: 'phase-2-committer',
    }));
    expect(incorporated.mission.ownerDecisionHistory?.at(-1)?.action)
      .toBe('incorporate_external_changes');

    const developerRework = incorporated.workItem!;
    store.applyCollaborationAction(
      group.id,
      developer.id,
      controlFor(developerRework, 'work.accept', 'external-dev-accept', 0, ['contextRevision: 0']),
    );
    store.applyCollaborationAction(
      group.id,
      developer.id,
      controlFor(developerRework, 'work.started', 'external-dev-start', 1),
    );
    const snapshot = await captureImplementationRevision(repository, baseline, 2);
    const recorded = store.recordImplementationRevision(
      group.id,
      mission.id,
      developerRework.id,
      developer.id,
      snapshot,
    );
    expect(recorded.revision).toEqual(expect.objectContaining({
      id: 'R002',
      changedFiles: ['README.md'],
    }));
    expect(mission.currentImplementationRevisionId).toBe('R002');
  });

  it('restores the exact approved revision when the owner discards external changes', async () => {
    const {
      store, repository, group, mission, committer, control, baseline,
    } = await setup();
    fs.writeFileSync(path.join(repository, 'README.md'), '# Unapproved second change\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'feat: unapproved'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'scratch.txt'), 'external untracked file\n', 'utf-8');
    const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
    expect(() => store.applyCollaborationAction(group.id, committer.id, control('mission.ready_for_owner', 'ready-discard', 3, [
      'artifact: submission.md',
      'summary: 包含了外部变化',
      `branch: ${baseline.taskBranch}`,
      `commitSha: ${newHead}`,
      'prUrl: https://github.com/example/project/pull/45',
      'draftPr: true',
    ]))).toThrow('检测到批准实现修订之外的项目文件变化');

    const discarded = store.resolveExternalChanges(
      group.id,
      mission.id,
      'discard',
      '外部改动不属于任务范围，恢复 R001 后继续提交',
    );

    expect(discarded.mission.status).toBe('active');
    expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf-8')).toBe('# Approved change\n');
    expect(fs.existsSync(path.join(repository, 'scratch.txt'))).toBe(false);
    expect(fs.existsSync(path.join(
      repository,
      '.ai-team',
      'tasks',
      mission.id,
      'mission.md',
    ))).toBe(true);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim())
      .toBe(baseline.baseCommit);
    expect(discarded.mission.ownerDecisionHistory?.at(-1)?.action)
      .toBe('discard_external_changes');
  });

  it('rejects an AI merge report when the owner did not pre-authorize automatic merge', async () => {
    const {
      store, group, mission, item, committer, control, baseline, commitSha,
    } = await setup();
    store.applyCollaborationAction(group.id, committer.id, control('mission.ready_for_owner', 'ready-no-auto', 3, [
      'artifact: submission.md',
      'summary: 已创建 Draft PR',
      `branch: ${baseline.taskBranch}`,
      `commitSha: ${commitSha}`,
      'prUrl: https://github.com/example/project/pull/44',
      'draftPr: true',
    ]));

    expect(() => store.applyCollaborationAction(
      group.id,
      committer.id,
      control('mission.auto_merge_complete', 'merge-without-owner', 4, [
        'artifact: submission.md',
        'summary: 尝试报告合并',
        'prUrl: https://github.com/example/project/pull/44',
        `mergeCommitSha: ${commitSha}`,
      ]),
    )).toThrow('没有自动合并预授权');
    expect(mission.status).toBe('ready_for_owner');
    expect(item.status).toBe('completed');
  });
});
}

{
// store.ts timeouts cases
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-timeout-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-timeout-workspace-'));
  tempDirs.push(storage, workspace);
  const store = new Store(storage);
  const product: Agent = {
    id: 'product', platform: 'claude-code', name: '产品 AI', command: 'claude', avatarColor: 'blue',
  };
  const developer: Agent = {
    id: 'developer', platform: 'openai-codex-cli', name: '研发 AI', command: 'codex', avatarColor: 'green',
  };
  store.addAgent(product);
  store.addAgent(developer);
  const productMember = createGroupMember(product.id, 'role-product-manager');
  const developerMember = createGroupMember(developer.id, 'role-developer');
  const group = createAgentGroup(
    '超时群',
    '群主',
    [productMember, developerMember],
    workspace,
    'collaboration',
    {
      'role-product-manager': productMember.id,
      'role-developer': developerMember.id,
    },
  );
  store.addGroup(group);
  const mission = store.createMission(group.id, {
    title: '超时任务', objective: '验证提醒', template: 'discussion', acceptanceCriteria: ['有提醒'],
  });
  const started = store.startMission(group.id, mission.id);
  return { store, mission, workItem: started.workItem };
}

describe('Store collaboration timeout evaluation', () => {
  it('marks a three-minute unanswered offer unresponsive without reassigning it', () => {
    const { store, workItem } = setup();
    const now = 10_000;
    workItem.offeredAt = now - 181;

    const result = store.evaluateCollaborationTimeouts(now);

    expect(result.unresponsive.map(item => item.id)).toEqual([workItem.id]);
    expect(workItem.status).toBe('offered');
    expect(workItem.unresponsiveAt).toBe(now);
  });

  it('reminds at fifteen minutes and stalls at thirty without terminating the process', () => {
    const { store, mission, workItem } = setup();
    const now = 20_000;
    workItem.status = 'active';
    workItem.startedAt = now - 1_801;
    workItem.lastProgressAt = now - 1_801;

    const result = store.evaluateCollaborationTimeouts(now);

    expect(result.progressReminders.map(item => item.id)).toEqual([workItem.id]);
    expect(result.stalled.map(item => item.id)).toEqual([workItem.id]);
    expect(workItem).toEqual(expect.objectContaining({
      status: 'stalled',
      interruptedFromStatus: 'active',
      progressReminderAt: now,
      stalledAt: now,
    }));
    expect(mission.status).toBe('stalled');
  });
});
}
