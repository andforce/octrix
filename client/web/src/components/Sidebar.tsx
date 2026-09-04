import { useState, useMemo, useEffect } from 'react';
import { useAppStore, useAppDispatch } from '../hooks/useStore';
import type { Agent, AgentGroup, Envelope } from '../types';
import { api } from '../lib/api';
import { getAgentPresence, getGroupPresence } from '../lib/agentStatus';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { AgentPresenceIndicator } from './AgentPresenceIndicator';
import { GroupMemberRowItem } from './GroupMemberRowItem';
import { GroupMembersModal } from './modals/GroupMembersModal';

const COLLABORATION_GROUP_BACKGROUNDS = [
  'linear-gradient(145deg, #38bdf8, #2563eb)',
  'linear-gradient(145deg, #22d3ee, #0f766e)',
  'linear-gradient(145deg, #818cf8, #4f46e5)',
  'linear-gradient(145deg, #2dd4bf, #0f766e)',
  'linear-gradient(145deg, #67e8f9, #0891b2)',
  'linear-gradient(145deg, #a78bfa, #5b21b6)',
  'linear-gradient(145deg, #7dd3fc, #1d4ed8)',
  'linear-gradient(145deg, #5eead4, #0d9488)',
] as const;

const DIRECT_CHAT_BACKGROUNDS = [
  'linear-gradient(145deg, #fb7185, #dc2626)',
  'linear-gradient(145deg, #f59e0b, #ea580c)',
  'linear-gradient(145deg, #c084fc, #7c3aed)',
  'linear-gradient(145deg, #34d399, #059669)',
  'linear-gradient(145deg, #f472b6, #be185d)',
  'linear-gradient(145deg, #fcd34d, #b45309)',
  'linear-gradient(145deg, #a78bfa, #6d28d9)',
  'linear-gradient(145deg, #4ade80, #166534)',
] as const;

/** FNV-1a：对 UUID 等字符串的分布优于 Java String.hashCode，减少侧边栏群组头像撞色 */
function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getGroupAvatarBackground(group: AgentGroup): string {
  const palette = group.groupType === 'direct'
    ? DIRECT_CHAT_BACKGROUNDS
    : COLLABORATION_GROUP_BACKGROUNDS;
  return palette[fnv1a32(group.id) % palette.length];
}

interface SidebarProps {
  onShowCreateGroup: () => void;
  onShowContacts: () => void;
  onShowRelayConnect: () => void;
}

export function Sidebar({ onShowCreateGroup, onShowContacts, onShowRelayConnect }: SidebarProps) {
  const {
    groups,
    messages,
    runningAgentIdsByGroup,
    isRunning,
    port,
    selectedGroupId,
  } = useAppStore();
  const dispatch = useAppDispatch();
  const [searchText, setSearchText] = useState('');
  /** 与选中群组同步：切换会话时默认展开该群成员，且同时只展开一个群组 */
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(selectedGroupId);

  useEffect(() => {
    setExpandedGroupId(selectedGroupId);
  }, [selectedGroupId]);

  const filteredGroups = useMemo(() => {
    if (!searchText) return groups;
    const q = searchText.toLowerCase();
    return groups.filter(g => g.name.toLowerCase().includes(q));
  }, [groups, searchText]);

  return (
    <div className="relative flex h-full flex-col border-r border-border bg-surface-elevated/95 shadow-insetHighlight backdrop-blur-xl before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-gradient-to-b before:from-accent/80 before:via-mint/35 before:to-accent/20">
      {/* Header */}
      <div className="space-y-3 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">
              Octrix Host
            </p>
            <h1 className="font-display text-lg font-bold tracking-tight text-content">协调台</h1>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface-muted/80 px-2.5 py-1">
            <span
              className={`h-2 w-2 rounded-full shadow-[0_0_8px_currentColor] ${isRunning ? 'bg-mint text-mint' : 'bg-red-500 text-red-500'}`}
            />
            <span className="font-mono text-[11px] text-content-muted">:{port}</span>
          </div>
        </div>
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="搜索会话…"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface-muted/90 py-2 pl-9 pr-3 text-sm text-content placeholder:text-content-subtle outline-none ring-accent/0 transition focus:border-accent/40 focus:ring-2 focus:ring-accent/25"
          />
        </div>
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />

      {/* Group list */}
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {filteredGroups.map(group => (
          <ConversationRow
            key={group.id}
            group={group}
            lastMessage={messages.filter(m => m.groupId === group.id).at(-1)}
            membersExpanded={expandedGroupId === group.id}
            onToggleMembersExpanded={() => {
              setExpandedGroupId(prev => (prev === group.id ? null : group.id));
            }}
            onClick={() => {
              dispatch({ type: 'SELECT_GROUP', payload: group.id });
              setExpandedGroupId(group.id);
            }}
            onDelete={async () => {
              await api.removeGroup(group.id);
            }}
          />
        ))}
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />

      {/* Footer */}
      <div className="grid grid-cols-3 gap-2 px-4 py-3">
        <button
          onClick={onShowCreateGroup}
          className="group flex items-center justify-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-accent"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-muted text-accent transition group-hover:border-accent/35 group-hover:shadow-glow">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </span>
          建群
        </button>
        <button
          onClick={onShowRelayConnect}
          className="group flex items-center justify-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-mint"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-muted text-mint transition group-hover:border-mint/35">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M9 22h6a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2Z" />
            </svg>
          </span>
          手机
        </button>
        <button
          onClick={onShowContacts}
          className="group flex items-center justify-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-mint"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-muted text-mint transition group-hover:border-mint/35">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </span>
          通讯录
        </button>
      </div>
    </div>
  );
}

function ConversationRow({
  group,
  lastMessage,
  membersExpanded,
  onToggleMembersExpanded,
  onClick,
  onDelete,
}: {
  group: AgentGroup;
  lastMessage?: Envelope;
  membersExpanded: boolean;
  onToggleMembersExpanded: () => void;
  onClick: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const {
    selectedGroupId,
    runningAgentIdsByGroup,
    busyAgentIdsByGroup,
    initializingByGroup,
    streamingByGroup,
    agentErrorsByGroup,
    agents,
    roles,
  } = useAppStore();
  const isSelected = selectedGroupId === group.id;
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const avatarBackground = getGroupAvatarBackground(group);

  const runningAgentIds = runningAgentIdsByGroup[group.id] ?? [];
  const busyAgentIds = busyAgentIdsByGroup?.[group.id] ?? [];
  const initializingAgentIds = initializingByGroup[group.id] ?? [];
  const streamingAgentNames = streamingByGroup[group.id] ?? [];
  const agentErrors = agentErrorsByGroup[group.id] ?? {};
  const presenceContext = useMemo(() => ({
    runningAgentIds,
    initializingAgentIds,
    busyAgentIds,
    streamingAgentNames,
    agentErrors,
  }), [runningAgentIds, initializingAgentIds, busyAgentIds, streamingAgentNames, agentErrors]);

  const memberTotal = group.members.length + 1;
  const onlineCount = group.members.filter(m => runningAgentIds.includes(m.agentId)).length;
  const fullOnlineCount = 1 + onlineCount;
  const groupAgents = useMemo(
    () => group.members
      .map(member => agents.find(agent => agent.id === member.agentId))
      .filter((agent): agent is Agent => !!agent),
    [agents, group.members],
  );
  const groupPresence = useMemo(
    () => getGroupPresence(groupAgents, presenceContext),
    [groupAgents, presenceContext],
  );

  return (
    <>
      {showConfirm && (
        <DeleteConfirmDialog
          title="删除群组"
          description={`确定要删除群组「${group.name}」吗？此操作无法撤销。`}
          confirmLabel="删除"
          loadingLabel="删除中..."
          onConfirm={async () => {
            await onDelete();
            setShowConfirm(false);
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
      {showMembers && (
        <GroupMembersModal
          group={group}
          onClose={() => setShowMembers(false)}
        />
      )}
      <div className="flex flex-col">
        <div
          className={`group flex items-center gap-1 border-l-2 px-2 py-3 transition-colors ${
            isSelected
              ? 'border-accent bg-accent-muted shadow-[inset_0_0_24px_rgba(255,95,61,0.06)]'
              : 'border-transparent hover:bg-surface-hover/80'
          }`}
        >
          <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
          >
            {/* Avatar */}
            <div className="relative flex-shrink-0">
              <div
                data-testid={`group-avatar-${group.id}`}
                className="flex h-10 w-10 items-center justify-center rounded-xl shadow-glow"
                style={{ background: avatarBackground }}
              >
                <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              </div>
              <AgentPresenceIndicator
                state={groupPresence}
                detail={`群内 ${onlineCount} 个 AI 在线`}
                count={onlineCount}
                className={
                  onlineCount > 0
                    ? 'absolute -bottom-1 -right-1 flex h-4 min-w-[16px] items-center justify-center px-1'
                    : 'absolute -bottom-1 -right-1 h-4 w-4'
                }
              />
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-content">
                  {group.name}
                </span>
                {lastMessage && (
                  <span className="flex-shrink-0 text-[11px] tabular-nums text-content-subtle">
                    {new Date(lastMessage.ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-content-muted">
                {memberTotal} 位成员 · {fullOnlineCount} 在线
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-label={`删除群组 ${group.name}`}
            title="删除群组"
            onClick={e => { e.stopPropagation(); setShowConfirm(true); }}
            className="flex-shrink-0 rounded-lg p-2 text-content-subtle opacity-0 transition hover:bg-red-500/15 hover:text-red-400 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500/40 group-hover:opacity-100"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-7 0h8" />
            </svg>
          </button>

          <button
            type="button"
            aria-expanded={membersExpanded}
            aria-label={membersExpanded ? '收起群成员' : '展开群成员'}
            title={membersExpanded ? '收起群成员' : '展开群成员'}
            onClick={e => {
              e.stopPropagation();
              if (!isSelected) {
                onClick();
                return;
              }
              onToggleMembersExpanded();
            }}
            className={`flex-shrink-0 rounded-md p-1 text-content-subtle transition hover:bg-surface-hover hover:text-content ${
              membersExpanded ? 'text-accent' : ''
            }`}
          >
            <svg
              className={`h-4 w-4 transition-transform ${membersExpanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {membersExpanded && (
          <div className="border-b border-border bg-surface-muted/20 px-3 pb-3 pl-3">
            <div className="flex items-center justify-between border-b border-border/60 px-2 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                成员 ({memberTotal})
              </span>
              <button
                type="button"
                onClick={() => setShowMembers(true)}
                className="rounded-xl p-2 text-content-muted transition hover:bg-surface-hover hover:text-content"
                title="成员管理"
                aria-label="成员管理"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
            <div className="px-1 pt-2">
              <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                <div className="relative flex-shrink-0">
                  <div
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-sm"
                    style={{ background: 'linear-gradient(145deg, #f59e0b, #d97706)' }}
                  >
                    {group.ownerName.charAt(0).toUpperCase()}
                  </div>
                  <AgentPresenceIndicator
                    state={groupPresence}
                    detail="当前群组 AI 状态"
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-elevated"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-content">{group.ownerName}</p>
                  <p className="text-[10px] text-amber-400">群主</p>
                </div>
              </div>
              {group.members.map(member => (
                <GroupMemberRowItem
                  key={member.id}
                  member={member}
                  group={group}
                  agents={agents}
                  roles={roles}
                  presenceState={getAgentPresence(
                    agents.find(agent => agent.id === member.agentId),
                    presenceContext,
                  )}
                  presenceDetail={agentErrors[member.agentId]}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
