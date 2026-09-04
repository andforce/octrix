import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../hooks/useStore';
import { useWs } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { getAgentPresence, getPresenceLabel } from '../lib/agentStatus';
import { MessageBubble } from './MessageBubble';
import { AgentPresenceIndicator } from './AgentPresenceIndicator';
import { MissionStatusPanel } from './MissionStatusPanel';
import { WorkspaceTerminalView } from './WorkspaceTerminalView';
import { GitChangesView } from './GitChangesView';
import { getSupportedAgent, type AgentPlatform } from '../agent-platforms';
import type {
  AgentGroup,
  Envelope,
  Agent,
  CliCommandItem,
  ConversationEntry,
  FileEntry,
  SkillListItem,
  TaskSession,
} from '../types';
import { formatClaudeUserEntryContent } from '../lib/formatClaudeUserEntryContent';
import { getActiveToken } from '../lib/chatInputTriggers';
import { getAgentAvatarBackground, getConversationSenderPresentation } from '../lib/agentAppearance';
import {
  collectDroppedFilesFromDataTransfer,
  collectNativePathsFromDataTransfer,
  droppedFilesHaveNativePaths,
} from '../lib/workspaceImport';

/** dataTransfer MIME for workspace-relative paths from the file tree (drop onto chat input). */
export const WORKSPACE_RELPATH_MIME = 'application/x-ai-agent-workspace-relpath';
const DIRECTORY_AUTO_EXPAND_DELAY_MS = 450;
const WORKSPACE_REFRESH_DEBOUNCE_MS = 180;
/** 工作空间终端内容区可拖拽高度（px） */
const WORKSPACE_TERMINAL_PANEL_MIN = 120;
const WORKSPACE_TERMINAL_PANEL_DEFAULT = 320;
const WORKSPACE_TERMINAL_PANEL_MAX_CAP = 720;
const WORKSPACE_TERMINAL_VIEWPORT_RESERVE = 160;
/** 聊天输入框与发送按钮的默认基线高度（px）；多行时 textarea 在此基础上继续伸缩 */
const CHAT_INPUT_BASELINE_HEIGHT_PX = 43;
const CHAT_INPUT_MAX_HEIGHT_PX = 200;
/** 插入 Skill 的默认格式（与 CLI 习惯一致）；若群主改为路径格式可改为使用 skillMdPath */
const SKILL_INSERT_USE_SLASH_NAME = true;
const SKILLS_CLIENT_CACHE_MS = 55_000;

function getWorkspaceTerminalPanelMaxHeight(): number {
  if (typeof window === 'undefined') return WORKSPACE_TERMINAL_PANEL_MAX_CAP;
  const raw = window.innerHeight - WORKSPACE_TERMINAL_VIEWPORT_RESERVE;
  return Math.min(
    WORKSPACE_TERMINAL_PANEL_MAX_CAP,
    Math.max(WORKSPACE_TERMINAL_PANEL_MIN, raw),
  );
}

function clampWorkspaceTerminalPanelHeight(height: number): number {
  const max = getWorkspaceTerminalPanelMaxHeight();
  return Math.min(max, Math.max(WORKSPACE_TERMINAL_PANEL_MIN, height));
}

function formatWorkspaceFileRef(relativePath: string) {
  return `\`file:${relativePath}\` `;
}

function isExternalFileDrag(dt: DataTransfer) {
  const types = [...dt.types];
  return types.includes('Files')
    || types.some(t => t === 'application/x-moz-file' || t.startsWith('application/x-icab-'));
}

interface ChatViewProps {
  group: AgentGroup;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  onOpenNewTask?: () => void;
  onOpenTaskHistory?: () => void;
}

interface MentionOption {
  id: string;
  label: string;
  insertText: string;
  agentId?: string;
  isAll: boolean;
}

interface BuiltinSlashItem {
  id: string;
  name: string;
  description: string;
  insertText: string;
  sourceTag: string;
}

type SlashMenuSource =
  | { kind: 'skill' }
  | { kind: 'cli'; platform: AgentPlatform; agentName: string; cliLabel: string };

type SlashOption = SkillListItem | CliCommandItem | BuiltinSlashItem;

const BUILTIN_SLASH_ITEMS: BuiltinSlashItem[] = [
  {
    id: 'builtin:new',
    name: 'new',
    description: '统一新会话入口',
    insertText: '/new',
    sourceTag: 'builtin',
  },
  {
    id: 'builtin:clear',
    name: 'clear',
    description: '统一清空/新开会话入口',
    insertText: '/clear',
    sourceTag: 'builtin',
  },
  {
    id: 'builtin:compact',
    name: 'compact',
    description: '统一压缩上下文入口',
    insertText: '/compact',
    sourceTag: 'builtin',
  },
];

function isMentionBoundaryChar(char: string | undefined): boolean {
  return !char || /\s|[，。,.!?;:、]/.test(char);
}

function findLastMentionedOptionBeforeCursor(
  text: string,
  cursor: number,
  options: MentionOption[],
): MentionOption | null {
  const before = text.slice(0, cursor);
  let best: { option: MentionOption; idx: number } | null = null;

  for (const option of options) {
    if (option.isAll || !option.agentId) continue;
    const needle = `@${option.insertText}`;
    let searchFrom = before.length;
    while (searchFrom >= 0) {
      const idx = before.lastIndexOf(needle, searchFrom);
      if (idx < 0) break;
      const prev = idx > 0 ? before[idx - 1] : undefined;
      const next = before[idx + needle.length];
      if ((idx === 0 || /\s/.test(prev ?? '')) && isMentionBoundaryChar(next)) {
        if (!best || idx >= best.idx) {
          best = { option, idx };
        }
        break;
      }
      searchFrom = idx - 1;
    }
  }

  return best?.option ?? null;
}

export function ChatView({
  group,
  isSidebarVisible = true,
  onToggleSidebar,
  onOpenNewTask,
  onOpenTaskHistory,
}: ChatViewProps) {
  const ws = useWs();
  const {
    messages,
    agents,
    runningAgentIdsByGroup,
    busyAgentIdsByGroup,
    initializingByGroup,
    streamingByGroup,
    agentErrorsByGroup,
    roles,
    taskSessions,
    workItems = [],
    issues = [],
    selectedTaskSessionIdByGroup,
  } = useAppStore();
  const [inputText, setInputText] = useState('');
  const [showMention, setShowMention] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [slashQuery, setSlashQuery] = useState('');
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const [selectedSlashIdx, setSelectedSlashIdx] = useState(0);
  const [slashMenuSource, setSlashMenuSource] = useState<SlashMenuSource | null>(null);
  const [skillRows, setSkillRows] = useState<SkillListItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsErr, setSkillsErr] = useState('');
  const skillsClientCacheRef = useRef<{ at: number; skills: SkillListItem[] } | null>(null);
  const [cliCommandRows, setCliCommandRows] = useState<CliCommandItem[]>([]);
  const [cliCommandsLoading, setCliCommandsLoading] = useState(false);
  const [cliCommandsErr, setCliCommandsErr] = useState('');
  const cliCommandsClientCacheRef = useRef<Partial<Record<AgentPlatform, {
    at: number;
    commands: CliCommandItem[];
  }>>>({});
  const [detailMessageId, setDetailMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const [inputDragOver, setInputDragOver] = useState(false);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesPath, setFilesPath] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [workspaceTerminalState, setWorkspaceTerminalState] = useState<{
    terminals: { id: string; number: number }[];
    activeTerminalId: string | null;
  }>({ terminals: [], activeTerminalId: null });
  const [terminalDockHeight, setTerminalDockHeight] = useState(0);
  const [workspacePanelMode, setWorkspacePanelMode] = useState<'workspace' | 'git'>('workspace');
  const [isWorkspacePanelVisible, setIsWorkspacePanelVisible] = useState(true);
  const [workspaceDropOver, setWorkspaceDropOver] = useState(false);
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState('');
  const [workspaceImporting, setWorkspaceImporting] = useState(false);
  const [sendError, setSendError] = useState('');
  const filesRequestSeqRef = useRef(0);
  const refreshTimeoutRef = useRef<number | null>(null);

  const groupTaskSessions = useMemo<TaskSession[]>(
    () => taskSessions.filter(session => session.groupId === group.id),
    [taskSessions, group.id],
  );
  const activeTaskSessionId = group.activeTaskSessionId ?? groupTaskSessions.find(session => session.status === 'active')?.id;
  const selectedTaskSessionId = selectedTaskSessionIdByGroup[group.id]
    ?? activeTaskSessionId
    ?? groupTaskSessions[0]?.id;
  const currentTaskSession = groupTaskSessions.find(session => session.id === selectedTaskSessionId) ?? null;
  const activeMission = group.activeTaskSessionId
    ? groupTaskSessions.find(session => session.id === group.activeTaskSessionId && session.kind === 'mission')
    : undefined;
  const isArchivedTaskSession = !!currentTaskSession
    && ['archived', 'completed', 'cancelled'].includes(currentTaskSession.status);
  const isChatPaused = !!group.pausedByMissionId;
  const missionWorkItems = useMemo(
    () => workItems.filter(item => item.taskSessionId === currentTaskSession?.id),
    [workItems, currentTaskSession?.id],
  );
  const missionIssues = useMemo(
    () => issues.filter(issue => issue.missionId === currentTaskSession?.id),
    [issues, currentTaskSession?.id],
  );

  const groupMessages = useMemo(
    () => messages.filter(m => m.groupId === group.id && m.taskSessionId === selectedTaskSessionId),
    [messages, group.id, selectedTaskSessionId],
  );
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
  }), [agentErrors, streamingAgentNames, busyAgentIds, initializingAgentIds, runningAgentIds]);

  const detailMessage = useMemo(
    () => detailMessageId ? groupMessages.find(m => m.id === detailMessageId) ?? null : null,
    [detailMessageId, groupMessages],
  );

  const uniqueAgents = useMemo(
    () => {
      const ids = [...new Set(group.members.map(m => m.agentId))];
      return ids.map(id => agents.find(a => a.id === id)).filter((a): a is Agent => !!a);
    },
    [group.members, agents],
  );
  const openWorkspaceTerminals = workspaceTerminalState.terminals;
  const activeWorkspaceTerminalId = workspaceTerminalState.activeTerminalId;

  const memberMentionOptions = useMemo<MentionOption[]>(() => {
    const roleCount = new Map<string, number>();
    for (const agent of uniqueAgents) {
      const member = group.members.find(m => m.agentId === agent.id);
      const rName = member?.roleId ? roles.find(r => r.id === member.roleId)?.name : undefined;
      if (rName) roleCount.set(rName, (roleCount.get(rName) ?? 0) + 1);
    }

    const roleLeaderOptions: MentionOption[] = [];
    for (const [roleName] of roleCount) {
      const role = roles.find(item => item.name === roleName);
      if (!role) continue;
      const leaderMemberId = activeMission?.leaderSnapshot?.[role.id] ?? group.roleLeaders?.[role.id];
      const leaderMember = group.members.find(member => member.id === leaderMemberId);
      if (!leaderMember) continue;
      roleLeaderOptions.push({
        id: `role:${role.id}`,
        label: `${roleName} Leader`,
        insertText: roleName,
        agentId: leaderMember.agentId,
        isAll: false,
      });
    }

    const roleIndex = new Map<string, number>();
    const memberOptions = uniqueAgents.map(agent => {
      const member = group.members.find(m => m.agentId === agent.id);
      const roleName = member?.roleId ? roles.find(r => r.id === member.roleId)?.name : undefined;

      if (roleName) {
        const count = roleCount.get(roleName) ?? 1;
        const hasLeaderOption = roleLeaderOptions.some(option => option.insertText === roleName);
        if (count === 1 && !hasLeaderOption) {
          return {
            id: agent.id,
            label: `${roleName}（${agent.name}）`,
            insertText: roleName,
            agentId: agent.id,
            isAll: false,
          };
        }
        const idx = (roleIndex.get(roleName) ?? 0) + 1;
        roleIndex.set(roleName, idx);
        const tag = `${roleName}(${agent.name})-${idx}`;
        return { id: agent.id, label: `${roleName}成员 · ${agent.name}`, insertText: tag, agentId: agent.id, isAll: false };
      }
      return { id: agent.id, label: agent.name, insertText: agent.name, agentId: agent.id, isAll: false };
    });
    return [...roleLeaderOptions, ...memberOptions];
  }, [activeMission?.leaderSnapshot, group.members, group.roleLeaders, roles, uniqueAgents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const all: MentionOption[] = [{ id: '__all__', label: '所有人', insertText: '所有人', isAll: true }];
    const query = mentionQuery.toLowerCase();
    if (!query) return [...all, ...memberMentionOptions];
    return [...all, ...memberMentionOptions].filter(option =>
      option.label.toLowerCase().includes(query) || option.insertText.toLowerCase().includes(query),
    );
  }, [memberMentionOptions, mentionQuery]);

  const slashOptions = useMemo(() => {
    const q = slashQuery.toLowerCase();
    const builtinItems = !q
      ? BUILTIN_SLASH_ITEMS
      : BUILTIN_SLASH_ITEMS.filter(item => {
        const blob = [item.name, item.description, item.insertText].join('\0').toLowerCase();
        return blob.includes(q);
      });

    if (slashMenuSource?.kind === 'cli') {
      const filteredSkills = !q ? skillRows : skillRows.filter(s => {
        const blob = [s.name, s.sourceTag, s.skillMdPath, s.summary ?? ''].join('\0').toLowerCase();
        return blob.includes(q);
      });
      const filteredCliCommands = !q ? cliCommandRows : cliCommandRows.filter(cmd => {
        const blob = [
          cmd.name,
          cmd.description,
          cmd.argumentHint ?? '',
          ...(cmd.aliases ?? []),
        ].join('\0').toLowerCase();
        return blob.includes(q);
      });
      return [...builtinItems, ...filteredSkills, ...filteredCliCommands];
    }

    return builtinItems;
  }, [cliCommandRows, skillRows, slashMenuSource, slashQuery]);

  const slashMenuIsCli = slashMenuSource?.kind === 'cli';
  const slashLoading = slashMenuIsCli
    ? (cliCommandsLoading || skillsLoading)
    : false;
  const slashError = slashMenuIsCli
    ? (cliCommandsErr || skillsErr)
    : '';

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [groupMessages.length]);

  useEffect(() => {
    if (!showMention) return;
    const activeItem = mentionListRef.current?.querySelector<HTMLElement>(
      `[data-mention-index="${selectedMentionIdx}"]`,
    );
    activeItem?.scrollIntoView({ block: 'nearest' });
  }, [selectedMentionIdx, showMention, mentionOptions]);

  useEffect(() => {
    if (!showSlashMenu) return;
    const activeItem = slashListRef.current?.querySelector<HTMLElement>(
      `[data-slash-index="${selectedSlashIdx}"]`,
    );
    activeItem?.scrollIntoView({ block: 'nearest' });
  }, [selectedSlashIdx, showSlashMenu, slashOptions]);

  useEffect(() => {
    if (!showSlashMenu || slashMenuSource?.kind !== 'cli') return;
    const now = Date.now();
    const c = skillsClientCacheRef.current;
    if (c && now - c.at < SKILLS_CLIENT_CACHE_MS) {
      setSkillsErr('');
      setSkillsLoading(false);
      setSkillRows(c.skills);
      return;
    }
    let cancelled = false;
    setSkillsLoading(true);
    setSkillsErr('');
    void api.listSkills()
      .then(res => {
        if (cancelled) return;
        skillsClientCacheRef.current = { at: Date.now(), skills: res.skills };
        setSkillRows(res.skills);
      })
      .catch(err => {
        if (cancelled) return;
        setSkillRows([]);
        setSkillsErr(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => { cancelled = true; };
  }, [showSlashMenu, slashMenuSource]);

  useEffect(() => {
    if (!showSlashMenu || slashMenuSource?.kind !== 'cli') return;
    const platform = slashMenuSource.platform;
    const cached = cliCommandsClientCacheRef.current[platform];
    const now = Date.now();
    if (cached && now - cached.at < SKILLS_CLIENT_CACHE_MS) {
      setCliCommandsErr('');
      setCliCommandsLoading(false);
      setCliCommandRows(cached.commands);
      return;
    }
    let cancelled = false;
    setCliCommandsLoading(true);
    setCliCommandsErr('');
    void api.listCliCommands(platform)
      .then(res => {
        if (cancelled) return;
        cliCommandsClientCacheRef.current[platform] = { at: Date.now(), commands: res.commands };
        setCliCommandRows(res.commands);
      })
      .catch(err => {
        if (cancelled) return;
        setCliCommandRows([]);
        setCliCommandsErr(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setCliCommandsLoading(false);
      });
    return () => { cancelled = true; };
  }, [showSlashMenu, slashMenuSource]);

  useEffect(() => {
    if (!showSlashMenu) return;
    setSelectedSlashIdx(i => Math.min(i, Math.max(0, slashOptions.length - 1)));
  }, [slashOptions.length, showSlashMenu]);

  const refreshWorkspaceFiles = useCallback(async (options?: {
    silent?: boolean;
    reloadExpandedDirectories?: boolean;
  }) => {
    const silent = options?.silent ?? false;
    const reloadExpandedDirectories = options?.reloadExpandedDirectories ?? false;
    const requestId = ++filesRequestSeqRef.current;
    if (!silent) setFilesLoading(true);
    setFilesError('');
    try {
      const data = await api.listGroupFiles(group.id);
      if (filesRequestSeqRef.current !== requestId) return;
      setFiles(data.files);
      setFilesPath(data.path);
      if (reloadExpandedDirectories) {
        setWorkspaceRefreshToken(token => token + 1);
      }
    } catch (err) {
      if (filesRequestSeqRef.current !== requestId) return;
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      if (filesRequestSeqRef.current === requestId) {
        setFilesLoading(false);
      }
    }
  }, [group.id]);

  useEffect(() => {
    void refreshWorkspaceFiles();
    return () => {
      filesRequestSeqRef.current += 1;
    };
  }, [refreshWorkspaceFiles]);

  const handleWorkspaceDragOver = (e: React.DragEvent) => {
    if (!filesPath || workspaceImporting) return;
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!workspaceDropOver) setWorkspaceDropOver(true);
    if (workspaceDropTarget) setWorkspaceDropTarget('');
  };

  const handleWorkspaceDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setWorkspaceDropOver(false);
      setWorkspaceDropTarget('');
    }
  };

  const importDroppedFiles = useCallback(async (dataTransfer: DataTransfer, targetSubpath = '') => {
    setWorkspaceImporting(true);
    setFilesError('');
    try {
      const safeTargetSubpath = targetSubpath.replace(/\\/g, '/').replace(/^[/]+/, '').trim();
      if (droppedFilesHaveNativePaths(dataTransfer)) {
        const paths = collectNativePathsFromDataTransfer(dataTransfer);
        if (paths.length) {
          await api.importWorkspaceFromPaths(group.id, paths, safeTargetSubpath || undefined);
        }
      } else {
        const items = await collectDroppedFilesFromDataTransfer(dataTransfer);
        if (!items.length) return;
        await api.importWorkspaceFiles(group.id, items, safeTargetSubpath || undefined);
      }
      await refreshWorkspaceFiles({ silent: true, reloadExpandedDirectories: true });
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkspaceImporting(false);
    }
  }, [group.id, refreshWorkspaceFiles]);

  const handleWorkspaceDrop = async (e: React.DragEvent, targetSubpath = '') => {
    e.preventDefault();
    e.stopPropagation();
    setWorkspaceDropOver(false);
    setWorkspaceDropTarget('');
    if (!filesPath || workspaceImporting) return;

    const isInternalTreeDrag = e.dataTransfer.types.includes(WORKSPACE_RELPATH_MIME)
      && e.dataTransfer.files.length === 0;
    if (isInternalTreeDrag) return;

    await importDroppedFiles(e.dataTransfer, targetSubpath);
  };

  const handleDirectoryDragOver = (e: React.DragEvent<HTMLButtonElement>, targetSubpath: string) => {
    if (!filesPath || workspaceImporting) return;
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!workspaceDropOver) setWorkspaceDropOver(true);
    if (workspaceDropTarget !== targetSubpath) setWorkspaceDropTarget(targetSubpath);
  };

  const handleDirectoryDragLeave = (e: React.DragEvent<HTMLButtonElement>, targetSubpath: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (workspaceDropTarget === targetSubpath) setWorkspaceDropTarget('');
  };

  useEffect(() => {
    setWorkspacePanelMode('workspace');
  }, [group.id]);

  useEffect(() => {
    const removeHandler = ws.addHandler((event, data) => {
      if (event !== 'workspace:files-changed') return;
      const payload = data as { groupId?: string };
      if (payload.groupId !== group.id) return;
      if (refreshTimeoutRef.current != null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
      refreshTimeoutRef.current = window.setTimeout(() => {
        refreshTimeoutRef.current = null;
        void refreshWorkspaceFiles({ silent: true, reloadExpandedDirectories: true });
      }, WORKSPACE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      removeHandler();
      if (refreshTimeoutRef.current != null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [group.id, refreshWorkspaceFiles, ws]);

  const senderPresentation = useCallback((sender: string) => (
    getConversationSenderPresentation(sender, group.ownerName, group, agents, roles)
  ), [agents, group, roles]);

  const resolveSlashMenuSource = useCallback((text: string, cursor: number): SlashMenuSource => {
    const option = findLastMentionedOptionBeforeCursor(text, cursor, memberMentionOptions);
    if (!option?.agentId) return { kind: 'skill' };
    const agent = uniqueAgents.find(item => item.id === option.agentId);
    if (!agent) return { kind: 'skill' };
    const supported = getSupportedAgent(agent.platform);
    return {
      kind: 'cli',
      platform: agent.platform,
      agentName: option.insertText,
      cliLabel: supported.cliLabel,
    };
  }, [memberMentionOptions, uniqueAgents]);

  const updateCompletionPopup = (text: string, cursor: number) => {
    const t = getActiveToken(text, cursor);
    if (!t) {
      setShowMention(false);
      setShowSlashMenu(false);
      setSlashMenuSource(null);
      return;
    }
    if (t.kind === 'mention') {
      setMentionQuery(t.query);
      setSelectedMentionIdx(0);
      setShowMention(true);
      setShowSlashMenu(false);
      setSlashMenuSource(null);
    } else {
      setSlashQuery(t.query);
      setSelectedSlashIdx(0);
      setSlashMenuSource(resolveSlashMenuSource(text, cursor));
      setShowSlashMenu(true);
      setShowMention(false);
    }
  };

  const insertMention = (name: string) => {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? inputText.length;
    const token = getActiveToken(inputText, cursor);
    if (!token || token.kind !== 'mention') return;
    const next = inputText.slice(0, token.triggerStart) + '@' + name + ' ' + inputText.slice(cursor);
    setInputText(next);
    setShowMention(false);
    const pos = token.triggerStart + 1 + name.length + 1;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      updateCompletionPopup(next, pos);
    });
  };

  const insertSlashOption = (item: SlashOption) => {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? inputText.length;
    const token = getActiveToken(inputText, cursor);
    if (!token || token.kind !== 'slash') return;
    const insert = 'skillMdPath' in item
      ? (SKILL_INSERT_USE_SLASH_NAME ? `/${item.name} ` : `\`${item.skillMdPath}\` `)
      : `${item.insertText} `;
    const next = inputText.slice(0, token.triggerStart) + insert + inputText.slice(cursor);
    setInputText(next);
    setShowSlashMenu(false);
    setSlashMenuSource(null);
    const pos = token.triggerStart + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      updateCompletionPopup(next, pos);
    });
  };

  const insertWorkspacePathAtCursor = useCallback((relativePath: string) => {
    const trimmed = relativePath.trim();
    if (!trimmed) return;
    const input = inputRef.current;
    const insertion = formatWorkspaceFileRef(trimmed);
    const start = input?.selectionStart ?? inputText.length;
    const end = input?.selectionEnd ?? inputText.length;
    const next = inputText.slice(0, start) + insertion + inputText.slice(end);
    setInputText(next);
    requestAnimationFrame(() => {
      input?.focus();
      const pos = start + insertion.length;
      input?.setSelectionRange(pos, pos);
      updateCompletionPopup(next, pos);
    });
  }, [inputText]);

  const handleInputDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!inputDragOver) setInputDragOver(true);
  };

  const handleInputDragLeave = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setInputDragOver(false);
  };

  const handleInputDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setInputDragOver(false);
    const path =
      e.dataTransfer.getData(WORKSPACE_RELPATH_MIME)
      || e.dataTransfer.getData('text/plain').trim();
    if (!path) return;
    insertWorkspacePathAtCursor(path);
  };

  const parseMentions = (text: string) => {
    if (text.includes('@所有人')) {
      return { agentIds: uniqueAgents.map(a => a.id), isAll: true };
    }
    const ids = memberMentionOptions
      .filter(option => text.includes(`@${option.insertText}`))
      .map(option => option.agentId)
      .filter((id): id is string => !!id);
    return { agentIds: ids, isAll: false };
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (
      !text
      || (!selectedTaskSessionId && group.groupType === 'direct')
      || isArchivedTaskSession
      || isChatPaused
    ) return;
    const { agentIds, isAll } = parseMentions(text);
    const runningInGroup = uniqueAgents
      .filter(a => runningAgentIds.includes(a.id))
      .map(a => a.id);
    const currentPhase = activeMission?.phases?.find(phase => phase.id === activeMission.currentPhaseId);
    const defaultLeaderMemberId = currentPhase?.roleId
      ? activeMission?.leaderSnapshot?.[currentPhase.roleId]
      : undefined;
    const defaultLeaderAgentId = group.members.find(member => member.id === defaultLeaderMemberId)?.agentId;
    const defaultTargetIds = group.groupType === 'direct'
      ? runningInGroup
      : defaultLeaderAgentId
        ? [defaultLeaderAgentId]
        : [];
    const targetIds = agentIds.length > 0 ? [...new Set(agentIds)] : defaultTargetIds;
    const displayTo = isAll
      ? '所有人'
      : agentIds.length > 0
        ? agentIds
          .map(id => memberMentionOptions.find(option => option.agentId === id)?.insertText)
          .filter(Boolean)
          .join(', ')
        : defaultLeaderAgentId && targetIds.length === 1
        ? '当前阶段 Leader'
        : targetIds
          .map(id => memberMentionOptions.find(option => option.agentId === id)?.insertText)
          .filter(Boolean)
          .join(', ');
    try {
      setSendError('');
      await api.sendMessage(text, group.id, selectedTaskSessionId, displayTo ?? '', targetIds);
      setInputText('');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '发送消息失败，请稍后重试');
    }
  };

  useEffect(() => {
    setSendError('');
  }, [selectedTaskSessionId]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(
      Math.max(el.scrollHeight, CHAT_INPUT_BASELINE_HEIGHT_PX),
      CHAT_INPUT_MAX_HEIGHT_PX,
    );
    el.style.height = `${h}px`;
  }, [inputText]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }
    if (showMention && mentionOptions.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIdx(Math.max(0, selectedMentionIdx - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIdx(Math.min(mentionOptions.length - 1, selectedMentionIdx + 1));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertMention(mentionOptions[selectedMentionIdx].insertText);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMention(false);
        return;
      }
    }
    if (showSlashMenu) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (slashOptions.length > 0) {
          setSelectedSlashIdx(Math.max(0, selectedSlashIdx - 1));
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (slashOptions.length > 0) {
          setSelectedSlashIdx(Math.min(slashOptions.length - 1, selectedSlashIdx + 1));
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!slashLoading && slashOptions.length > 0) {
          insertSlashOption(slashOptions[selectedSlashIdx]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        setSlashMenuSource(null);
        return;
      }
    }
    if (e.key === 'Enter' && !showMention && !showSlashMenu) {
      if (e.shiftKey) return;
      e.preventDefault();
      sendMessage();
    }
  };

  const openWorkspaceTerminal = useCallback(() => {
    setWorkspaceTerminalState(prev => {
      const nextNumber = prev.terminals.length === 0
        ? 1
        : Math.max(...prev.terminals.map(t => t.number)) + 1;
      const id = `ws-term-${group.id}-${nextNumber}`;
      return {
        terminals: [...prev.terminals, { id, number: nextNumber }],
        activeTerminalId: id,
      };
    });
  }, [group.id]);

  const closeWorkspaceTerminal = useCallback((terminalId: string) => {
    setWorkspaceTerminalState(prev => {
      const index = prev.terminals.findIndex(t => t.id === terminalId);
      if (index === -1) return prev;
      const terminals = prev.terminals.filter(t => t.id !== terminalId);
      const activeTerminalId = prev.activeTerminalId !== terminalId
        ? (prev.activeTerminalId && terminals.some(t => t.id === prev.activeTerminalId)
            ? prev.activeTerminalId
            : terminals[0]?.id ?? null)
        : terminals[index]?.id ?? terminals[index - 1]?.id ?? null;
      return { ...prev, terminals, activeTerminalId };
    });
  }, []);

  const activateWorkspaceTerminal = useCallback((terminalId: string) => {
    setWorkspaceTerminalState(prev => {
      if (!prev.terminals.some(t => t.id === terminalId) || prev.activeTerminalId === terminalId) return prev;
      return { ...prev, activeTerminalId: terminalId };
    });
  }, []);

  const closeAllWorkspaceTerminals = useCallback(() => {
    setWorkspaceTerminalState(prev => ({ ...prev, terminals: [], activeTerminalId: null }));
  }, []);

  const isWorkspaceTerminalOpenForGroup = openWorkspaceTerminals.length > 0;
  const inputPlaceholder = isChatPaused
    ? '同仓库有活跃协作任务，此单聊已暂停'
    : isArchivedTaskSession
    ? '历史任务只读'
    : group.groupType === 'collaboration' && !selectedTaskSessionId
    ? '群聊大厅：无 @ 只记录消息；@成员或@角色可定向沟通；正式协作请创建主任务'
    : '输入消息；@ 提及 Agent；/ 使用内置命令，或在 @Agent 后选择 CLI 命令与 Skill；可从右侧工作空间拖拽文件到此处';
  const requiresTaskSession = group.groupType === 'direct';

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[50px] items-center justify-between border-b border-border px-5">
          <div className="flex min-w-0 items-center gap-3">
            {onToggleSidebar && (
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={isSidebarVisible ? '隐藏侧边栏' : '显示侧边栏'}
                title={isSidebarVisible ? '隐藏侧边栏' : '显示侧边栏'}
                aria-pressed={isSidebarVisible}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center text-content-muted transition hover:text-content"
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <rect x="2.25" y="3" width="15.5" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6.75 4.75v10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <rect
                    x="3.75"
                    y="4.75"
                    width="2.5"
                    height="10.5"
                    rx="1"
                    className="fill-current opacity-60"
                  />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate font-display text-lg font-bold tracking-tight text-content">{group.name}</h2>
                {currentTaskSession && (
                  <span
                    className={`max-w-[260px] truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      isArchivedTaskSession
                        ? 'border-border bg-surface-muted text-content-subtle'
                        : 'border-accent/25 bg-accent/10 text-accent'
                    }`}
                    title={currentTaskSession.title}
                  >
                    {isArchivedTaskSession ? '历史任务' : '当前任务'}: {currentTaskSession.title}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-3">
            {group.groupType === 'collaboration' ? (
              <>
                <button
                  type="button"
                  onClick={onOpenTaskHistory}
                  className="rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm text-content transition hover:border-border-strong hover:bg-surface-hover"
                >
                  任务记录
                </button>
                <button
                  type="button"
                  onClick={onOpenNewTask}
                  disabled={!!activeMission && activeMission.status !== 'draft'}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {activeMission?.status === 'draft'
                    ? '配置任务'
                    : activeMission
                      ? '任务进行中'
                      : '新任务'}
                </button>
              </>
            ) : null}
            <WorkspaceTerminalTrigger
              group={group}
              onOpenTerminal={openWorkspaceTerminal}
              isOpen={isWorkspaceTerminalOpenForGroup}
              compact
            />
            <button
              type="button"
              onClick={() => setIsWorkspacePanelVisible(v => !v)}
              aria-label={isWorkspacePanelVisible ? '隐藏工作空间' : '显示工作空间'}
              title={isWorkspacePanelVisible ? '隐藏工作空间' : '显示工作空间'}
              aria-pressed={isWorkspacePanelVisible}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center text-content-muted transition hover:text-content"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden>
                <rect x="2.25" y="3" width="15.5" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M13.25 4.75v10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <rect
                  x="13.75"
                  y="4.75"
                  width="2.5"
                  height="10.5"
                  rx="1"
                  className="fill-current opacity-60"
                />
              </svg>
            </button>
          </div>
        </div>

        {group.groupType === 'collaboration' && currentTaskSession?.kind === 'mission' ? (
          <MissionStatusPanel
            group={group}
            mission={currentTaskSession}
            workItems={missionWorkItems}
            issues={missionIssues}
            agents={agents}
            onConfigure={() => onOpenNewTask?.()}
          />
        ) : null}

        <div
          className="flex min-h-0 flex-1 transition-[padding] duration-200"
          style={{ paddingBottom: isWorkspaceTerminalOpenForGroup ? terminalDockHeight : 0 }}
        >
          <div className="flex min-h-0 flex-1 min-w-0 flex-col border-l border-border bg-surface-elevated/70 shadow-insetHighlight backdrop-blur-sm">
              <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-5 py-4">
                {groupMessages.map(msg => {
                  const presentation = senderPresentation(msg.from);
                  return (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      senderLabel={presentation.senderLabel}
                      avatarLabel={presentation.avatarLabel}
                      avatarBackground={presentation.avatarBackground}
                      avatarLogoUrl={presentation.avatarLogoUrl}
                      avatarPlatform={presentation.avatarPlatform}
                      ownerName={group.ownerName}
                      onTap={msg.from !== 'user' ? () => setDetailMessageId(msg.id) : undefined}
                    />
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {showMention && mentionOptions.length > 0 && (
                <div
                  ref={mentionListRef}
                  className="mx-5 mb-1 max-h-44 min-w-48 max-w-sm overflow-y-auto rounded-xl border border-border-strong bg-surface-muted/95 shadow-panel backdrop-blur-md"
                >
                  {mentionOptions.map((opt, idx) => (
                    <button
                      key={opt.id}
                      data-mention-index={idx}
                      onClick={() => insertMention(opt.insertText)}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                        idx === selectedMentionIdx
                          ? 'bg-accent-muted text-content'
                          : 'text-content hover:bg-surface-hover'
                      }`}
                    >
                      {opt.isAll ? (
                        <svg className="h-4 w-4 text-accent" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                        </svg>
                      ) : (
                        <AgentPresenceIndicator
                          state={getAgentPresence(
                            uniqueAgents.find(agent => agent.id === opt.agentId),
                            presenceContext,
                          )}
                          className="h-2 w-2 rounded-full"
                        />
                      )}
                      <span className="truncate">{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {showSlashMenu && (
                <div
                  ref={slashListRef}
                  className="mx-5 mb-1 max-h-44 min-w-48 max-w-md overflow-y-auto rounded-xl border border-border-strong bg-surface-muted/95 shadow-panel backdrop-blur-md"
                >
                  {slashMenuSource?.kind === 'cli' && (
                    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold text-content">
                          {slashMenuSource.agentName} · {getSupportedAgent(slashMenuSource.platform).name}
                        </div>
                        <div className="truncate text-[10px] text-content-subtle">
                          `/` 将补全 {slashMenuSource.cliLabel} 的命令与 Skill
                        </div>
                      </div>
                      <span className="shrink-0 rounded border border-border/80 bg-surface-elevated/80 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-content-subtle">
                        {slashMenuSource.cliLabel}
                      </span>
                    </div>
                  )}
                  {slashLoading && (
                    <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-content-muted">
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />
                      {slashMenuSource?.kind === 'cli'
                        ? `读取 ${slashMenuSource.cliLabel} 命令与 Skill…`
                        : '读取内置命令…'}
                    </div>
                  )}
                  {slashError && !slashLoading && (
                    <div className="px-3 py-2 text-xs text-amber-400/95">{slashError}</div>
                  )}
                  {!slashLoading && !slashError && slashOptions.length === 0 && (
                    <div className="px-3 py-2.5 text-xs text-content-muted">
                      {slashMenuSource?.kind === 'cli' ? '该 CLI 暂无匹配命令或 Skill' : '暂无匹配的内置命令'}
                    </div>
                  )}
                  {!slashLoading && slashOptions.map((item, idx) => (
                    <button
                      key={item.id}
                      type="button"
                      data-slash-index={idx}
                      onClick={() => insertSlashOption(item)}
                      className={`flex w-full gap-3 px-3 py-2 text-left text-sm transition-colors ${
                        'summary' in item && item.summary ? 'items-start' : 'items-center'
                      } ${
                        idx === selectedSlashIdx
                          ? 'bg-accent-muted text-content'
                          : 'text-content hover:bg-surface-hover'
                      }`}
                    >
                      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                        <span className="truncate font-medium leading-snug">
                          {'insertText' in item && item.insertText.startsWith('/')
                            ? item.insertText
                            : `/${item.name}`}
                        </span>
                        {'summary' in item && item.summary && (
                          <span className="line-clamp-2 text-[11px] leading-snug text-content-muted">{item.summary}</span>
                        )}
                        {'description' in item && (
                          <span className="line-clamp-2 text-[11px] leading-snug text-content-muted">
                            {item.description}
                          </span>
                        )}
                        {'argumentHint' in item && item.argumentHint && (
                          <span className="text-[10px] leading-snug text-content-subtle">{item.argumentHint}</span>
                        )}
                      </div>
                      <span className="shrink-0 rounded border border-border/80 bg-surface-elevated/80 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-content-subtle">
                        {'sourceTag' in item
                          ? item.sourceTag
                          : getSupportedAgent(item.platform).cliLabel}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="border-t border-border px-5 py-4">
                {(isArchivedTaskSession || isChatPaused || sendError) && (
                  <div className={`mb-3 rounded-xl border px-3 py-2 text-sm ${
                    isArchivedTaskSession || isChatPaused
                      ? 'border-border bg-surface-muted text-content-subtle'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  }`}
                  >
                    {isChatPaused
                      ? `同仓库协作任务 ${group.pausedByMissionId} 正在运行，本单聊执行会话已暂停。`
                      : isArchivedTaskSession
                      ? '历史任务仅支持查看，不可继续对话。'
                      : sendError}
                  </div>
                )}
                <div className="flex items-end gap-3">
                  <div className="relative min-w-0 flex-1">
                    {!inputText && (
                      <div className="pointer-events-none absolute inset-x-4 top-1/2 z-[1] -translate-y-1/2 truncate text-sm text-content-subtle">
                        {inputPlaceholder}
                      </div>
                    )}
                    <textarea
                      ref={inputRef}
                      rows={1}
                      placeholder=""
                      aria-label={inputPlaceholder}
                      title={isArchivedTaskSession ? '历史任务只读' : 'Enter 发送，Shift+Enter 换行'}
                      value={inputText}
                      disabled={isArchivedTaskSession || isChatPaused || (requiresTaskSession && !selectedTaskSessionId)}
                      onChange={e => {
                        const v = e.target.value;
                        const c = e.target.selectionStart ?? v.length;
                        setSendError('');
                        setInputText(v);
                        updateCompletionPopup(v, c);
                      }}
                      onSelect={e => {
                        updateCompletionPopup(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
                      }}
                      onCompositionStart={() => { isComposingRef.current = true; }}
                      onCompositionEnd={e => {
                        isComposingRef.current = false;
                        const el = e.currentTarget;
                        updateCompletionPopup(el.value, el.selectionStart ?? el.value.length);
                      }}
                      onKeyDown={handleKeyDown}
                      onDragOver={handleInputDragOver}
                      onDragLeave={handleInputDragLeave}
                      onDrop={handleInputDrop}
                      className={`block w-full resize-none rounded-xl border bg-surface-muted/90 px-4 py-2.5 text-sm leading-relaxed text-content outline-none ring-accent/0 transition focus:border-accent/40 focus:ring-2 focus:ring-accent/25 ${
                        inputDragOver
                          ? 'border-accent/50 ring-2 ring-accent/30'
                          : 'border-border'
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                      style={{ minHeight: CHAT_INPUT_BASELINE_HEIGHT_PX, maxHeight: CHAT_INPUT_MAX_HEIGHT_PX }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={sendMessage}
                    disabled={
                      !inputText.trim()
                      || isArchivedTaskSession
                      || isChatPaused
                      || (requiresTaskSession && !selectedTaskSessionId)
                    }
                    className="h-[43px] shrink-0 self-end rounded-xl bg-accent px-5 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

      {isWorkspacePanelVisible && (
        <div
          className="relative flex min-h-0 w-60 flex-shrink-0 flex-col border-l border-border bg-surface-elevated/50 backdrop-blur-sm transition-[padding] duration-200"
          style={{ paddingBottom: isWorkspaceTerminalOpenForGroup ? terminalDockHeight : 0 }}
        >
          <div
            className={`relative flex min-h-0 flex-1 flex-col transition-colors ${
              workspaceDropOver && filesPath && !workspaceDropTarget ? 'bg-accent/[0.06]' : ''
            }`}
            onDragOver={handleWorkspaceDragOver}
            onDragLeave={handleWorkspaceDragLeave}
            onDrop={e => handleWorkspaceDrop(e, '')}
          >
            {workspaceDropOver && filesPath && !workspaceDropTarget && (
              <div
                className="pointer-events-none absolute inset-0 z-[1] rounded-md border-2 border-dashed border-accent/45 bg-accent/[0.07]"
                aria-hidden
              />
            )}
            <div className="flex h-[50px] items-center gap-2 border-b border-border px-4">
              <svg className="h-4 w-4 flex-shrink-0 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="text-xs font-semibold text-content-muted">工作空间</span>
            </div>

            {filesPath && (
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-content-subtle" title={filesPath}>
                  {filesPath}
                </p>
                <button
                  type="button"
                  onClick={() => setWorkspacePanelMode('git')}
                  className="rounded-md border border-border bg-surface-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-content-subtle transition hover:border-accent/35 hover:text-content"
                  title="打开 Git Changes"
                >
                  Git
                </button>
              </div>
            )}

            <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2 pt-2">
              {workspaceImporting ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />
                  <p className="text-[11px] text-content-subtle">正在导入…</p>
                </div>
              ) : filesLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />
                </div>
              ) : filesError ? (
                <div className="px-2 py-4 text-center">
                  <p className="text-[11px] text-red-400">{filesError}</p>
                </div>
              ) : !filesPath ? (
                <div className="px-2 py-4 text-center">
                  <svg className="mx-auto mb-2 h-8 w-8 text-content-subtle/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <p className="text-[11px] text-content-subtle">未配置工作目录</p>
                </div>
              ) : files.length === 0 ? (
                <div className="px-2 py-4 text-center">
                  <p className="text-[11px] text-content-subtle">目录为空</p>
                  <p className="mt-2 text-[10px] leading-relaxed text-content-subtle/80">
                    可从 Finder 或桌面拖入文件、文件夹
                  </p>
                </div>
              ) : (
                files.map(file => (
                  <FileTreeItem
                    key={file.name}
                    file={file}
                    groupId={group.id}
                    subpath={file.name}
                    depth={0}
                    refreshToken={workspaceRefreshToken}
                    draggable
                    dropEnabled={!!filesPath && !workspaceImporting}
                    activeDropTarget={workspaceDropTarget}
                    onDirectoryDragOver={handleDirectoryDragOver}
                    onDirectoryDragLeave={handleDirectoryDragLeave}
                    onDirectoryDrop={handleWorkspaceDrop}
                  />
                ))
              )}
            </div>
          </div>

        </div>
      )}

      <WorkspaceTerminalDock
        group={group}
        terminals={openWorkspaceTerminals}
        activeTerminalId={activeWorkspaceTerminalId}
        onOpenTerminal={openWorkspaceTerminal}
        onActivateTerminal={activateWorkspaceTerminal}
        onCloseTerminal={closeWorkspaceTerminal}
        onCloseAllTerminals={closeAllWorkspaceTerminals}
        onHeightChange={setTerminalDockHeight}
      />

      {workspacePanelMode === 'git' && (
        <div
          className="fixed inset-0 z-50 flex bg-black/65 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-label="Git Changes"
          onClick={() => setWorkspacePanelMode('workspace')}
        >
          <div
            className="m-3 flex min-h-0 flex-1 overflow-hidden rounded-[28px] border border-border-strong bg-surface shadow-[0_28px_100px_rgba(0,0,0,0.55)] md:m-5"
            onClick={e => e.stopPropagation()}
          >
            <GitChangesView
              groupId={group.id}
              workingDirectory={group.workingDirectory}
              onBack={() => setWorkspacePanelMode('workspace')}
            />
          </div>
        </div>
      )}

      {/* Message detail modal */}
      {detailMessage && (
        <MessageDetailModal
          message={detailMessage}
          ownerName={group.ownerName}
          senderPresentation={senderPresentation(detailMessage.from)}
          onClose={() => setDetailMessageId(null)}
        />
      )}
    </div>
  );
}

function WorkspaceTerminalTrigger({
  group,
  onOpenTerminal,
  isOpen,
  compact = false,
}: {
  group: AgentGroup;
  onOpenTerminal: () => void;
  isOpen: boolean;
  compact?: boolean;
}) {
  const canOpen = !!group.workingDirectory;

  if (!compact && isOpen) return null;
  if (compact && !canOpen) return null;

  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpenTerminal}
        disabled={!canOpen}
        title="新建工作空间终端"
        aria-label="新建工作空间终端"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center text-content-muted transition hover:text-content disabled:cursor-not-allowed disabled:opacity-55"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenTerminal}
      disabled={!canOpen}
      title={canOpen ? '打开工作空间终端' : '未配置工作目录'}
      aria-label="打开工作空间终端"
      className="absolute inset-x-0 bottom-0 z-20 flex h-[75px] items-center gap-3 border-t border-border-strong bg-surface-elevated/96 px-4 py-3 text-left shadow-[0_-18px_36px_rgba(7,9,13,0.26)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-accent/35 hover:text-content disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:border-border-strong"
    >
      <span className="flex h-10 w-10 items-center justify-center text-content-subtle">
        <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-content">工作空间终端</span>
        <span className="mt-0.5 block truncate text-xs text-content-subtle">
          {canOpen ? '打开工作空间终端' : '未配置工作目录'}
        </span>
      </span>
    </button>
  );
}

function WorkspaceTerminalDock({
  group,
  terminals,
  activeTerminalId,
  onOpenTerminal,
  onActivateTerminal,
  onCloseTerminal,
  onCloseAllTerminals,
  onHeightChange,
}: {
  group: AgentGroup;
  terminals: { id: string; number: number }[];
  activeTerminalId: string | null;
  onOpenTerminal: () => void;
  onActivateTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onCloseAllTerminals: () => void;
  onHeightChange: (height: number) => void;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(WORKSPACE_TERMINAL_PANEL_DEFAULT);
  const activeTerminal = terminals.find(t => t.id === activeTerminalId) ?? terminals[0] ?? null;
  const isOpen = terminals.length > 0 && !!activeTerminal;

  const handleTerminalPanelResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalPanelHeight;

    const onMove = (ev: PointerEvent) => {
      const next = Math.round(startH + (startY - ev.clientY));
      setTerminalPanelHeight(clampWorkspaceTerminalPanelHeight(next));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [terminalPanelHeight]);

  useEffect(() => {
    if (!isOpen) return;

    setTerminalPanelHeight(prev => clampWorkspaceTerminalPanelHeight(prev));

    const onWinResize = () => {
      setTerminalPanelHeight(prev => clampWorkspaceTerminalPanelHeight(prev));
    };
    window.addEventListener('resize', onWinResize);
    return () => window.removeEventListener('resize', onWinResize);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      onHeightChange(0);
      return;
    }

    const element = dockRef.current;
    if (!element) return;

    const updateHeight = () => onHeightChange(element.getBoundingClientRect().height);
    updateHeight();

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateHeight)
      : null;
    observer?.observe(element);
    window.addEventListener('resize', updateHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [isOpen, onHeightChange, activeTerminal]);

  if (!isOpen || !activeTerminal) return null;

  return (
    <div
      ref={dockRef}
      className="absolute inset-x-0 bottom-0 z-30 border-t border-border-strong bg-surface-elevated/96 shadow-[0_-24px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
    >
      <div className="flex h-10 items-center justify-between gap-3 border-b border-border/80 px-4">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex min-w-max items-center gap-2">
            {terminals.map(terminal => {
              const isActive = terminal.id === activeTerminal.id;
              const name = `终端(${terminal.number})`;
              return (
                <div
                  key={terminal.id}
                  className={`flex items-center gap-0.5 rounded-lg border px-1.5 py-0.5 ${
                    isActive
                      ? 'border-accent/45 bg-accent/10 text-content shadow-[0_0_0_1px_rgba(255,95,61,0.12)]'
                      : 'border-border/80 bg-surface-muted/80 text-content-subtle'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onActivateTerminal(terminal.id)}
                    className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition hover:text-content"
                    title={`${name} · 工作空间`}
                    aria-label={`切换到 ${name}`}
                  >
                    <span className="truncate font-mono text-xs">{name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onCloseTerminal(terminal.id)}
                    className="rounded-md p-0.5 text-content-subtle transition hover:bg-surface-hover hover:text-content"
                    title={`关闭 ${name}`}
                    aria-label={`关闭 ${name}`}
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={onOpenTerminal}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg bg-surface-muted/80 text-content-subtle transition hover:bg-surface-hover hover:text-content"
              title="新建终端"
              aria-label="新建终端"
            >
              <span className="text-base font-semibold leading-none" aria-hidden>+</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCloseAllTerminals}
            className="rounded-lg p-2 text-content-subtle transition hover:bg-surface-hover hover:text-content"
            title="关闭所有终端"
            aria-label="关闭所有终端"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="px-3 pb-3 pt-1">
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整终端高度"
          className="mb-1 flex h-2 cursor-ns-resize touch-none items-center justify-center rounded-full border border-transparent hover:border-accent/25 hover:bg-accent/10"
          onPointerDown={handleTerminalPanelResizePointerDown}
        >
          <span className="pointer-events-none h-0.5 w-10 rounded-full bg-content-subtle/50" />
        </div>
        <div
          className="overflow-hidden rounded-[8px] border border-border-strong shadow-[0_18px_42px_rgba(0,0,0,0.32)]"
          style={{ height: terminalPanelHeight, background: '#07090d' }}
        >
          <div className="h-full bg-[radial-gradient(circle_at_top,rgba(79,209,197,0.08),transparent_42%),linear-gradient(180deg,rgba(12,15,21,0.98),rgba(7,9,13,1))]">
            <WorkspaceTerminalView groupId={group.id} terminalId={activeTerminal.id} terminalName={`终端(${activeTerminal.number})`} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageDetailModal({
  message, senderPresentation, ownerName, onClose,
}: {
  message: Envelope;
  senderPresentation: {
    senderLabel: string;
    avatarLabel: string;
    avatarBackground: string;
    avatarLogoUrl?: string;
    avatarPlatform?: AgentPlatform;
  };
  ownerName: string;
  onClose: () => void;
}) {
  const isFromUser = message.from === 'user';
  const hasEntries = message.entries && message.entries.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-panel"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-md"
            style={{ background: senderPresentation.avatarBackground }}
          >
            {senderPresentation.avatarLabel}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-content">{senderPresentation.senderLabel}</p>
            <p className="text-xs text-content-muted">
              {new Date(message.ts * 1000).toLocaleString('zh-CN')}
              {hasEntries && <span className="ml-2 text-content-subtle">({message.entries!.length} 条记录)</span>}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-content-subtle transition hover:bg-surface-hover hover:text-content">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-5">
          {hasEntries ? (
            <div className="space-y-2">
              {message.entries!.map(entry => (
                <DetailEntry key={entry.id} entry={entry} avatarPlatform={senderPresentation.avatarPlatform} />
              ))}
            </div>
          ) : (
            <pre className="select-text whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-content">
              {message.body}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailEntry({ entry, avatarPlatform }: { entry: ConversationEntry; avatarPlatform?: AgentPlatform }) {
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const { display: displayText, isPrettyJson: claudeUserPrettyJson } =
    entry.role === 'user' && (avatarPlatform === 'claude-code' || avatarPlatform === 'openclaude')
      ? formatClaudeUserEntryContent(entry.content)
      : { display: entry.content, isPrettyJson: false };

  const roleLabels: Record<string, { label: string; style: string }> = {
    user: { label: 'User', style: 'bg-accent-muted text-accent ring-1 ring-accent/25' },
    assistant: { label: 'Assistant', style: 'bg-surface-muted text-content ring-1 ring-border-strong' },
    thinking: { label: 'Thinking', style: 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/25' },
    tool: { label: entry.toolName || 'Tool', style: 'bg-mint-dim text-mint ring-1 ring-mint/30' },
    system: { label: 'System', style: 'bg-surface-hover text-content-subtle ring-1 ring-border' },
  };

  const { label, style } = roleLabels[entry.role] || roleLabels.system;

  return (
    <div className="select-text">
      <div className="mb-0.5 flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style}`}>{label}</span>
        <span className="text-[10px] text-content-subtle">{fmtTime(entry.timestamp)}</span>
        {entry.tokens && (
          <span className="text-[10px] text-content-subtle">
            in:{entry.tokens.input.toLocaleString()} out:{entry.tokens.output.toLocaleString()}
          </span>
        )}
        {entry.cost != null && entry.cost > 0 && (
          <span className="text-[10px] text-content-subtle">${entry.cost.toFixed(4)}</span>
        )}
      </div>
      <pre
        className={`rounded-lg px-2 py-1.5 whitespace-pre-wrap break-words ${
          entry.role === 'tool'
            ? 'bg-surface-muted font-mono text-xs text-content-muted'
            : claudeUserPrettyJson
              ? 'font-mono text-xs leading-relaxed text-content'
              : 'font-sans text-sm text-content'
        }`}
      >
        {displayText}
      </pre>
    </div>
  );
}

function FileTreeItem({
  file,
  groupId,
  subpath,
  depth,
  refreshToken,
  draggable: draggableProp,
  dropEnabled = false,
  activeDropTarget = '',
  onDirectoryDragOver,
  onDirectoryDragLeave,
  onDirectoryDrop,
}: {
  file: FileEntry;
  groupId: string;
  subpath: string;
  depth: number;
  refreshToken: number;
  draggable?: boolean;
  dropEnabled?: boolean;
  activeDropTarget?: string;
  onDirectoryDragOver?: (e: React.DragEvent<HTMLButtonElement>, subpath: string) => void;
  onDirectoryDragLeave?: (e: React.DragEvent<HTMLButtonElement>, subpath: string) => void;
  onDirectoryDrop?: (e: React.DragEvent, subpath: string) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvedParentPath, setResolvedParentPath] = useState('');
  const autoExpandTimeoutRef = useRef<number | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const clearAutoExpandTimer = useCallback(() => {
    if (autoExpandTimeoutRef.current != null) {
      window.clearTimeout(autoExpandTimeoutRef.current);
      autoExpandTimeoutRef.current = null;
    }
  }, []);

  const ensureChildrenLoaded = useCallback(async (force = false) => {
    if (!force && children.length > 0) return;
    setLoading(true);
    try {
      const data = await api.listGroupFiles(groupId, subpath);
      setChildren(data.files);
      setResolvedParentPath(data.path);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [children.length, groupId, subpath]);

  const openDirectory = useCallback(async () => {
    if (expanded || loading) return;
    await ensureChildrenLoaded();
    setExpanded(true);
  }, [ensureChildrenLoaded, expanded, loading]);

  const toggleExpand = async () => {
    clearAutoExpandTimer();
    if (!expanded) {
      await ensureChildrenLoaded();
      setExpanded(true);
      return;
    }
    setExpanded(false);
  };

  useEffect(() => () => {
    clearAutoExpandTimer();
  }, [clearAutoExpandTimer]);

  useEffect(() => {
    if (!expanded || refreshToken === 0) return;
    void ensureChildrenLoaded(true);
  }, [ensureChildrenLoaded, expanded, refreshToken]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onPointer = (e: PointerEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const resolveAbsolutePath = useCallback(async (): Promise<string | null> => {
    try {
      if (file.type === 'directory') {
        const data = await api.listGroupFiles(groupId, subpath);
        return data.path || null;
      }
      const parentSubpath = subpath.includes('/') ? subpath.slice(0, subpath.lastIndexOf('/')) : '';
      const data = await api.listGroupFiles(groupId, parentSubpath);
      return `${data.path}/${file.name}`;
    } catch {
      return null;
    }
  }, [file.type, file.name, groupId, subpath]);

  const handleRevealInFinder = useCallback(async () => {
    setCtxMenu(null);
    const abs = await resolveAbsolutePath();
    if (!abs) return;
    try {
      await api.revealInFinder(abs);
    } catch {
      /* ignore */
    }
  }, [resolveAbsolutePath]);

  const openWorkspaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const workspaceContextMenu =
    ctxMenu
    && createPortal(
      <div
        ref={ctxMenuRef}
        role="menu"
        className="fixed z-[200] min-w-[168px] rounded-lg border border-border-strong bg-surface-elevated py-1 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        style={{ left: ctxMenu.x, top: ctxMenu.y }}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center px-3 py-2 text-left text-xs text-content hover:bg-surface-hover"
          onClick={() => void handleRevealInFinder()}
        >
          在 Finder 显示
        </button>
      </div>,
      document.body,
    );

  const handleDirectoryNodeDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    onDirectoryDragOver?.(e, subpath);
    if (!dropEnabled || expanded || loading || autoExpandTimeoutRef.current != null) return;
    autoExpandTimeoutRef.current = window.setTimeout(() => {
      autoExpandTimeoutRef.current = null;
      void openDirectory();
    }, DIRECTORY_AUTO_EXPAND_DELAY_MS);
  };

  const handleDirectoryNodeDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
    clearAutoExpandTimer();
    onDirectoryDragLeave?.(e, subpath);
  };

  const handleDirectoryNodeDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    clearAutoExpandTimer();
    return onDirectoryDrop?.(e, subpath);
  };

  const handleTreeDragStart = (e: React.DragEvent) => {
    clearAutoExpandTimer();
    e.dataTransfer.setData('text/plain', subpath);
    e.dataTransfer.setData(WORKSPACE_RELPATH_MIME, subpath);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDoubleClick = async () => {
    if (file.type === 'directory') return;
    try {
      const parentSubpath = subpath.includes('/') ? subpath.slice(0, subpath.lastIndexOf('/')) : '';
      const data = await api.listGroupFiles(groupId, parentSubpath);
      await api.openFile(`${data.path}/${file.name}`);
    } catch { /* ignore */ }
  };

  const paddingLeft = depth * 12 + 8;
  const isDirectoryDropTarget = dropEnabled && activeDropTarget === subpath;
  const isHiddenWorkspaceEntry = file.name.startsWith('.');

  if (file.type === 'directory') {
    return (
      <>
        <div>
        <button
          type="button"
          draggable={draggableProp}
          onDragStart={draggableProp ? handleTreeDragStart : undefined}
          onDragOver={dropEnabled ? handleDirectoryNodeDragOver : undefined}
          onDragLeave={dropEnabled ? handleDirectoryNodeDragLeave : undefined}
          onDrop={dropEnabled ? handleDirectoryNodeDrop : undefined}
          onClick={toggleExpand}
          onContextMenu={openWorkspaceContextMenu}
          className={`flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-xs transition ${
            isDirectoryDropTarget
              ? 'bg-accent/[0.12] text-content ring-1 ring-accent/40'
              : isHiddenWorkspaceEntry
                ? 'text-content-subtle/80 hover:bg-surface-hover/45'
                : 'text-content-muted hover:bg-surface-hover/60'
          } ${
            draggableProp ? 'cursor-grab active:cursor-grabbing' : ''
          }`}
          style={{ paddingLeft }}
          title={draggableProp ? '展开/收起；可拖到输入框引用路径，也可将外部文件拖到此文件夹导入' : undefined}
        >
          <svg
            className={`h-3 w-3 flex-shrink-0 transition-transform ${
              isDirectoryDropTarget ? 'text-accent' : isHiddenWorkspaceEntry ? 'text-content-subtle/55' : 'text-content-subtle'
            } ${expanded ? 'rotate-90' : ''}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
          </svg>
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 ${
              isDirectoryDropTarget ? 'text-amber-400/80' : isHiddenWorkspaceEntry ? 'text-amber-400/45' : 'text-amber-400/80'
            }`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="truncate">{file.name}</span>
          {loading && (
            <div className="ml-auto h-3 w-3 flex-shrink-0 animate-spin rounded-full border border-content-subtle border-t-accent" />
          )}
        </button>
        {expanded && children.length > 0 && (
          <div>
            {children.map(child => (
              <FileTreeItem
                key={child.name}
                file={child}
                groupId={groupId}
                subpath={`${subpath}/${child.name}`}
                depth={depth + 1}
                refreshToken={refreshToken}
                draggable={draggableProp}
                dropEnabled={dropEnabled}
                activeDropTarget={activeDropTarget}
                onDirectoryDragOver={onDirectoryDragOver}
                onDirectoryDragLeave={onDirectoryDragLeave}
                onDirectoryDrop={onDirectoryDrop}
              />
            ))}
          </div>
        )}
        {expanded && !loading && children.length === 0 && (
          <p className="py-1 text-[10px] text-content-subtle" style={{ paddingLeft: paddingLeft + 20 }}>空</p>
        )}
        </div>
        {workspaceContextMenu}
      </>
    );
  }

  return (
    <>
    <div
      draggable={draggableProp}
      onDragStart={draggableProp ? handleTreeDragStart : undefined}
      className={`flex items-center gap-1.5 rounded-lg py-1 pr-2 text-xs transition hover:bg-surface-hover/60 ${
        isHiddenWorkspaceEntry ? 'text-content-subtle/80' : 'text-content-muted'
      } ${draggableProp ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
      style={{ paddingLeft: paddingLeft + 15 }}
      onDoubleClick={handleDoubleClick}
      onContextMenu={openWorkspaceContextMenu}
      title={draggableProp ? '双击打开文件；可拖到下方输入框引用路径' : '双击打开文件'}
    >
      <svg
        className={`h-3.5 w-3.5 flex-shrink-0 ${isHiddenWorkspaceEntry ? 'text-content-subtle/55' : 'text-content-subtle'}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
      <span className="truncate">{file.name}</span>
    </div>
    {workspaceContextMenu}
    </>
  );
}
