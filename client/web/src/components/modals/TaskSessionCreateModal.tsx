import { useMemo, useState } from 'react';
import type {
  AgentGroup,
  IssueSeverity,
  MissionPhase,
  MissionTemplate,
  MissingRoleResolution,
  TaskSession,
} from '../../types';
import { api } from '../../lib/api';
import { useAppStore } from '../../hooks/useStore';

interface Props {
  group: AgentGroup;
  initialMission?: TaskSession;
  onClose: () => void;
  onCreated: (taskSessionId: string) => void;
}

const TEMPLATES: Array<{ value: MissionTemplate; label: string }> = [
  { value: 'feature', label: '新功能开发' },
  { value: 'bugfix', label: 'Bug 修复' },
  { value: 'refactor', label: '技术重构' },
  { value: 'discussion', label: '产品或技术方案讨论' },
  { value: 'review', label: '代码审查' },
  { value: 'test', label: '测试验证' },
  { value: 'documentation', label: '文档任务' },
  { value: 'submission', label: '提交与 PR' },
  { value: 'generic', label: '通用任务' },
];

const FIXED_PHASES = [
  { roleId: 'role-product-manager', label: '产品经理' },
  { roleId: 'role-developer', label: '研发' },
  { roleId: 'role-code-reviewer', label: '代码审查' },
  { roleId: 'role-tester', label: '测试' },
  { roleId: 'role-committer', label: '提交专员' },
];

const MISSING_ROLE_OPTIONS: Record<string, Array<{ value: MissingRoleResolution; label: string }>> = {
  'role-product-manager': [
    { value: 'owner_supplies', label: '群主提供并确认需求与验收标准' },
    { value: 'remove_irrelevant', label: '确认此阶段与任务无关' },
  ],
  'role-developer': [
    { value: 'external_implementation', label: '群主在系统外实现后导入' },
    { value: 'remove_irrelevant', label: '确认此阶段与任务无关' },
  ],
  'role-code-reviewer': [
    { value: 'waive', label: '群主豁免独立代码审查' },
    { value: 'remove_irrelevant', label: '确认此阶段与任务无关' },
  ],
  'role-tester': [
    { value: 'waive', label: '群主豁免独立测试' },
    { value: 'remove_irrelevant', label: '确认此阶段与任务无关' },
  ],
  'role-committer': [
    { value: 'owner_handles', label: '质量门禁后由群主处理 Git 与 PR' },
    { value: 'remove_irrelevant', label: '确认此阶段与任务无关' },
  ],
};

const fieldClass = 'w-full rounded-xl border border-border bg-surface-muted px-3 py-2.5 text-sm text-content outline-none transition focus:border-accent/40 focus:ring-2 focus:ring-accent/25';

function defaultMissingResolutions(mission: TaskSession | undefined): Record<string, MissingRoleResolution> {
  const defaults: Record<string, MissingRoleResolution> = {};
  for (const phase of mission?.phases ?? []) {
    if (phase.status !== 'missing') continue;
    const first = MISSING_ROLE_OPTIONS[phase.roleId]?.[0];
    if (first) defaults[phase.roleId] = first.value;
  }
  return defaults;
}

export function TaskSessionCreateModal({ group, initialMission, onClose, onCreated }: Props) {
  const { agents } = useAppStore();
  const [goal, setGoal] = useState(initialMission?.objective ?? '');
  const [title, setTitle] = useState(initialMission?.title ?? '');
  const [objective, setObjective] = useState(initialMission?.objective ?? '');
  const [template, setTemplate] = useState<MissionTemplate>(initialMission?.template ?? 'feature');
  const [acceptanceText, setAcceptanceText] = useState(
    (initialMission?.acceptanceCriteria ?? []).join('\n'),
  );
  const [blockingSeverities, setBlockingSeverities] = useState<IssueSeverity[]>(
    initialMission?.qualityPolicy?.blockingSeverities ?? ['blocker', 'major'],
  );
  const [draft, setDraft] = useState<TaskSession | null>(initialMission ?? null);
  const [resolutionByRole, setResolutionByRole] = useState<Record<string, MissingRoleResolution>>(
    () => defaultMissingResolutions(initialMission),
  );
  const [noteByRole, setNoteByRole] = useState<Record<string, string>>({});
  const [phaseToAdd, setPhaseToAdd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const acceptanceCriteria = useMemo(
    () => acceptanceText.split('\n').map(item => item.trim()).filter(Boolean),
    [acceptanceText],
  );
  const missingPhases = useMemo(
    () => (draft?.phases ?? []).filter(phase => phase.required && phase.status === 'missing'),
    [draft],
  );

  const qualityPolicy = useMemo(() => ({
    blockingSeverities,
    sharedStateTestExecution: 'serial' as const,
  }), [blockingSeverities]);

  const generatePreview = async () => {
    if (!goal.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.previewMission(group.id, goal.trim());
      setTitle(result.draft.title);
      setObjective(result.draft.objective);
      setTemplate(result.draft.template);
      setAcceptanceText(result.draft.acceptanceCriteria.join('\n'));
      setBlockingSeverities(result.draft.qualityPolicy.blockingSeverities);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成任务建议失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const createDraft = async () => {
    if (!title.trim() || !objective.trim() || acceptanceCriteria.length === 0 || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createMission(group.id, {
        title: title.trim(),
        objective: objective.trim(),
        template,
        acceptanceCriteria,
        qualityPolicy,
      });
      setDraft(result.mission);
      setTitle(result.mission.title);
      setObjective(result.mission.objective ?? '');
      setAcceptanceText((result.mission.acceptanceCriteria ?? []).join('\n'));
      setBlockingSeverities(result.mission.qualityPolicy?.blockingSeverities ?? ['blocker', 'major']);
      setResolutionByRole(defaultMissingResolutions(result.mission));
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成任务章程失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const saveCharter = async () => {
    if (!draft || !title.trim() || !objective.trim() || acceptanceCriteria.length === 0 || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.updateMissionCharter(group.id, draft.id, {
        title: title.trim(),
        objective: objective.trim(),
        acceptanceCriteria,
        qualityPolicy,
      });
      setDraft(result.mission);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存任务章程失败');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleBlockingSeverity = (severity: IssueSeverity, enabled: boolean) => {
    setBlockingSeverities(previous => {
      const next = enabled
        ? [...previous, severity]
        : previous.filter(item => item !== severity);
      return ['blocker', ...next.filter(item => item !== 'blocker')]
        .filter((item, index, all) => all.indexOf(item) === index) as IssueSeverity[];
    });
  };

  const resolveMissingPhase = async (phase: MissionPhase) => {
    if (!draft || submitting) return;
    const resolution = resolutionByRole[phase.roleId];
    const note = noteByRole[phase.roleId]?.trim() ?? '';
    if (!resolution || !note) {
      setError('缺岗决策必须选择处理方式，并写明原因和风险');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await api.resolveMissingRole(
        group.id,
        draft.id,
        phase.roleId,
        resolution,
        note,
      );
      setDraft(result.mission);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存缺岗决策失败');
    } finally {
      setSubmitting(false);
    }
  };

  const savePlan = async (roleIds: string[], autoMergeAuthorized = draft?.autoMergeAuthorized ?? false) => {
    if (!draft || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.updateMissionPlan(
        group.id,
        draft.id,
        roleIds,
        autoMergeAuthorized && roleIds.includes('role-committer'),
      );
      setDraft(result.mission);
      setResolutionByRole(defaultMissingResolutions(result.mission));
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存阶段计划失败');
    } finally {
      setSubmitting(false);
    }
  };

  const movePhase = (index: number, offset: -1 | 1) => {
    const roleIds = (draft?.phases ?? []).map(phase => phase.roleId);
    const target = index + offset;
    if (target < 0 || target >= roleIds.length) return;
    [roleIds[index], roleIds[target]] = [roleIds[target], roleIds[index]];
    void savePlan(roleIds);
  };

  const startMission = async () => {
    if (!draft || missingPhases.length > 0 || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.startMission(group.id, draft.id);
      onCreated(draft.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动任务失败，请稍后重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div
        className="max-h-[90vh] w-[600px] overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated shadow-panel scrollbar-thin"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">New mission</p>
          <h3 className="font-display text-lg font-bold text-content">创建协作主任务</h3>
          <p className="mt-1 text-sm text-content-subtle">先生成任务章程并处理缺岗，群主确认后才会启动 AI。</p>
        </div>

        {!draft ? (
          <div className="space-y-4 p-5">
            <div className="space-y-1.5 rounded-xl border border-accent/25 bg-accent/10 p-4">
              <label className="text-sm font-semibold text-content" htmlFor="mission-goal">用自然语言描述目标</label>
              <textarea
                id="mission-goal"
                autoFocus
                rows={3}
                value={goal}
                onChange={event => setGoal(event.target.value)}
                placeholder="例如：修复验证码错误时没有提示的问题，并确保密码登录不受影响"
                className={fieldClass}
              />
              <button
                type="button"
                onClick={generatePreview}
                disabled={!goal.trim() || submitting}
                className="rounded-lg border border-accent/30 px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-40"
              >
                {submitting ? '生成中…' : '从目标生成可编辑建议'}
              </button>
            </div>
            <div className="grid grid-cols-[1fr_190px] gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-content" htmlFor="mission-title">任务名称</label>
                <input
                  id="mission-title"
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  placeholder="例如：实现组内任务切换"
                  className={fieldClass}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-content" htmlFor="mission-template">任务模板</label>
                <select
                  id="mission-template"
                  value={template}
                  onChange={event => setTemplate(event.target.value as MissionTemplate)}
                  className={fieldClass}
                >
                  {TEMPLATES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-content" htmlFor="mission-objective">任务目标</label>
              <textarea
                id="mission-objective"
                rows={3}
                value={objective}
                onChange={event => setObjective(event.target.value)}
                placeholder="说明要解决的问题、期望结果与任务边界"
                className={fieldClass}
              />
            </div>
            <div className="space-y-2 rounded-xl border border-border bg-surface-muted p-3">
              <p className="text-sm font-semibold text-content">质量策略</p>
              <p className="text-xs text-content-subtle">blocker 永远阻断；选择本任务中还需阻断流转的问题等级。</p>
              {(['major', 'minor', 'suggestion'] as IssueSeverity[]).map(severity => (
                <label key={severity} className="flex items-center gap-2 text-xs text-content-muted">
                  <input
                    type="checkbox"
                    checked={blockingSeverities.includes(severity)}
                    onChange={event => toggleBlockingSeverity(severity, event.target.checked)}
                  />
                  {severity}
                </label>
              ))}
              <p className="text-xs text-content-subtle">会写入共享缓存、构建目录或设备状态的测试固定串行执行。</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-content" htmlFor="mission-acceptance">验收标准</label>
              <textarea
                id="mission-acceptance"
                rows={4}
                value={acceptanceText}
                onChange={event => setAcceptanceText(event.target.value)}
                placeholder="每行一条可验证的验收标准"
                className={fieldClass}
              />
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm text-content transition hover:bg-surface-hover">
                取消
              </button>
              <button
                type="button"
                onClick={createDraft}
                disabled={!title.trim() || !objective.trim() || acceptanceCriteria.length === 0 || submitting}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? '生成中…' : '生成任务章程'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 p-5">
            <div className="space-y-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">启动前确认</p>
              <input
                aria-label="草稿任务名称"
                value={title}
                onChange={event => setTitle(event.target.value)}
                className={fieldClass}
              />
              <textarea
                aria-label="草稿任务目标"
                rows={3}
                value={objective}
                onChange={event => setObjective(event.target.value)}
                className={fieldClass}
              />
              <textarea
                aria-label="草稿验收标准"
                rows={4}
                value={acceptanceText}
                onChange={event => setAcceptanceText(event.target.value)}
                className={fieldClass}
              />
              <div className="flex flex-wrap items-center gap-3 text-xs text-content-muted">
                <span>阻断等级：blocker</span>
                {(['major', 'minor', 'suggestion'] as IssueSeverity[]).map(severity => (
                  <label key={severity} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={blockingSeverities.includes(severity)}
                      onChange={event => toggleBlockingSeverity(severity, event.target.checked)}
                    />
                    {severity}
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={saveCharter}
                disabled={submitting || !title.trim() || !objective.trim() || acceptanceCriteria.length === 0}
                className="w-fit rounded-lg border border-accent/30 px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-40"
              >
                保存任务章程
              </button>
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold text-content">阶段计划</p>
              <div className="space-y-2">
                {(draft.phases ?? []).map((phase, index) => (
                  <div key={phase.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-muted px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-elevated font-mono text-xs text-content-subtle">{phase.order}</span>
                    <span className="min-w-0 flex-1 text-sm font-medium text-content">{phase.name}</span>
                    {group.members.filter(member => member.roleId === phase.roleId).length > 1 ? (
                      <select
                        aria-label={`${phase.name}任务 Leader`}
                        value={phase.leaderMemberId ?? ''}
                        disabled={submitting}
                        onChange={async event => {
                          setSubmitting(true);
                          setError('');
                          try {
                            const result = await api.setMissionRoleLeader(
                              group.id,
                              draft.id,
                              phase.roleId,
                              event.target.value,
                            );
                            setDraft(result.mission);
                          } catch (err) {
                            setError(err instanceof Error ? err.message : '修改任务 Leader 失败');
                          } finally {
                            setSubmitting(false);
                          }
                        }}
                        className="max-w-40 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-content outline-none"
                      >
                        {group.members
                          .filter(member => member.roleId === phase.roleId)
                          .map(member => (
                            <option key={member.id} value={member.id}>
                              {agents.find(agent => agent.id === member.agentId)?.name ?? member.agentId}
                            </option>
                          ))}
                      </select>
                    ) : null}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${
                      phase.status === 'missing'
                        ? 'bg-amber-500/15 text-amber-200'
                        : phase.status === 'waived'
                          ? 'bg-surface-elevated text-content-subtle'
                          : 'bg-mint/10 text-mint'
                    }`}
                    >
                      {phase.status === 'missing' ? '缺岗' : phase.status === 'waived' ? '已豁免' : '已配置 Leader'}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`上移${phase.name}阶段`}
                        disabled={submitting || index === 0}
                        onClick={() => movePhase(index, -1)}
                        className="rounded border border-border px-1.5 py-0.5 text-xs text-content-muted disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`下移${phase.name}阶段`}
                        disabled={submitting || index === (draft.phases?.length ?? 0) - 1}
                        onClick={() => movePhase(index, 1)}
                        className="rounded border border-border px-1.5 py-0.5 text-xs text-content-muted disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`移除${phase.name}阶段`}
                        disabled={submitting || (draft.phases?.length ?? 0) <= 1}
                        onClick={() => void savePlan(
                          (draft.phases ?? []).filter(item => item.id !== phase.id).map(item => item.roleId),
                          phase.roleId === 'role-committer' ? false : draft.autoMergeAuthorized,
                        )}
                        className="rounded border border-red-400/20 px-1.5 py-0.5 text-xs text-red-300 disabled:opacity-30"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <select
                  aria-label="添加阶段"
                  value={phaseToAdd}
                  onChange={event => setPhaseToAdd(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-xs text-content outline-none"
                >
                  <option value="">选择要追加的阶段</option>
                  {FIXED_PHASES
                    .filter(option => !(draft.phases ?? []).some(phase => phase.roleId === option.roleId))
                    .map(option => <option key={option.roleId} value={option.roleId}>{option.label}</option>)}
                </select>
                <button
                  type="button"
                  disabled={!phaseToAdd || submitting}
                  onClick={() => {
                    void savePlan([...(draft.phases ?? []).map(phase => phase.roleId), phaseToAdd]);
                    setPhaseToAdd('');
                  }}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-content disabled:opacity-40"
                >
                  追加阶段
                </button>
              </div>
              {(draft.phases ?? []).some(phase => phase.roleId === 'role-committer') ? (
                <label className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-content-muted">
                  <input
                    type="checkbox"
                    checked={draft.autoMergeAuthorized === true}
                    disabled={submitting}
                    onChange={event => void savePlan(
                      (draft.phases ?? []).map(phase => phase.roleId),
                      event.target.checked,
                    )}
                    className="mt-0.5"
                  />
                  <span>所有质量门禁通过后，预授权提交专员合并 PR；未勾选时只创建 Draft PR 并等待群主。</span>
                </label>
              ) : null}
            </div>

            {missingPhases.map(phase => {
              const options = MISSING_ROLE_OPTIONS[phase.roleId] ?? [];
              return (
                <div key={phase.id} className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-sm font-semibold text-amber-100">{phase.name}角色缺岗</p>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-content-muted" htmlFor={`missing-resolution-${phase.roleId}`}>{phase.name}缺岗处理</label>
                    <select
                      id={`missing-resolution-${phase.roleId}`}
                      value={resolutionByRole[phase.roleId] ?? options[0]?.value ?? ''}
                      onChange={event => setResolutionByRole(prev => ({
                        ...prev,
                        [phase.roleId]: event.target.value as MissingRoleResolution,
                      }))}
                      className={fieldClass}
                    >
                      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-content-muted" htmlFor={`missing-note-${phase.roleId}`}>{phase.name}缺岗说明</label>
                    <textarea
                      id={`missing-note-${phase.roleId}`}
                      rows={2}
                      value={noteByRole[phase.roleId] ?? ''}
                      onChange={event => setNoteByRole(prev => ({ ...prev, [phase.roleId]: event.target.value }))}
                      placeholder="说明原因、替代方案与群主承担的风险"
                      className={fieldClass}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => resolveMissingPhase(phase)}
                    disabled={submitting || !(noteByRole[phase.roleId]?.trim())}
                    className="rounded-lg border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/10 disabled:opacity-50"
                  >
                    确认{phase.name}缺岗决策
                  </button>
                </div>
              );
            })}

            {missingPhases.length === 0 ? (
              <div className="rounded-xl border border-mint/25 bg-mint/10 px-3 py-2 text-sm text-mint">所有缺岗均已处理，可以由群主明确启动。</div>
            ) : null}

            <div className="flex justify-between gap-3">
              <button type="button" onClick={() => onCreated(draft.id)} className="rounded-xl border border-border px-4 py-2 text-sm text-content-muted transition hover:bg-surface-hover">
                保存草稿并关闭
              </button>
              <button
                type="button"
                onClick={startMission}
                disabled={missingPhases.length > 0 || submitting}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? '启动中…' : '确认并启动'}
              </button>
            </div>
          </div>
        )}

        {error ? (
          <div className="mx-5 mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{error}</div>
        ) : null}
      </div>
    </div>
  );
}
