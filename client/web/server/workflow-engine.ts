import {
  type Envelope, type EmitRequest, type WorkflowRun,
  createWorkflowStep, createWorkflowDefinition,
  createWorkflowStepRun, createWorkflowRun,
} from './models.js';
import type { Store } from './store.js';

export class WorkflowEngine {
  constructor(private store: Store) {}

  process(envelope: Envelope): EmitRequest[] {
    if (envelope.from === 'system') return [];
    const body = envelope.body.trim();
    if (!body.startsWith('/wf ')) return [];
    const args = body.slice(4).trim();
    const groupId = envelope.groupId ?? '';
    return this.handleCommand(args, envelope.from, groupId, envelope.taskSessionId);
  }

  private handleCommand(args: string, from: string, groupId: string, taskSessionId?: string): EmitRequest[] {
    const spaceIdx = args.indexOf(' ');
    const sub = spaceIdx >= 0 ? args.slice(0, spaceIdx) : args;
    const rest = spaceIdx >= 0 ? args.slice(spaceIdx + 1) : '';

    switch (sub) {
      case 'define': return this.handleDefine(rest, from, groupId, taskSessionId);
      case 'start': return this.handleStart(rest, from, groupId, taskSessionId);
      case 'done': return this.handleDone(rest, from, groupId, taskSessionId);
      case 'status': return this.handleStatus(rest, groupId, taskSessionId);
      case 'list': return this.handleList(groupId, taskSessionId);
      default: return this.systemReply(groupId, `未知命令: ${sub}`, taskSessionId);
    }
  }

  // /wf define <name> <agent1> -> <agent2>[,<agent3>] -> ...
  private handleDefine(args: string, _from: string, groupId: string, taskSessionId?: string): EmitRequest[] {
    const firstSpace = args.indexOf(' ');
    if (firstSpace < 0) {
      return this.systemReply(groupId, '用法: /wf define <名称> <agent1> -> <agent2> ...', taskSessionId);
    }
    const name = args.slice(0, firstSpace).trim();
    const pipeline = args.slice(firstSpace + 1);
    const segments = pipeline.split('->').map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length < 2) {
      return this.systemReply(groupId, '需要至少两个 Agent，用 -> 连接', taskSessionId);
    }

    const steps = [];
    let prevIds: string[] = [];
    for (const segment of segments) {
      const agents = segment.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const currentIds: string[] = [];
      for (const agentName of agents) {
        const step = createWorkflowStep(agentName, [...prevIds]);
        steps.push(step);
        currentIds.push(step.id);
      }
      prevIds = currentIds;
    }

    const wf = createWorkflowDefinition(name, groupId, steps);
    this.store.addWorkflow(wf);
    const desc = segments.join(' → ');
    return this.systemReply(groupId, `[系统] 工作流「${name}」已创建: ${desc}`, taskSessionId);
  }

  // /wf start <name> [message]
  private handleStart(args: string, _from: string, groupId: string, taskSessionId?: string): EmitRequest[] {
    const spaceIdx = args.indexOf(' ');
    const name = spaceIdx >= 0 ? args.slice(0, spaceIdx) : args;
    const input = spaceIdx >= 0 ? args.slice(spaceIdx + 1) : '';

    if (!name) return this.systemReply(groupId, '用法: /wf start <名称> [消息]', taskSessionId);

    const wf = this.store.workflows.find(w => w.name === name && w.groupId === groupId);
    if (!wf) return this.systemReply(groupId, `[系统] 未找到工作流「${name}」`, taskSessionId);

    const stepRuns = wf.steps.map(s => createWorkflowStepRun(s.id, s.agentName));
    const run = createWorkflowRun(wf.id, wf.name, groupId, stepRuns, input);

    const initialStepIds = new Set(wf.steps.filter(s => s.dependsOn.length === 0).map(s => s.id));
    const responses: EmitRequest[] = [];
    const startedAgents: string[] = [];

    for (let i = 0; i < run.stepRuns.length; i++) {
      if (!initialStepIds.has(run.stepRuns[i].stepId)) continue;
      run.stepRuns[i].status = 'running';
      run.stepRuns[i].startedAt = Date.now() / 1000;
      startedAgents.push(run.stepRuns[i].agentName);
      responses.push({
        from: 'system', to: run.stepRuns[i].agentName,
        body: `[工作流 ${run.id.slice(0, 8)}] ${input}`,
        groupId,
        taskSessionId,
      });
    }

    this.store.addWorkflowRun(run);
    const names = startedAgents.join(', ');
    responses.push(...this.systemReply(
      groupId,
      `[系统] 工作流「${name}」已启动 (ID: ${run.id.slice(0, 8)})，任务已发送给 ${names}`,
      taskSessionId,
    ));
    return responses;
  }

  // /wf done [runIdPrefix] <result>
  private handleDone(args: string, from: string, groupId: string, taskSessionId?: string): EmitRequest[] {
    const activeRuns = this.store.workflowRuns.filter(
      r => r.groupId === groupId && r.status === 'running',
    );
    if (activeRuns.length === 0) {
      return this.systemReply(groupId, '[系统] 当前群组无活跃工作流', taskSessionId);
    }

    const spaceIdx = args.indexOf(' ');
    const firstWord = spaceIdx >= 0 ? args.slice(0, spaceIdx) : args;

    if (firstWord) {
      const run = activeRuns.find(r => r.id.startsWith(firstWord));
      if (run) {
        const stepIdx = run.stepRuns.findIndex(
          sr => sr.agentName === from && sr.status === 'running',
        );
        if (stepIdx >= 0) {
          const result = spaceIdx >= 0 ? args.slice(spaceIdx + 1) : '';
          return this.completeStep(run, stepIdx, result, taskSessionId);
        }
      }
    }

    for (const run of activeRuns) {
      const stepIdx = run.stepRuns.findIndex(
        sr => sr.agentName === from && sr.status === 'running',
      );
      if (stepIdx >= 0) {
        return this.completeStep(run, stepIdx, args, taskSessionId);
      }
    }

    return this.systemReply(groupId, `[系统] 未找到 ${from} 的活跃工作流步骤`, taskSessionId);
  }

  // /wf status [runIdPrefix]
  private handleStatus(args: string, groupId: string, taskSessionId?: string): EmitRequest[] {
    const prefix = args.trim();
    if (!prefix) {
      const active = this.store.workflowRuns.filter(
        r => r.groupId === groupId && r.status === 'running',
      );
      if (active.length === 0) return this.systemReply(groupId, '[系统] 当前无活跃的工作流', taskSessionId);
      const lines = ['活跃工作流:'];
      for (const run of active) {
        const done = run.stepRuns.filter(sr => sr.status === 'completed').length;
        const total = run.stepRuns.length;
        const current = run.stepRuns.find(sr => sr.status === 'running')?.agentName ?? '等待中';
        lines.push(`  ${run.id.slice(0, 8)} 「${run.workflowName}」${done}/${total} 当前: ${current}`);
      }
      return this.systemReply(groupId, lines.join('\n'), taskSessionId);
    }

    const run = this.store.workflowRuns.find(r => r.id.startsWith(prefix));
    if (!run) return this.systemReply(groupId, `[系统] 未找到 ID 为 ${prefix} 的工作流运行`, taskSessionId);

    const lines = [`工作流「${run.workflowName}」(${run.id.slice(0, 8)}) - ${run.status}:`];
    for (const sr of run.stepRuns) {
      const icons: Record<string, string> = { pending: '⏳', running: '🔄', completed: '✅', failed: '❌' };
      let line = `  ${icons[sr.status] ?? '?'} ${sr.agentName}`;
      if (sr.result) line += ` → ${sr.result}`;
      lines.push(line);
    }
    return this.systemReply(groupId, lines.join('\n'), taskSessionId);
  }

  // /wf list
  private handleList(groupId: string, taskSessionId?: string): EmitRequest[] {
    const wfs = this.store.workflows.filter(w => w.groupId === groupId);
    if (wfs.length === 0) return this.systemReply(groupId, '[系统] 当前群组无工作流定义', taskSessionId);
    const lines = ['工作流定义:'];
    for (const wf of wfs) {
      const pipeline = wf.steps.map(s => s.agentName).join(' → ');
      lines.push(`  「${wf.name}」: ${pipeline}`);
    }
    return this.systemReply(groupId, lines.join('\n'), taskSessionId);
  }

  // MARK: - DAG advancement

  private completeStep(run: WorkflowRun, stepIdx: number, result: string, taskSessionId?: string): EmitRequest[] {
    run.stepRuns[stepIdx].status = 'completed';
    run.stepRuns[stepIdx].result = result;
    run.stepRuns[stepIdx].completedAt = Date.now() / 1000;

    const agent = run.stepRuns[stepIdx].agentName;
    const responses = this.systemReply(run.groupId, `[系统] ${agent} 已完成步骤`, taskSessionId);
    responses.push(...this.advanceRun(run, taskSessionId));
    return responses;
  }

  private advanceRun(run: WorkflowRun, taskSessionId?: string): EmitRequest[] {
    const wf = this.store.workflowById(run.workflowId);
    if (!wf) { this.store.updateWorkflowRun(run); return []; }

    const completedIds = new Set(
      run.stepRuns.filter(sr => sr.status === 'completed').map(sr => sr.stepId),
    );
    const responses: EmitRequest[] = [];

    for (const step of wf.steps) {
      if (step.dependsOn.length === 0) continue;
      const idx = run.stepRuns.findIndex(sr => sr.stepId === step.id);
      if (idx < 0 || run.stepRuns[idx].status !== 'pending') continue;
      if (!step.dependsOn.every(d => completedIds.has(d))) continue;

      run.stepRuns[idx].status = 'running';
      run.stepRuns[idx].startedAt = Date.now() / 1000;

      const predResults = step.dependsOn
        .map(depId => run.stepRuns.find(sr => sr.stepId === depId)?.result)
        .filter((r): r is string => !!r && r.length > 0)
        .join('\n');
      const taskBody = predResults || run.input;
      responses.push({
        from: 'system', to: run.stepRuns[idx].agentName,
        body: `[工作流 ${run.id.slice(0, 8)}] ${taskBody}`,
        groupId: run.groupId,
        taskSessionId,
      });
      responses.push(...this.systemReply(
        run.groupId, `[系统] 任务已发送给 ${run.stepRuns[idx].agentName}`, taskSessionId,
      ));
    }

    if (run.stepRuns.every(sr => sr.status === 'completed')) {
      run.status = 'completed';
      responses.push(...this.systemReply(
        run.groupId, `[系统] 工作流「${run.workflowName}」已全部完成`, taskSessionId,
      ));
    }

    this.store.updateWorkflowRun(run);
    return responses;
  }

  private systemReply(groupId: string, message: string, taskSessionId?: string): EmitRequest[] {
    return [{ from: 'system', to: 'user', body: message, groupId, taskSessionId }];
  }
}
