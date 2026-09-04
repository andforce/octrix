import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../hooks/useStore';
import { api } from '../lib/api';
import type { AgentStartupPrompt, AgentStartupPromptAction } from '../types';

const POLL_INTERVAL_MS = 750;

export function AgentStartupPromptDialog() {
  const { groups, runningAgentIdsByGroup } = useAppStore();
  const [prompts, setPrompts] = useState<AgentStartupPrompt[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const loadPrompts = useCallback(async () => {
    try {
      const response = await api.getAgentStartupPrompts();
      setPrompts(response.prompts);
    } catch {
      // Hosts predating the unified startup-prompt API expose workspace trust
      // per group. Keep newer Web clients usable while that Host is upgraded.
      const runningGroups = groups.filter(group => (
        (runningAgentIdsByGroup[group.id] ?? []).length > 0
      ));
      const legacyPrompts = await Promise.all(runningGroups.map(async group => {
        try {
          return (await api.getWorkspaceTrustPrompts(group.id)).prompts;
        } catch {
          return [];
        }
      }));
      setPrompts(legacyPrompts.flat());
    }
  }, [groups, runningAgentIdsByGroup]);

  useEffect(() => {
    void loadPrompts();
    const timer = window.setInterval(() => void loadPrompts(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadPrompts]);

  const prompt = prompts[0];
  if (!prompt) return null;

  const isBypassPermissions = prompt.kind === 'bypass-permissions';
  const groupName = groups.find(group => group.id === prompt.groupId)?.name;
  const title = isBypassPermissions ? '确认 Bypass Permissions 模式' : '确认工作目录信任';
  const description = isBypassPermissions
    ? `${prompt.agentName} 首次启用 Bypass Permissions 模式，需要你明确确认。该模式下，Claude Code 执行潜在危险命令前不会再请求批准。`
    : `${prompt.agentName} 需要确认是否信任工作目录。仅在目录内容可信时继续。`;

  const resolvePrompt = async (action: AgentStartupPromptAction) => {
    if (isResolving) return;
    setIsResolving(true);
    setErrorMessage('');
    try {
      try {
        await api.resolveAgentStartupPrompts(prompt.groupId, action, [prompt.agentId]);
      } catch (error) {
        if (prompt.kind !== 'workspace-trust') throw error;
        if (action === 'accept') {
          await api.confirmWorkspaceTrust(prompt.groupId, [prompt.agentId]);
        } else {
          const group = groups.find(candidate => candidate.id === prompt.groupId);
          const member = group?.members.find(candidate => candidate.agentId === prompt.agentId);
          if (!member) throw error;
          await api.goOffline(prompt.groupId, member.id);
        }
      }
      await loadPrompts();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '处理启动确认失败');
    } finally {
      setIsResolving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/65 px-4 backdrop-blur-md">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="agent-startup-prompt-title"
        aria-describedby="agent-startup-prompt-description"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-amber-400/35 bg-surface-elevated shadow-panel"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">Claude Code · Security guide</p>
            <h2 id="agent-startup-prompt-title" className="mt-0.5 text-lg font-bold text-content">{title}</h2>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p id="agent-startup-prompt-description" className="text-sm leading-6 text-content-muted">{description}</p>
          {isBypassPermissions ? (
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2.5 text-xs leading-5 text-amber-100">
              仅建议在网络受限、可轻松恢复的沙箱或虚拟机中使用。继续即表示你接受该模式下操作产生的风险。
            </p>
          ) : (
            <p className="rounded-xl border border-border bg-surface-muted px-3 py-2 font-mono text-xs text-content-muted">
              {prompt.directory}
            </p>
          )}
          {groupName ? <p className="text-xs text-content-subtle">会话：{groupName}</p> : null}
          {errorMessage ? <p className="text-xs text-red-400">{errorMessage}</p> : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            autoFocus
            disabled={isResolving}
            onClick={() => void resolvePrompt('decline')}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-content-muted transition hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-300 disabled:opacity-50"
          >
            退出 {prompt.agentName}
          </button>
          <button
            type="button"
            disabled={isResolving}
            onClick={() => void resolvePrompt('accept')}
            className="rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-50"
          >
            {isResolving ? '处理中…' : isBypassPermissions ? '我了解风险，继续' : '信任并继续'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
