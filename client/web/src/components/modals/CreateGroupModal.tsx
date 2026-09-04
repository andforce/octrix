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
import { findGroupWithSameWorkingDirectory } from '../../lib/workingDirectoryPath';

interface AssignedMember {
  key: string;
  agentRef: string;
  roleId: string;
}

interface AgentOption {
  value: string;
  label: string;
  platform: AgentPlatform;
  logoUrl?: string;
}

interface Props {
  onClose: () => void;
}

/** 从工作目录路径取末级文件夹名，用作默认群名称 */
function directoryBasename(dir: string): string {
  const normalized = dir.trim().replace(/[/\\]+$/, '');
  if (!normalized) return '';
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return normalized;
  return segments[segments.length - 1] ?? normalized;
}

export function CreateGroupModal({ onClose }: Props) {
  const { agents, roles, platformInstallState, groups } = useAppStore();
  const [groupName, setGroupName] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [pickerMessage, setPickerMessage] = useState('');
  const [assignedMembers, setAssignedMembers] = useState<AssignedMember[]>([]);
  const [leaderKeyByRole, setLeaderKeyByRole] = useState<Record<string, string>>({});
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [selectedAgentRef, setSelectedAgentRef] = useState('');
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

  const availableAgents = useMemo<AgentOption[]>(() => (
    ENABLED_AGENTS.flatMap((supported): AgentOption[] => {
      const installed = platformInstallState?.[supported.platform]
        || agents.some(a => a.platform === supported.platform);
      if (!installed) return [];
      return [{
        value: `platform:${supported.platform}`,
        label: supported.name,
        platform: supported.platform,
        logoUrl: getSupportedAgent(supported.platform).logoUrl,
      }];
    })
  ), [agents, platformInstallState]);

  const availableAgentMap = useMemo(
    () => new Map(availableAgents.map(agent => [agent.value, agent])),
    [availableAgents],
  );

  const selectedAgentOption = selectedAgentRef ? availableAgentMap.get(selectedAgentRef) : undefined;

  const selectedRole = selectedRoleId ? roles.find(r => r.id === selectedRoleId) : undefined;

  const workingDirectoryConflict = useMemo(
    () => (workingDirectory.trim()
      ? findGroupWithSameWorkingDirectory(
        groups.filter(group => group.groupType === 'collaboration'),
        workingDirectory,
      )
      : undefined),
    [groups, workingDirectory],
  );

  const comboboxButtonClass =
    'flex w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-surface-muted px-2 py-1.5 text-left text-sm text-content outline-none transition hover:border-border-strong focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60';

  useLayoutEffect(() => {
    if (!roleMenuOpen || isCreating) {
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
  }, [roleMenuOpen, isCreating]);

  useLayoutEffect(() => {
    if (!agentMenuOpen || isCreating) {
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
  }, [agentMenuOpen, isCreating]);

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

  const addMember = () => {
    if (!selectedRoleId || !selectedAgentRef) return;
    if (
      selectedRoleId === 'role-committer'
      && assignedMembers.some(member => member.roleId === 'role-committer')
    ) {
      setCreateError('每个群最多只能有一个提交专员');
      return;
    }
    const key = `${Date.now()}-${Math.random()}`;
    setAssignedMembers(prev => [
      ...prev,
      { key, agentRef: selectedAgentRef, roleId: selectedRoleId },
    ]);
    setLeaderKeyByRole(prev => (
      prev[selectedRoleId] ? prev : { ...prev, [selectedRoleId]: key }
    ));
    setCreateError('');
    setSelectedRoleId('');
    setSelectedAgentRef('');
  };

  const removeMember = (key: string) => {
    setAssignedMembers(prev => {
      const removed = prev.find(member => member.key === key);
      const next = prev.filter(member => member.key !== key);
      if (removed) {
        setLeaderKeyByRole(leaders => {
          if (leaders[removed.roleId] !== key) return leaders;
          const replacement = next.find(member => member.roleId === removed.roleId);
          const updated = { ...leaders };
          if (replacement) updated[removed.roleId] = replacement.key;
          else delete updated[removed.roleId];
          return updated;
        });
      }
      return next;
    });
  };

  const handlePickDirectory = async () => {
    if (isPickingDirectory) return;

    setIsPickingDirectory(true);
    setPickerMessage('');

    try {
      const payload = await api.pickDirectory();
      if (payload.path) {
        const conflict = findGroupWithSameWorkingDirectory(
          groups.filter(group => group.groupType === 'collaboration'),
          payload.path,
        );
        if (conflict) {
          setPickerMessage(`该工作目录已被协作群「${conflict.name}」使用，请选择其他目录`);
          return;
        }
        setWorkingDirectory(payload.path);
        return;
      }
      if (!payload.canceled) {
        setPickerMessage(payload.message ?? '选择工作目录失败，请稍后重试');
      }
    } catch (error) {
      setPickerMessage(error instanceof Error ? error.message : '选择工作目录失败，请稍后重试');
    } finally {
      setIsPickingDirectory(false);
    }
  };

  const handleCreate = async () => {
    const directory = workingDirectory.trim();
    const name = groupName.trim() || directoryBasename(directory);
    if (!name || assignedMembers.length < 2 || !directory || isCreating) return;
    const conflict = findGroupWithSameWorkingDirectory(
      groups.filter(group => group.groupType === 'collaboration'),
      directory,
    );
    if (conflict) {
      setCreateError(`该工作目录已被协作群「${conflict.name}」使用，请选择其他目录`);
      return;
    }
    setIsCreating(true);
    setCreateError('');

    try {
      const colorPool = ['blue', 'green', 'orange', 'purple', 'pink', 'red', 'teal', 'indigo', 'mint', 'cyan'];
      const members: { agentId: string; roleId: string }[] = [];
      const agentIdByMemberKey = new Map<string, string>();
      for (let i = 0; i < assignedMembers.length; i++) {
        const member = assignedMembers[i];
        const option = availableAgentMap.get(member.agentRef);
        if (!option) {
          throw new Error('选中的 Agent 不存在，请重新选择');
        }
        const color = colorPool[i % colorPool.length];
        const createdAgent = await api.addAgent(option.platform, color);
        members.push({ agentId: createdAgent.id, roleId: member.roleId });
        agentIdByMemberKey.set(member.key, createdAgent.id);
      }

      const roleLeaders: Record<string, string> = {};
      for (const roleId of new Set(assignedMembers.map(member => member.roleId))) {
        const roleMembers = assignedMembers.filter(member => member.roleId === roleId);
        if (roleMembers.length < 2) continue;
        const leaderKey = leaderKeyByRole[roleId];
        const leaderAgentId = leaderKey ? agentIdByMemberKey.get(leaderKey) : undefined;
        if (!leaderAgentId) throw new Error(`请为${roles.find(role => role.id === roleId)?.name ?? roleId}指定 Leader`);
        roleLeaders[roleId] = leaderAgentId;
      }

      await api.createGroup({
        name,
        ownerName: '群主',
        members,
        workingDirectory: directory,
        groupType: 'collaboration',
        roleLeaders,
      });
      onClose();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建群组失败，请稍后重试');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div className="max-h-[90vh] w-[440px] overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated shadow-panel scrollbar-thin" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">New group</p>
          <h3 className="font-display text-lg font-bold text-content">创建群组</h3>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={handlePickDirectory}
              disabled={isPickingDirectory}
              className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface-muted/80 px-3 py-2.5 text-left transition hover:border-border-strong hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg className="h-4 w-4 flex-shrink-0 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className={`min-w-0 flex-1 truncate font-mono text-sm ${workingDirectory ? 'text-content' : 'text-content-subtle'}`}>
                {workingDirectory || '点击选择工作目录'}
              </span>
              <span className="whitespace-nowrap text-xs font-medium text-accent">
                {isPickingDirectory ? '选择中...' : '选择文件夹'}
              </span>
            </button>
            {pickerMessage ? (
              <p className="text-xs text-red-400">{pickerMessage}</p>
            ) : null}
            {workingDirectoryConflict && !pickerMessage ? (
              <p className="text-xs text-red-400">
                该工作目录已被协作群「{workingDirectoryConflict.name}」使用，请选择其他目录
              </p>
            ) : null}
          </div>

          <input
            type="text"
            placeholder="群名称（可选，留空则使用文件夹名）"
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-muted/90 px-3 py-2.5 text-sm text-content outline-none ring-accent/0 transition focus:border-accent/40 focus:ring-2 focus:ring-accent/25"
          />

          {/* Team builder */}
          <div>
            <p className="mb-2 text-sm font-semibold text-content-muted">团队组建</p>

            {assignedMembers.map((m, memberIndex) => {
              const roleName = roles.find(r => r.id === m.roleId)?.name ?? '?';
              const agentName = availableAgentMap.get(m.agentRef)?.label ?? '?';
              const opt = availableAgentMap.get(m.agentRef);
              const logoUrl = opt?.logoUrl;
              const logoImgClass = opt ? agentLogoImageClassName(opt.platform) : '';
              const roleMemberCount = assignedMembers.filter(member => member.roleId === m.roleId).length;
              const isLeader = leaderKeyByRole[m.roleId] === m.key;
              return (
                <div key={m.key} className="mb-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-muted/60 px-3 py-2 text-sm">
                  <span className="text-content-muted">{roleName}</span>
                  <svg className="h-3 w-3 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {logoUrl && opt ? (
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-muted shadow-sm">
                      <img src={logoUrl} alt="" className={logoImgClass} />
                    </span>
                  ) : null}
                  <span className="font-medium text-content">{agentName}</span>
                  <div className="flex-1" />
                  {roleMemberCount > 1 ? (
                    <button
                      type="button"
                      aria-label={`设为${roleName} Leader（成员 ${memberIndex + 1}）`}
                      onClick={() => setLeaderKeyByRole(prev => ({ ...prev, [m.roleId]: m.key }))}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                        isLeader
                          ? 'border-accent/40 bg-accent-muted text-accent'
                          : 'border-border text-content-subtle hover:border-border-strong hover:text-content'
                      }`}
                    >
                      {isLeader ? 'Leader' : '设为 Leader'}
                    </button>
                  ) : (
                    <span className="rounded-lg bg-surface-hover px-2 py-1 text-[11px] font-medium text-content-subtle">
                      唯一成员
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`移除${roleName}成员 ${memberIndex + 1}`}
                    onClick={() => removeMember(m.key)}
                    className="text-content-subtle transition hover:text-red-400"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}

            {availableAgents.length === 0 ? (
              <p className="py-4 text-center text-xs text-content-subtle">请先添加 AI Agent</p>
            ) : (
              <div className="mt-2 flex gap-2">
                <div ref={rolePickerRef} className="relative min-w-0 flex-1">
                  <button
                    ref={roleComboButtonRef}
                    type="button"
                    role="combobox"
                    aria-expanded={roleMenuOpen}
                    aria-haspopup="listbox"
                    aria-label="选择角色"
                    disabled={isCreating}
                    onClick={() => {
                      if (isCreating) return;
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
                  {roleMenuOpen && !isCreating && roleMenuPos
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
                    disabled={isCreating}
                    onClick={() => {
                      if (isCreating) return;
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
                  {agentMenuOpen && !isCreating && agentMenuPos
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
                        {availableAgents.map(agent => (
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
                  onClick={addMember}
                  disabled={!selectedRoleId || !selectedAgentRef}
                  className="rounded-xl px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent-muted disabled:opacity-50"
                >
                  添加
                </button>
              </div>
            )}
            {createError ? (
              <p className="mt-2 text-xs text-red-400">{createError}</p>
            ) : null}
            {assignedMembers.length === 1 ? (
              <p className="mt-2 text-xs text-amber-300">群聊至少需要 2 个 AI；只有 1 个 AI 时请创建单聊。</p>
            ) : null}
          </div>
        </div>

        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-content"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={
              assignedMembers.length < 2
              || !workingDirectory.trim()
              || !!workingDirectoryConflict
              || isCreating
            }
            className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {isCreating ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
