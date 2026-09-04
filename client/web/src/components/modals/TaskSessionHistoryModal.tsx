import { useMemo } from 'react';
import { useAppStore } from '../../hooks/useStore';
import type { AgentGroup } from '../../types';

interface Props {
  group: AgentGroup;
  onClose: () => void;
  onSelectTask: (taskSessionId: string) => void;
}

function formatSessionTime(ts: number) {
  const date = new Date(ts * 1000);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskSessionHistoryModal({ group, onClose, onSelectTask }: Props) {
  const { taskSessions, selectedTaskSessionIdByGroup } = useAppStore();
  const selectedTaskSessionId = selectedTaskSessionIdByGroup[group.id] ?? group.activeTaskSessionId ?? null;
  const rows = useMemo(
    () => taskSessions
      .filter(session => session.groupId === group.id)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt),
    [taskSessions, group.id],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div className="max-h-[80vh] w-[460px] overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated shadow-panel scrollbar-thin" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">Task history</p>
          <h3 className="font-display text-lg font-bold text-content">历史任务</h3>
          <p className="mt-1 text-sm text-content-subtle">历史任务可查看但不可继续对话。</p>
        </div>

        <div className="space-y-3 p-5">
          {rows.length === 0 && (
            <div className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-content-subtle">
              当前群组还没有任务记录。
            </div>
          )}

          {rows.map(session => {
            const isSelected = session.id === selectedTaskSessionId;
            const isActive = session.id === group.activeTaskSessionId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelectTask(session.id)}
                className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                  isSelected
                    ? 'border-accent/40 bg-accent/10'
                    : 'border-border bg-surface-muted hover:border-border-strong hover:bg-surface-hover'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-content">{session.title}</div>
                    <div className="mt-1 text-xs text-content-subtle">
                      创建于 {formatSessionTime(session.createdAt)}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                    isActive
                      ? 'border-accent/25 bg-accent/10 text-accent'
                      : 'border-border bg-surface-elevated text-content-subtle'
                  }`}
                  >
                    {isActive ? '当前任务' : '历史只读'}
                  </span>
                </div>
              </button>
            );
          })}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-border px-4 py-2 text-sm text-content transition hover:border-border-strong hover:bg-surface-hover"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
