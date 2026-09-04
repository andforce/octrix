import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  agentLogoImageClassName,
  ENABLED_AGENTS,
  getSupportedAgent,
  type AgentPlatform,
} from '../../agent-platforms';
import { useAppStore } from '../../hooks/useStore';
import { api } from '../../lib/api';
import { getAgentPresence } from '../../lib/agentStatus';
import type { AgentGroup } from '../../types';
import { GroupMemberRowItem } from '../GroupMemberRowItem';

interface AgentOption {
  value: string;
  label: string;
  platform: AgentPlatform;
  logoUrl?: string;
}

interface Props {
  group: AgentGroup;
  onClose: () => void;
}

export function GroupMembersModal({ group, onClose }: Props) {
  const {
    agents,
    roles,
    runningAgentIdsByGroup,
    busyAgentIdsByGroup,
    initializingByGroup,
    streamingByGroup,
    agentErrorsByGroup,
    platformInstallState,
  } = useAppStore();
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [selectedAgentRef, setSelectedAgentRef] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [roleMenuPos, setRoleMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [agentMenuPos, setAgentMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rolePickerRef = useRef<HTMLDivElement>(null);
  const roleComboButtonRef = useRef<HTMLButtonElement>(null);
  const roleMenuPortalRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const agentComboButtonRef = useRef<HTMLButtonElement>(null);
  const agentMenuPortalRef = useRef<HTMLDivElement>(null);

  const agentOptions = useMemo((): AgentOption[] => {
    const options: AgentOption[] = [];
    for (const supported of ENABLED_AGENTS) {
      if (platformInstallState?.[supported.platform] || agents.some(a => a.platform === supported.platform)) {
        const def = getSupportedAgent(supported.platform);
        options.push({
          value: supported.platform,
          label: supported.name,
          platform: supported.platform,
          logoUrl: def.logoUrl,
        });
      }
    }
    return options;
  }, [agents, platformInstallState]);

  const selectedAgentOption = selectedAgentRef
    ? agentOptions.find(o => o.value === selectedAgentRef)
    : undefined;

  const selectedRole = selectedRoleId ? roles.find(r => r.id === selectedRoleId) : undefined;

  const comboboxButtonClass =
    'flex w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-surface-muted px-2 py-1.5 text-left text-sm text-content outline-none transition hover:border-border-strong focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60';

  useLayoutEffect(() => {
    if (!roleMenuOpen || isAdding) {
      setRoleMenuPos(null);
      return;
    }
    const update = () => {
      const el = roleComboButtonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRoleMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    const btn = roleComboButtonRef.current;
    if (btn && ro) ro.observe(btn);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [roleMenuOpen, isAdding]);

  useLayoutEffect(() => {
    if (!agentMenuOpen || isAdding) {
      setAgentMenuPos(null);
      return;
    }
    const update = () => {
      const el = agentComboButtonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAgentMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    const btn = agentComboButtonRef.current;
    if (btn && ro) ro.observe(btn);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [agentMenuOpen, isAdding]);

  useEffect(() => {
    if (!agentMenuOpen && !roleMenuOpen) return;
    const handle = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rolePickerRef.current?.contains(t) || roleMenuPortalRef.current?.contains(t)) return;
      if (agentPickerRef.current?.contains(t) || agentMenuPortalRef.current?.contains(t)) return;
      setAgentMenuOpen(false);
      setRoleMenuOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [agentMenuOpen, roleMenuOpen]);

  const handleAdd = async () => {
    if (!selectedAgentRef || !selectedRoleId || isAdding) return;
    setIsAdding(true);
    setErrorMessage('');
    try {
      const created = await api.addAgent(selectedAgentRef as AgentPlatform, 'blue');
      await api.addMember(group.id, created.id, selectedRoleId);
      setSelectedRoleId('');
      setSelectedAgentRef('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '添加失败');
    } finally {
      setIsAdding(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div className="flex max-h-[80vh] w-[440px] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-panel" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">Members</p>
          <h3 className="font-display text-lg font-bold text-content">群成员管理</h3>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {errorMessage && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {errorMessage}
            </div>
          )}

          {/* Current members */}
          <div>
            <p className="mb-2 text-sm font-semibold text-content-muted">当前成员</p>

            {/* Owner */}
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2">
              <svg className="h-4 w-4 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2L13.09 8.26L20 9.27L15 14.14L16.18 21.02L10 17.77L3.82 21.02L5 14.14L0 9.27L6.91 8.26L10 2Z" />
              </svg>
              <span className="text-sm text-content">群主({group.ownerName})</span>
            </div>

            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {group.members.map(member => {
                const groupPresenceCtx = {
                  runningAgentIds: runningAgentIdsByGroup[group.id] ?? [],
                  initializingAgentIds: initializingByGroup[group.id] ?? [],
                  busyAgentIds: busyAgentIdsByGroup?.[group.id] ?? [],
                  streamingAgentNames: streamingByGroup[group.id] ?? [],
                  agentErrors: agentErrorsByGroup[group.id] ?? {},
                };
                return (
                  <GroupMemberRowItem
                    key={member.id}
                    member={member}
                    group={group}
                    agents={agents}
                    roles={roles}
                    compact
                    presenceState={getAgentPresence(
                      agents.find(agent => agent.id === member.agentId),
                      groupPresenceCtx,
                    )}
                    presenceDetail={groupPresenceCtx.agentErrors[member.agentId]}
                  />
                );
              })}
            </div>
          </div>

          {/* Add member */}
          {agentOptions.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold text-content-muted">添加成员</p>
              <div className="flex gap-2">
                <div ref={rolePickerRef} className="relative min-w-0 flex-1">
                  <button
                    ref={roleComboButtonRef}
                    type="button"
                    role="combobox"
                    aria-expanded={roleMenuOpen}
                    aria-haspopup="listbox"
                    aria-label="选择角色"
                    disabled={isAdding}
                    onClick={() => {
                      if (isAdding) return;
                      setAgentMenuOpen(false);
                      setRoleMenuOpen(o => !o);
                    }}
                    className={comboboxButtonClass}
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-border/80 bg-surface-muted/80" aria-hidden>
                      <svg className="h-3.5 w-3.5 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                    </span>
                    <span className={`min-w-0 flex-1 truncate ${selectedRole ? 'text-content' : 'text-content-subtle'}`}>
                      {selectedRole?.name ?? '选择角色'}
                    </span>
                    <svg
                      className={`h-4 w-4 flex-shrink-0 text-content-subtle transition ${roleMenuOpen ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {roleMenuOpen && !isAdding && roleMenuPos
                    ? createPortal(
                      <div
                        ref={roleMenuPortalRef}
                        role="listbox"
                        aria-label="角色列表"
                        style={{
                          position: 'fixed',
                          top: roleMenuPos.top,
                          left: roleMenuPos.left,
                          width: roleMenuPos.width,
                          zIndex: 100,
                        }}
                        className="scrollbar-thin max-h-56 overflow-y-auto rounded-xl border border-border-strong bg-surface-elevated py-1 shadow-panel"
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={selectedRoleId === ''}
                          className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:bg-surface-hover ${
                            selectedRoleId === '' ? 'bg-accent-muted/50 text-content' : 'text-content-subtle'
                          }`}
                          onClick={() => {
                            setSelectedRoleId('');
                            setRoleMenuOpen(false);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">选择角色</span>
                        </button>
                        {roles.map(r => (
                          <button
                            key={r.id}
                            type="button"
                            role="option"
                            aria-selected={selectedRoleId === r.id}
                            className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:bg-surface-hover ${
                              selectedRoleId === r.id ? 'bg-accent-muted/50' : ''
                            }`}
                            onClick={() => {
                              setSelectedRoleId(r.id);
                              setRoleMenuOpen(false);
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate font-medium text-content">{r.name}</span>
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )
                    : null}
                </div>
                <div ref={agentPickerRef} className="relative min-w-0 flex-1">
                  <button
                    ref={agentComboButtonRef}
                    type="button"
                    role="combobox"
                    aria-expanded={agentMenuOpen}
                    aria-haspopup="listbox"
                    aria-label="选择 Agent"
                    disabled={isAdding}
                    onClick={() => {
                      if (isAdding) return;
                      setRoleMenuOpen(false);
                      setAgentMenuOpen(o => !o);
                    }}
                    className={comboboxButtonClass}
                  >
                    {selectedAgentOption?.logoUrl ? (
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-muted">
                        <img
                          src={selectedAgentOption.logoUrl}
                          alt=""
                          className={agentLogoImageClassName(selectedAgentOption.platform)}
                        />
                      </span>
                    ) : (
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-border/80 bg-surface-muted/80" aria-hidden>
                        <svg className="h-3.5 w-3.5 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      </span>
                    )}
                    <span className={`min-w-0 flex-1 truncate ${selectedAgentOption ? 'text-content' : 'text-content-subtle'}`}>
                      {selectedAgentOption?.label ?? '选择 Agent'}
                    </span>
                    <svg
                      className={`h-4 w-4 flex-shrink-0 text-content-subtle transition ${agentMenuOpen ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {agentMenuOpen && !isAdding && agentMenuPos
                    ? createPortal(
                      <div
                        ref={agentMenuPortalRef}
                        role="listbox"
                        aria-label="CLI 列表"
                        style={{
                          position: 'fixed',
                          top: agentMenuPos.top,
                          left: agentMenuPos.left,
                          width: agentMenuPos.width,
                          zIndex: 100,
                        }}
                        className="scrollbar-thin max-h-56 overflow-y-auto rounded-xl border border-border-strong bg-surface-elevated py-1 shadow-panel"
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={selectedAgentRef === ''}
                          className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:bg-surface-hover ${
                            selectedAgentRef === '' ? 'bg-accent-muted/50 text-content' : 'text-content-subtle'
                          }`}
                          onClick={() => {
                            setSelectedAgentRef('');
                            setAgentMenuOpen(false);
                          }}
                        >
                          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-border/70 bg-surface-muted" aria-hidden />
                          <span>选择 Agent</span>
                        </button>
                        {agentOptions.map(agent => (
                          <button
                            key={agent.value}
                            type="button"
                            role="option"
                            aria-selected={selectedAgentRef === agent.value}
                            className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition hover:bg-surface-hover ${
                              selectedAgentRef === agent.value ? 'bg-accent-muted/50' : ''
                            }`}
                            onClick={() => {
                              setSelectedAgentRef(agent.value);
                              setAgentMenuOpen(false);
                            }}
                          >
                            {agent.logoUrl ? (
                              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-muted">
                                <img src={agent.logoUrl} alt="" className={agentLogoImageClassName(agent.platform)} />
                              </span>
                            ) : (
                              <span className="flex h-6 w-6 flex-shrink-0 rounded-full bg-surface-hover" aria-hidden />
                            )}
                            <span className="min-w-0 flex-1 truncate font-medium text-content">{agent.label}</span>
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )
                    : null}
                </div>
                <button
                  onClick={handleAdd}
                  disabled={!selectedRoleId || !selectedAgentRef || isAdding}
                  className="rounded-xl px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isAdding ? '拉入中...' : '拉入群'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="w-full rounded-xl py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-content"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
