import { useState } from 'react';
import { isFullBleedAgentLogo, SUPPORTED_AGENT_MAP } from '../agent-platforms';
import type { Agent, AgentGroup, AgentPresenceState, GroupMember, Role } from '../types';
import { useAppDispatch, useAppStore } from '../hooks/useStore';
import { api } from '../lib/api';
import { AgentPresenceIndicator } from './AgentPresenceIndicator';
import { getAgentAvatarBackground, getGroupMemberAvatarLabel } from '../lib/agentAppearance';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

export function GroupMemberRowItem({
  member, group, agents, roles, presenceState, presenceDetail, compact = false,
}: {
  member: GroupMember;
  group: AgentGroup;
  agents: Agent[];
  roles: Role[];
  presenceState: AgentPresenceState;
  presenceDetail?: string;
  /** 两列网格等窄列布局 */
  compact?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { terminalAgentId, terminalGroupId } = useAppStore();
  const [actionError, setActionError] = useState('');
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [showOfflineConfirm, setShowOfflineConfirm] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const agent = agents.find(a => a.id === member.agentId);
  if (!agent) return null;

  const memberRoleName = member.roleId ? roles.find(r => r.id === member.roleId)?.name : undefined;
  const isLeader = !!member.roleId && group.roleLeaders?.[member.roleId] === member.id;
  const hasRolePeers = !!member.roleId
    && group.members.filter(item => item.roleId === member.roleId).length > 1;

  const avatarLabel = getGroupMemberAvatarLabel(member, group, roles, agent.name);
  const logoUrl = SUPPORTED_AGENT_MAP[agent.platform]?.logoUrl;
  const logoImgClass = isFullBleedAgentLogo(agent.platform)
    ? 'h-full w-full object-cover object-center'
    : 'box-border h-full w-full p-1 object-contain object-center';
  const canOpenTerminal = presenceState !== 'offline' && presenceState !== 'error';
  const terminalLabel = `打开 ${agent.name} 的模型终端`;

  const avatarFrameClass = [
    compact
      ? 'flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm'
      : 'flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm',
    logoUrl
      ? 'bg-zinc-300 ring-1 ring-black/10 dark:bg-zinc-600 dark:ring-white/10'
      : 'text-[10px] font-bold text-white',
  ].join(' ');

  const handleOpenTerminal = () => {
    if (!canOpenTerminal) return;
    dispatch({ type: 'OPEN_TERMINAL', payload: { agentId: member.agentId, groupId: group.id } });
  };

  const handleGoOnline = async () => {
    setActionError('');
    dispatch({ type: 'MARK_AGENT_INITIALIZING', payload: { groupId: group.id, agentId: member.agentId } });
    try {
      await api.goOnline(group.id, member.id);
      dispatch({ type: 'CLEAR_AGENT_ERROR', payload: { groupId: group.id, agentId: member.agentId } });
      setTimeout(() => {
        dispatch({ type: 'CLEAR_AGENT_INITIALIZING', payload: { groupId: group.id, agentId: member.agentId } });
      }, 30_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : '上线失败';
      setActionError(message);
      dispatch({ type: 'SET_AGENT_ERROR', payload: { groupId: group.id, agentId: member.agentId, message } });
    }
  };

  const handleGoOffline = async () => {
    setActionError('');
    try {
      await api.goOffline(group.id, member.id);
      setShowOfflineConfirm(false);
      dispatch({ type: 'CLEAR_AGENT_INITIALIZING', payload: { groupId: group.id, agentId: member.agentId } });
      dispatch({ type: 'CLEAR_AGENT_ERROR', payload: { groupId: group.id, agentId: member.agentId } });
      if (terminalAgentId === member.agentId && terminalGroupId === group.id) {
        dispatch({ type: 'CLOSE_TERMINAL' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '下线失败';
      setActionError(message);
      dispatch({ type: 'SET_AGENT_ERROR', payload: { groupId: group.id, agentId: member.agentId, message } });
    }
  };

  const handleRemove = async () => {
    setRemoveError('');
    try {
      await api.removeMember(group.id, member.id);
      setShowRemoveConfirm(false);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : '移除失败');
    }
  };

  const handleSetLeader = async () => {
    if (!member.roleId) return;
    setActionError('');
    try {
      await api.setGroupRoleLeader(group.id, member.roleId, member.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '设置 Leader 失败');
    }
  };

  return (
    <>
      {showOfflineConfirm && (
        <DeleteConfirmDialog
          title="下线成员"
          description={`确定要让成员「${memberRoleName ?? agent.name}」在群组「${group.name}」中下线吗？下线后将关闭其模型终端连接。`}
          confirmLabel="下线"
          loadingLabel="下线中..."
          onConfirm={handleGoOffline}
          onCancel={() => setShowOfflineConfirm(false)}
        />
      )}
      {showRemoveConfirm && (
        <DeleteConfirmDialog
          title="移除成员"
          description={`确定要将成员「${memberRoleName ?? agent.name}」移出群组「${group.name}」吗？此操作无法撤销。`}
          confirmLabel="移除"
          loadingLabel="移除中..."
          onConfirm={handleRemove}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}
      <div
        className={`group/member rounded-lg transition hover:bg-surface-hover/60 ${
          compact ? 'min-w-0 px-1.5 py-1' : 'px-2 py-1.5'
        }`}
      >
        <div className={`flex items-center ${compact ? 'gap-1.5' : 'gap-2.5'}`}>
          <div className="relative flex-shrink-0">
            {canOpenTerminal ? (
              <button
                type="button"
                onClick={handleOpenTerminal}
                className={`${avatarFrameClass} transition hover:scale-[1.04] focus:outline-none focus:ring-2 focus:ring-accent/35`}
                style={
                  logoUrl
                    ? undefined
                    : { background: getAgentAvatarBackground(agent.platform, agent.avatarColor) }
                }
                title="打开模型终端"
                aria-label={terminalLabel}
              >
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt=""
                    className={logoImgClass}
                  />
                ) : (
                  avatarLabel
                )}
              </button>
            ) : (
              <div
                className={avatarFrameClass}
                style={
                  logoUrl
                    ? undefined
                    : { background: getAgentAvatarBackground(agent.platform, agent.avatarColor) }
                }
              >
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt=""
                    className={logoImgClass}
                  />
                ) : (
                  avatarLabel
                )}
              </div>
            )}
            <AgentPresenceIndicator
              state={presenceState}
              detail={actionError || presenceDetail}
              className={`absolute rounded-full border-2 border-surface-elevated ${
                compact
                  ? '-bottom-px -right-px h-2 w-2'
                  : '-bottom-0.5 -right-0.5 h-2.5 w-2.5'
              }`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`truncate font-medium text-content ${compact ? 'text-[11px] leading-tight' : 'text-xs'}`}>
              {memberRoleName ?? agent.name}
              {isLeader ? (
                <span className="ml-1 rounded bg-accent/15 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-accent">Leader</span>
              ) : null}
            </p>
            {memberRoleName && (
              <p className={`truncate text-content-subtle ${compact ? 'text-[9px] leading-tight' : 'text-[10px]'}`}>
                {agent.name}
              </p>
            )}
          </div>
          <div
            className={`flex flex-shrink-0 items-center opacity-0 transition group-hover/member:opacity-100 ${
              compact ? 'gap-0.5' : 'gap-1'
            }`}
          >
            {hasRolePeers && !isLeader ? (
              <button
                type="button"
                onClick={handleSetLeader}
                className={`rounded font-medium text-content-subtle transition hover:bg-accent-muted hover:text-accent ${
                  compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
                }`}
                title={`设为${memberRoleName ?? ''} Leader`}
              >
                设为 Leader
              </button>
            ) : null}
            {canOpenTerminal ? (
              <button
                type="button"
                onClick={() => setShowOfflineConfirm(true)}
                className={`rounded font-medium text-content-subtle transition hover:bg-red-500/10 hover:text-red-400 ${
                  compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
                }`}
                title="下线"
              >
                下线
              </button>
            ) : (
              <button
                type="button"
                onClick={handleGoOnline}
                className={`rounded font-medium text-accent transition hover:bg-accent-muted ${
                  compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
                }`}
                title="上线"
              >
                上线
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowRemoveConfirm(true)}
              className={`rounded text-content-subtle transition hover:bg-red-500/15 hover:text-red-400 ${
                compact ? 'p-0.5' : 'p-1'
              }`}
              title="移除成员"
            >
              <svg className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {(actionError || removeError) && (
          <p className="mt-1 truncate text-[10px] text-red-400" title={actionError || removeError}>
            {actionError || removeError}
          </p>
        )}
      </div>
    </>
  );
}
