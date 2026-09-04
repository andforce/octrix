import { useState } from 'react';
import type {
  Agent,
  AgentGroup,
  CollaborationIssue,
  TaskSession,
  WorkItem,
} from '../types';
import { api } from '../lib/api';

interface Props {
  group: AgentGroup;
  mission: TaskSession;
  workItems: WorkItem[];
  issues: CollaborationIssue[];
  agents: Agent[];
  onConfigure: () => void;
}

const MISSION_STATUS_LABELS: Record<TaskSession['status'], string> = {
  draft: '待群主确认',
  preparing: '准备中',
  active: '自治运行中',
  waiting_human: '等待群主',
  stalled: '已停滞',
  interrupted: '已中断',
  protocol_error: '协议异常',
  external_change_detected: '检测到外部变更',
  ready_for_owner: '等待群主处理',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
};

const WORK_STATUS_LABELS: Record<string, string> = {
  planned: '待规划',
  offered: '待接受',
  accepted: '已接受',
  active: '进行中',
  waiting_dependency: '等待依赖',
  waiting_collab: '协作中',
  waiting_human: '等待群主',
  pending_human_verification: '等待人工验证',
  submitted: '待交接',
  blocked: '阻塞',
  stalled: '停滞',
  completed: '已完成',
};

export function MissionStatusPanel({
  group,
  mission,
  workItems,
  issues,
  agents,
  onConfigure,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [ownerAction, setOwnerAction] = useState<
    | 'pause'
    | 'resume'
    | 'complete'
    | 'request_changes'
    | 'accept_risk'
    | 'extend_rework'
    | 'incorporate_external_changes'
    | 'discard_external_changes'
    | 'import_external_implementation'
    | 'reassign'
    | 'cancel'
    | null
  >(null);
  const [ownerNote, setOwnerNote] = useState('');
  const [ownerActionBusy, setOwnerActionBusy] = useState(false);
  const [ownerActionError, setOwnerActionError] = useState('');
  const [ownerTargetWorkItemId, setOwnerTargetWorkItemId] = useState('');
  const [reassignMemberId, setReassignMemberId] = useState('');
  const [additionalRounds, setAdditionalRounds] = useState(1);
  const currentPhase = (mission.phases ?? []).find(phase => phase.id === mission.currentPhaseId)
    ?? (mission.phases ?? []).find(phase => phase.status === 'active');
  const activeWorkItem = workItems.find(item => (
    item.taskSessionId === mission.id
    && item.phaseId === currentPhase?.id
    && !['completed', 'cancelled', 'done'].includes(item.status)
  ));
  const owner = agents.find(agent => agent.id === activeWorkItem?.ownerAgentId);
  const blockingSeverities = new Set(
    mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major'],
  );
  const blockers = issues.filter(issue => (
    issue.missionId === mission.id
    && blockingSeverities.has(issue.severity)
    && ['open', 'reopened'].includes(issue.status)
  ));
  const unresolvedIssues = issues.filter(issue => (
    issue.missionId === mission.id && ['open', 'reopened'].includes(issue.status)
  ));
  const riskIssueIds = (blockers.length > 0 ? blockers : unresolvedIssues).map(issue => issue.id);

  const submitOwnerAction = async () => {
    const note = ownerNote.trim();
    if (!ownerAction || !note || ownerActionBusy) return;
    setOwnerActionBusy(true);
    setOwnerActionError('');
    try {
      if (ownerAction === 'resume') await api.resumeMission(group.id, mission.id, note);
      if (ownerAction === 'pause') await api.pauseMission(group.id, mission.id, note);
      if (ownerAction === 'complete') await api.completeMission(group.id, mission.id, note);
      if (ownerAction === 'request_changes') await api.requestMissionChanges(group.id, mission.id, note);
      if (ownerAction === 'accept_risk') {
        await api.acceptMissionRisk(group.id, mission.id, riskIssueIds, note);
      }
      if (ownerAction === 'extend_rework') {
        await api.extendMissionRework(group.id, mission.id, additionalRounds, note);
      }
      if (ownerAction === 'incorporate_external_changes') {
        await api.resolveMissionExternalChanges(group.id, mission.id, 'incorporate', note);
      }
      if (ownerAction === 'discard_external_changes') {
        await api.resolveMissionExternalChanges(group.id, mission.id, 'discard', note);
      }
      if (ownerAction === 'import_external_implementation') {
        await api.importMissionExternalImplementation(group.id, mission.id, note);
      }
      if (ownerAction === 'reassign') {
        await api.reassignMissionWorkItem(
          group.id,
          mission.id,
          ownerTargetWorkItemId,
          reassignMemberId,
          note,
        );
      }
      if (ownerAction === 'cancel') await api.cancelMission(group.id, mission.id, note);
      setOwnerAction(null);
      setOwnerNote('');
      setOwnerTargetWorkItemId('');
      setReassignMemberId('');
    } catch (error) {
      setOwnerActionError(error instanceof Error ? error.message : '群主操作失败');
    } finally {
      setOwnerActionBusy(false);
    }
  };

  return (
    <section className="border-b border-border bg-surface-elevated/70 px-5 py-2.5" aria-label="主任务状态">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${
          mission.status === 'active'
            ? 'bg-mint shadow-[0_0_8px_currentColor] text-mint'
            : mission.status === 'ready_for_owner' || mission.status === 'waiting_human'
              ? 'bg-amber-300 text-amber-300'
              : 'bg-content-subtle text-content-subtle'
        }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-content">{mission.title}</span>
            <span className="shrink-0 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-content-muted">
              {MISSION_STATUS_LABELS[mission.status] ?? mission.status}
            </span>
            {currentPhase ? (
              <span className="shrink-0 text-xs text-content-muted">
                {currentPhase.name} · {WORK_STATUS_LABELS[activeWorkItem?.status ?? 'planned'] ?? activeWorkItem?.status}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-content-subtle">
            {owner ? <span>负责人：{owner.name}</span> : null}
            {mission.gitBaseline ? <span>{mission.gitBaseline.taskBranch}</span> : null}
            {blockers.length > 0 ? <span className="text-red-300">{blockers.length} 个阻断问题</span> : null}
            {(mission.reworkRound ?? 0) > 0 ? <span>返工 {mission.reworkRound}/{mission.maxReworkRounds ?? 3}</span> : null}
          </div>
        </div>
        {mission.status === 'draft' ? (
          <button
            type="button"
            onClick={onConfigure}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover"
          >
            继续配置并启动
          </button>
        ) : null}
        {['interrupted', 'stalled', 'protocol_error'].includes(mission.status)
        || (mission.status === 'waiting_human' && (
          mission.interruptionReason === 'owner_paused'
          || mission.interruptionReason?.startsWith('required_member_offline:')
          || mission.interruptionReason?.startsWith('owner_attention:')
        )) ? (
          <button
            type="button"
            onClick={() => setOwnerAction('resume')}
            className="shrink-0 rounded-lg bg-mint/15 px-3 py-1.5 text-xs font-semibold text-mint transition hover:bg-mint/20"
          >
            恢复任务
          </button>
        ) : null}
        {mission.status === 'external_change_detected' ? (
          <div className="flex shrink-0 items-center gap-2">
            {(mission.phases ?? []).some(phase => (
              phase.roleId === 'role-developer' && !!phase.leaderMemberId
            )) ? (
              <button
                type="button"
                onClick={() => setOwnerAction('incorporate_external_changes')}
                className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/10"
              >
                纳入并交研发核对
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setOwnerAction('discard_external_changes')}
              className="rounded-lg bg-mint/15 px-3 py-1.5 text-xs font-semibold text-mint transition hover:bg-mint/20"
            >
              移除外部变更
            </button>
          </div>
        ) : null}
        {mission.status === 'waiting_human'
        && mission.interruptionReason === 'awaiting_external_implementation' ? (
          <button
            type="button"
            onClick={() => setOwnerAction('import_external_implementation')}
            className="shrink-0 rounded-lg bg-mint/15 px-3 py-1.5 text-xs font-semibold text-mint transition hover:bg-mint/20"
          >
            导入外部实现修订
          </button>
          ) : null}
        {mission.status === 'ready_for_owner' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setOwnerAction('request_changes')}
              className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/10"
            >
              退回修改
            </button>
            <button
              type="button"
              onClick={() => setOwnerAction('complete')}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover"
            >
              验收并完成
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-content-muted transition hover:bg-surface-hover hover:text-content"
        >
          {expanded ? '收起' : '详情'}
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 grid gap-3 border-t border-border/70 pt-3 lg:grid-cols-[1fr_1fr]">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-content-subtle">阶段</p>
            <div className="flex flex-wrap gap-2">
              {(mission.phases ?? []).map(phase => (
                <span
                  key={phase.id}
                  className={`rounded-lg border px-2 py-1 text-xs ${
                    phase.status === 'active'
                      ? 'border-accent/35 bg-accent/10 text-accent'
                      : phase.status === 'passed'
                        ? 'border-mint/25 bg-mint/10 text-mint'
                        : phase.status === 'missing' || phase.status === 'blocked'
                          ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
                          : 'border-border bg-surface-muted text-content-subtle'
                  }`}
                >
                  {phase.order}. {phase.name}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-content-subtle">当前工作项</p>
            {workItems.filter(item => item.taskSessionId === mission.id && !['completed', 'cancelled', 'done'].includes(item.status)).length > 0 ? (
              <div className="space-y-1">
                {workItems
                  .filter(item => item.taskSessionId === mission.id && !['completed', 'cancelled', 'done'].includes(item.status))
                  .map(item => {
                    const itemOwner = agents.find(agent => agent.id === item.ownerAgentId);
                    return (
                      <div key={item.id} className="flex items-center justify-between gap-3 text-xs text-content-muted">
                        <span className="truncate">{item.title}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-mono text-[10px] text-content-subtle">{itemOwner?.name ?? item.ownerAgentId} · {WORK_STATUS_LABELS[item.status] ?? item.status}</span>
                          {group.members.some(member => (
                            member.roleId === item.roleId && member.id !== item.ownerMemberId
                          )) ? (
                            <button
                              type="button"
                              onClick={() => {
                                const replacement = group.members.find(member => (
                                  member.roleId === item.roleId && member.id !== item.ownerMemberId
                                ));
                                setOwnerTargetWorkItemId(item.id);
                                setReassignMemberId(replacement?.id ?? '');
                                setOwnerAction('reassign');
                              }}
                              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-content-muted"
                            >
                              改派
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <p className="text-xs text-content-subtle">暂无进行中的工作项</p>
            )}
          </div>
          {mission.status === 'ready_for_owner' ? (
            <div className="lg:col-span-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              团队已完成当前自治流程，请{group.ownerName}检查产物、Draft PR 或决定下一步。
            </div>
          ) : null}
          {mission.status === 'waiting_human' && mission.interruptionReason?.includes('fuse') ? (
            <div className="lg:col-span-2 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
              <span className="mr-auto text-xs text-amber-100">自治返工已熔断，未解决问题不会被自动视为通过。</span>
              {riskIssueIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setOwnerAction('accept_risk')}
                  className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100"
                >
                  接受所列风险
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOwnerAction('extend_rework')}
                className="rounded-lg bg-amber-300/15 px-3 py-1.5 text-xs font-semibold text-amber-100"
              >
                追加返工轮次
              </button>
            </div>
          ) : null}
          {!['completed', 'cancelled', 'archived'].includes(mission.status) ? (
            <div className="lg:col-span-2 flex justify-end gap-2">
              {mission.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => setOwnerAction('pause')}
                  className="rounded-lg border border-amber-400/25 px-3 py-1.5 text-xs text-amber-200 transition hover:bg-amber-400/10"
                >
                  暂停任务
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOwnerAction('cancel')}
                className="rounded-lg border border-red-400/25 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-400/10"
              >
                取消任务
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {ownerAction ? (
        <div className="mt-3 flex items-end gap-2 rounded-xl border border-border bg-surface-muted p-3">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-xs font-medium text-content" htmlFor={`mission-owner-note-${mission.id}`}>
              {ownerAction === 'resume'
                ? '恢复核对说明'
                : ownerAction === 'pause'
                  ? '暂停原因'
                  : ownerAction === 'complete'
                    ? '验收或合并结论'
                    : ownerAction === 'request_changes'
                      ? '修改范围与验收预期'
                      : ownerAction === 'accept_risk'
                        ? `风险接受依据（${riskIssueIds.join('、')}）`
                        : ownerAction === 'extend_rework'
                          ? '追加轮次理由与收敛条件'
                          : ownerAction === 'incorporate_external_changes'
                            ? '纳入范围、来源与技术 Leader 核对要求'
                            : ownerAction === 'discard_external_changes'
                              ? '确认移除的外部变更范围与恢复依据'
                              : ownerAction === 'import_external_implementation'
                                ? '外部实现来源、变更范围与群主核对结果'
                          : ownerAction === 'reassign'
                            ? '改派原因与交接要求'
                            : '取消原因'}
            </label>
            {ownerAction === 'extend_rework' ? (
              <label className="mb-2 flex items-center gap-2 text-xs text-content-muted">
                追加轮次
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={additionalRounds}
                  onChange={event => setAdditionalRounds(Number(event.target.value))}
                  className="w-20 rounded border border-border bg-surface-elevated px-2 py-1 text-content"
                />
              </label>
            ) : null}
            {ownerAction === 'reassign' ? (
              <label className="mb-2 flex items-center gap-2 text-xs text-content-muted">
                新负责人
                <select
                  value={reassignMemberId}
                  onChange={event => setReassignMemberId(event.target.value)}
                  className="min-w-40 rounded border border-border bg-surface-elevated px-2 py-1 text-content"
                >
                  {group.members
                    .filter(member => {
                      const item = workItems.find(candidate => candidate.id === ownerTargetWorkItemId);
                      return member.roleId === item?.roleId && member.id !== item.ownerMemberId;
                    })
                    .map(member => (
                      <option key={member.id} value={member.id}>
                        {agents.find(agent => agent.id === member.agentId)?.name ?? member.agentId}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <textarea
              id={`mission-owner-note-${mission.id}`}
              rows={2}
              value={ownerNote}
              onChange={event => setOwnerNote(event.target.value)}
              placeholder="该说明会追加到不可覆盖的任务事件和群主决策记录"
              className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs text-content outline-none focus:border-accent/40"
            />
            {ownerActionError ? <p className="mt-1 text-xs text-red-300">{ownerActionError}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => setOwnerAction(null)}
            className="rounded-lg border border-border px-3 py-2 text-xs text-content-muted"
          >
            返回
          </button>
          <button
            type="button"
            onClick={submitOwnerAction}
            disabled={
              !ownerNote.trim()
              || ownerActionBusy
              || (ownerAction === 'accept_risk' && riskIssueIds.length === 0)
              || (ownerAction === 'reassign' && (!ownerTargetWorkItemId || !reassignMemberId))
            }
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {ownerActionBusy ? '处理中…' : '确认'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
