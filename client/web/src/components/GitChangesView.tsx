import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { GitChangeSection, GitDiffView, GitStatusEntry, GitWorkspaceStatus } from '../types';

interface GitChangesViewProps {
  groupId: string;
  workingDirectory?: string;
  bottomInset?: number;
  onBack: () => void;
}

interface DiffRow {
  key: string;
  leftNumber: number | null;
  rightNumber: number | null;
  leftText: string;
  rightText: string;
  leftType: 'context' | 'remove' | 'empty';
  rightType: 'context' | 'add' | 'empty';
  blockId: string | null;
}

const SECTION_META: Record<GitChangeSection, { title: string; action: string }> = {
  staged: { title: 'Staged Changes', action: 'Unstage' },
  unstaged: { title: 'Changes', action: 'Stage' },
  untracked: { title: 'Unversioned Files', action: 'Stage' },
};

function selectionKey(entry: Pick<GitStatusEntry, 'path' | 'section'>) {
  return `${entry.section}:${entry.path}`;
}

function statusBadge(kind: GitStatusEntry['kind']) {
  switch (kind) {
    case 'added':
      return { label: 'A', className: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-200' };
    case 'deleted':
      return { label: 'D', className: 'border-red-500/30 bg-red-500/12 text-red-200' };
    default:
      return { label: 'M', className: 'border-amber-500/30 bg-amber-500/12 text-amber-200' };
  }
}

function splitLines(text: string) {
  if (!text) return [] as string[];
  const normalized = text.replace(/\r\n/g, '\n').split('\n');
  if (normalized.length > 0 && normalized[normalized.length - 1] === '') {
    normalized.pop();
  }
  return normalized;
}

function longestCommonSubsequence(before: string[], after: string[]) {
  const rows = before.length;
  const cols = after.length;
  const matrix = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      matrix[i][j] = before[i] === after[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const ops: Array<{ type: 'equal' | 'remove' | 'add'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', text: before[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ type: 'remove', text: before[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: after[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ type: 'remove', text: before[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ type: 'add', text: after[j] });
    j += 1;
  }

  return ops;
}

function buildDiffRows(beforeText: string, afterText: string): DiffRow[] {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const rows: DiffRow[] = [];

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);
  const useFallback = middleBefore.length * middleAfter.length > 50_000;
  const operations = useFallback
    ? [
      ...middleBefore.map(text => ({ type: 'remove' as const, text })),
      ...middleAfter.map(text => ({ type: 'add' as const, text })),
    ]
    : longestCommonSubsequence(middleBefore, middleAfter);

  let leftLine = 1;
  let rightLine = 1;

  const pushContext = (text: string, key: string) => {
    rows.push({
      key,
      leftNumber: leftLine,
      rightNumber: rightLine,
      leftText: text,
      rightText: text,
      leftType: 'context',
      rightType: 'context',
      blockId: null,
    });
    leftLine += 1;
    rightLine += 1;
  };

  const pushChangedBlock = (removed: string[], added: string[], blockKey: string) => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      const leftText = removed[index] ?? '';
      const rightText = added[index] ?? '';
      const hasLeft = index < removed.length;
      const hasRight = index < added.length;
      rows.push({
        key: `${blockKey}-${index}`,
        leftNumber: hasLeft ? leftLine : null,
        rightNumber: hasRight ? rightLine : null,
        leftText,
        rightText,
        leftType: hasLeft ? 'remove' : 'empty',
        rightType: hasRight ? 'add' : 'empty',
        blockId: blockKey,
      });
      if (hasLeft) leftLine += 1;
      if (hasRight) rightLine += 1;
    }
  };

  before.slice(0, prefix).forEach((line, index) => pushContext(line, `prefix-${index}`));

  let pendingRemoved: string[] = [];
  let pendingAdded: string[] = [];
  let blockIndex = 0;
  const flushChanged = () => {
    if (pendingRemoved.length === 0 && pendingAdded.length === 0) return;
    pushChangedBlock(pendingRemoved, pendingAdded, `middle-${blockIndex}`);
    pendingRemoved = [];
    pendingAdded = [];
    blockIndex += 1;
  };

  for (const operation of operations) {
    if (operation.type === 'equal') {
      flushChanged();
      pushContext(operation.text, `equal-${blockIndex}-${leftLine}-${rightLine}`);
      continue;
    }
    if (operation.type === 'remove') {
      pendingRemoved.push(operation.text);
    } else {
      pendingAdded.push(operation.text);
    }
  }
  flushChanged();

  before.slice(before.length - suffix).forEach((line, index) => pushContext(line, `suffix-${index}`));

  return rows;
}

function getPalette(type: 'context' | 'remove' | 'add' | 'empty') {
  if (type === 'remove') return 'bg-red-500/15 text-red-100';
  if (type === 'add') return 'bg-emerald-500/15 text-emerald-100';
  if (type === 'empty') return 'bg-black/20 text-content-subtle/40';
  return 'text-content';
}

function getGutterPalette(type: 'context' | 'remove' | 'add' | 'empty') {
  if (type === 'remove') return 'bg-red-500/10 text-red-300/70';
  if (type === 'add') return 'bg-emerald-500/10 text-emerald-300/70';
  if (type === 'empty') return 'bg-black/20 text-content-subtle/40';
  return 'bg-white/[0.02] text-content-subtle/50';
}

export function GitChangesView({
  groupId,
  workingDirectory,
  bottomInset = 0,
  onBack,
}: GitChangesViewProps) {
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectionHint, setSelectionHint] = useState<{ path: string; section?: GitChangeSection } | null>(null);
  const [diff, setDiff] = useState<GitDiffView | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [revertingBlock, setRevertingBlock] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<GitChangeSection, boolean>>({
    staged: true,
    unstaged: true,
    untracked: true,
  });
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(320);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(800, startWidth + (moveEvent.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };

    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  const toggleSection = (section: GitChangeSection) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const isSectionFullyChecked = (section: GitChangeSection) => {
    const entries = entriesBySection[section];
    if (entries.length === 0) return false;
    return entries.every(entry => checkedItems.has(selectionKey(entry)));
  };

  const isSectionPartiallyChecked = (section: GitChangeSection) => {
    const entries = entriesBySection[section];
    if (entries.length === 0) return false;
    const checkedCount = entries.filter(entry => checkedItems.has(selectionKey(entry))).length;
    return checkedCount > 0 && checkedCount < entries.length;
  };

  const handleSectionCheck = (section: GitChangeSection, checked: boolean) => {
    const entries = entriesBySection[section];
    setCheckedItems(prev => {
      const next = new Set(prev);
      if (checked) {
        entries.forEach(entry => next.add(selectionKey(entry)));
      } else {
        entries.forEach(entry => next.delete(selectionKey(entry)));
      }
      return next;
    });
  };

  const handleItemCheck = (key: string, checked: boolean) => {
    setCheckedItems(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError('');
    try {
      const nextStatus = await api.getGitStatus(groupId);
      setStatus(nextStatus);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const entriesBySection = useMemo(() => {
    const sections: Record<GitChangeSection, GitStatusEntry[]> = {
      staged: [],
      unstaged: [],
      untracked: [],
    };
    for (const entry of status?.entries ?? []) {
      sections[entry.section].push(entry);
    }
    return sections;
  }, [status]);

  const allEntries = status?.entries ?? [];
  const selectedEntry = useMemo(
    () => allEntries.find(entry => selectionKey(entry) === selectedKey) ?? null,
    [allEntries, selectedKey],
  );

  useEffect(() => {
    if (allEntries.length === 0) {
      setSelectedKey(null);
      setDiff(null);
      return;
    }

    const hinted = selectionHint
      ? allEntries.find(entry =>
        entry.path === selectionHint.path && (!selectionHint.section || entry.section === selectionHint.section),
      ) ?? allEntries.find(entry => entry.path === selectionHint.path)
      : null;
    if (hinted) {
      setSelectedKey(selectionKey(hinted));
      setSelectionHint(null);
      return;
    }

    if (!selectedKey || !allEntries.some(entry => selectionKey(entry) === selectedKey)) {
      setSelectedKey(selectionKey(allEntries[0]));
    }
  }, [allEntries, selectedKey, selectionHint]);

  useEffect(() => {
    if (!selectedEntry) {
      setDiff(null);
      setDiffError('');
      return;
    }

    let cancelled = false;
    setDiffLoading(true);
    setDiffError('');
    api.getGitDiff(groupId, selectedEntry.path, selectedEntry.section, selectedEntry.kind)
      .then(result => {
        if (!cancelled) setDiff(result);
      })
      .catch(error => {
        if (!cancelled) {
          setDiff(null);
          setDiffError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => { cancelled = true; };
  }, [groupId, selectedEntry]);

  const handleStageToggle = useCallback(async (entry: GitStatusEntry) => {
    const nextSection = entry.section === 'staged' ? undefined : 'staged';
    setActionKey(selectionKey(entry));
    setSelectionHint({ path: entry.path, section: nextSection });
    try {
      if (entry.section === 'staged') {
        await api.unstageGitPath(groupId, entry.path);
      } else {
        await api.stageGitPath(groupId, entry.path);
      }
      await refreshStatus();
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey(null);
    }
  }, [groupId, refreshStatus]);

  const handleRollbackSelected = useCallback(async () => {
    if (!workingDirectory || checkedItems.size === 0) return;
    try {
      setStatusLoading(true);
      const pathsToRollback = allEntries
        .filter(entry => checkedItems.has(selectionKey(entry)))
        .map(entry => entry.path);
        
      if (pathsToRollback.length > 0) {
        await api.rollbackGitPaths(groupId, pathsToRollback);
      }
      setCheckedItems(new Set());
      await refreshStatus();
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusLoading(false);
    }
  }, [groupId, workingDirectory, checkedItems, allEntries, refreshStatus]);

  const rows = useMemo(
    () => diff && !diff.isBinary ? buildDiffRows(diff.before.text, diff.after.text) : [],
    [diff],
  );

  const handleRevertBlock = useCallback(async (blockId: string) => {
    if (!diff || !selectedEntry || !workingDirectory) return;
    setRevertingBlock(blockId);
    try {
      const newLines: string[] = [];
      for (const row of rows) {
        if (row.blockId === blockId) {
          if (row.leftType !== 'empty') {
            newLines.push(row.leftText);
          }
        } else {
          if (row.rightType === 'context' || row.rightType === 'add') {
            newLines.push(row.rightText);
          }
        }
      }
      let newText = newLines.join('\n');
      if (diff.after.text.endsWith('\n') && !newText.endsWith('\n')) {
        newText += '\n';
      }
      if (diff.after.text.includes('\r\n')) {
        newText = newText.replace(/\n/g, '\r\n');
      }

      await api.writeFile(groupId, selectedEntry.path, newText);
      
      const result = await api.getGitDiff(groupId, selectedEntry.path, selectedEntry.section, selectedEntry.kind);
      setDiff(result);
      await refreshStatus();
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevertingBlock(null);
    }
  }, [diff, rows, selectedEntry, workingDirectory, groupId, refreshStatus]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: bottomInset }}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="rounded-xl border border-border bg-surface-muted px-3 py-1.5 text-sm text-content transition hover:border-accent/35 hover:bg-surface-hover"
            >
              返回工作空间
            </button>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-content">Git Changes</h3>
              <p className="truncate text-xs text-content-subtle" title={workingDirectory || ''}>
                {workingDirectory || '未配置工作目录'}
              </p>
            </div>
          </div>
          {status?.isGitRepository && (
            <p className="mt-1 text-xs text-content-muted">
              {status.branch ? `分支 ${status.branch}` : 'Git 仓库'}
            </p>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside 
          className="relative flex flex-shrink-0 flex-col border-r border-border bg-[#1E1F22]"
          style={{ width: sidebarWidth }}
        >
          <div 
            className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 z-10 transition-colors"
            style={{ transform: 'translateX(50%)' }}
            onMouseDown={startResizing}
          />
          <div className="flex items-center gap-2 border-b border-border/80 px-3 py-2">
            <button
              type="button"
              onClick={() => void refreshStatus()}
              className="rounded p-1 text-content-subtle hover:bg-white/10 hover:text-content transition"
              title="Refresh"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            </button>
            <button
              type="button"
              onClick={handleRollbackSelected}
              disabled={checkedItems.size === 0}
              className="rounded p-1 text-content-subtle hover:bg-white/10 hover:text-content transition disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-content-subtle"
              title="Rollback Selected"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            </button>
          </div>

          <div className="scrollbar-thin flex-1 overflow-y-auto py-2">
            {statusLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />
              </div>
            ) : statusError ? (
              <div className="m-2 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-3 text-sm text-red-200">
                {statusError}
              </div>
            ) : !workingDirectory ? (
              <div className="m-2 rounded-xl border border-border bg-surface-muted px-3 py-4 text-sm text-content-subtle">
                当前群组还没有配置工作目录。
              </div>
            ) : !status?.isGitRepository ? (
              <div className="m-2 rounded-xl border border-border bg-surface-muted px-3 py-4 text-sm text-content-subtle">
                当前工作空间不是 Git 仓库。
              </div>
            ) : allEntries.length === 0 ? (
              <div className="m-2 rounded-xl border border-border bg-surface-muted px-3 py-4 text-sm text-content-subtle">
                工作区干净，没有待查看的变更。
              </div>
            ) : (
              (Object.keys(SECTION_META) as GitChangeSection[]).map(section => {
                const entries = entriesBySection[section];
                if (entries.length === 0) return null;
                const isExpanded = expandedSections[section];
                const isChecked = isSectionFullyChecked(section);
                const isIndeterminate = isSectionPartiallyChecked(section);
                
                return (
                  <div key={section} className="mb-2">
                    <div 
                      className="flex w-full items-center gap-1.5 px-2 py-1 text-sm font-medium text-content-subtle hover:bg-white/5 transition cursor-pointer"
                      onClick={() => toggleSection(section)}
                    >
                      <div className="flex items-center justify-center w-4 h-4">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        >
                          <path d="m9 18 6-6-6-6"/>
                        </svg>
                      </div>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        ref={el => { if (el) el.indeterminate = isIndeterminate; }}
                        onChange={(e) => handleSectionCheck(section, e.target.checked)}
                        onClick={e => e.stopPropagation()}
                        className="w-3.5 h-3.5 rounded border border-[#5E6063] bg-transparent text-[#3574F0] focus:ring-0 focus:ring-offset-0 cursor-pointer flex-shrink-0 appearance-none checked:bg-[#3574F0] checked:border-transparent checked:bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%2220%206%209%2017%204%2012%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')] indeterminate:bg-[#3574F0] indeterminate:border-transparent indeterminate:bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cline%20x1%3D%225%22%20y1%3D%2212%22%20x2%3D%2219%22%20y2%3D%2212%22%3E%3C%2Fline%3E%3C%2Fsvg%3E')]"
                      />
                      <div className="flex-1 text-left flex items-center gap-1">
                        {SECTION_META[section].title}
                        <span className="text-content-subtle/50 text-xs ml-1">{entries.length} files</span>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="mt-1">
                        {entries.map(entry => {
                          const badge = statusBadge(entry.kind);
                          const itemKey = selectionKey(entry);
                          const isSelected = itemKey === selectedKey;
                          const isItemChecked = checkedItems.has(itemKey);
                          
                          // WebStorm style filename coloring
                          const nameColorClass = section === 'untracked' ? 'text-[#D25252]'
                            : entry.kind === 'added' ? 'text-[#629755]' 
                            : entry.kind === 'deleted' ? 'text-[#6B6C73]'
                            : 'text-[#6897BB]'; // modified

                          return (
                            <div
                              key={itemKey}
                              onClick={() => setSelectedKey(itemKey)}
                              className={`flex w-full items-center px-2 py-1 text-left text-sm transition cursor-pointer ${
                                isSelected
                                  ? 'bg-[#2B2D30] text-content'
                                  : 'text-content-subtle hover:bg-[#2B2D30]/50'
                              }`}
                            >
                              <div className="flex w-[38px] items-center justify-center opacity-0 flex-shrink-0">
                                {/* Padding to align with header chevron */}
                              </div>
                              <input
                                type="checkbox"
                                checked={isItemChecked}
                                onChange={(e) => handleItemCheck(itemKey, e.target.checked)}
                                onClick={e => e.stopPropagation()}
                                className="w-3.5 h-3.5 rounded border border-[#5E6063] bg-transparent text-[#3574F0] focus:ring-0 focus:ring-offset-0 cursor-pointer mr-2 flex-shrink-0 appearance-none checked:bg-[#3574F0] checked:border-transparent checked:bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%2220%206%209%2017%204%2012%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')]"
                              />
                              <div className="flex-1 flex items-center gap-2 overflow-hidden min-w-0">
                                <div className="flex w-4 items-center justify-center flex-shrink-0">
                                  <span className={`text-[10px] font-bold ${nameColorClass}`}>
                                    {badge.label === 'M' ? 'M↓' : badge.label}
                                  </span>
                                </div>
                                <span className={`truncate ${nameColorClass}`}>
                                  {entry.path.split('/').pop()}
                                </span>
                                <span className="truncate text-xs text-[#6B6C73] ml-1 flex-shrink-0 max-w-[50%]">
                                  {entry.path.split('/').slice(0, -1).join('/')}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-content" title={selectedEntry?.path || ''}>
                {selectedEntry?.path || '选择一个文件查看 diff'}
              </div>
              {selectedEntry && (
                <p className="mt-0.5 text-xs text-content-subtle">
                  {SECTION_META[selectedEntry.section].title}
                </p>
              )}
            </div>

            {selectedEntry && (
              <button
                type="button"
                onClick={() => void handleStageToggle(selectedEntry)}
                disabled={actionKey === selectionKey(selectedEntry)}
                className="rounded-xl border border-border bg-surface-muted px-3 py-1.5 text-sm text-content transition hover:border-accent/35 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionKey === selectionKey(selectedEntry) ? '处理中' : SECTION_META[selectedEntry.section].action}
              </button>
            )}
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-4 py-4">
            {diffLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />
              </div>
            ) : diffError ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-4 text-sm text-red-200">
                {diffError}
              </div>
            ) : !selectedEntry ? (
              <div className="rounded-2xl border border-border bg-surface-elevated/55 px-6 py-8 text-center text-sm text-content-subtle">
                从左侧选择一个变更文件以查看内容差异。
              </div>
            ) : diff?.isBinary ? (
              <div className="rounded-2xl border border-border bg-surface-elevated/55 px-6 py-8 text-center text-sm text-content-subtle">
                当前文件为二进制内容，暂不展示文本 diff。
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border-strong bg-[#0b0f15] shadow-[0_18px_48px_rgba(0,0,0,0.28)]">
                <div className="grid grid-cols-[minmax(0,1fr)_44px_28px_44px_minmax(0,1fr)] border-b border-border-strong text-xs text-content-subtle">
                  <div className="px-4 py-2">{diff?.beforeLabel || 'Before'}</div>
                  <div className="col-span-3 bg-white/[0.02]" />
                  <div className="px-4 py-2">{diff?.afterLabel || 'After'}</div>
                </div>

                {rows.length === 0 ? (
                  <div className="px-6 py-10 text-center text-sm text-content-subtle">
                    该文件当前没有可展示的文本差异。
                  </div>
                ) : (
                  <div className="font-mono text-[12px] leading-[24px]">
                    {rows.map((row, index) => {
                      const isFirstInBlock = row.blockId && (index === 0 || rows[index - 1].blockId !== row.blockId);
                      const canRevert = selectedEntry?.section === 'unstaged';
                      return (
                        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_44px_28px_44px_minmax(0,1fr)] hover:bg-white/[0.02] group">
                          <div className={`overflow-hidden px-4 whitespace-pre ${getPalette(row.leftType)}`}>
                            {row.leftText || ' '}
                          </div>
                          <div className={`pr-3 pl-1 text-right select-none border-r border-white/[0.04] ${getGutterPalette(row.leftType)}`}>
                            {row.leftNumber ?? ''}
                          </div>
                          <div className={`flex items-center justify-center border-r border-white/[0.04] bg-white/[0.02] ${row.blockId ? 'bg-white/[0.04]' : ''}`}>
                            {isFirstInBlock && canRevert && (
                              <button
                                type="button"
                                onClick={() => void handleRevertBlock(row.blockId!)}
                                disabled={revertingBlock === row.blockId}
                                className="text-content-subtle hover:text-accent transition disabled:opacity-50"
                                title="撤销此更改"
                              >
                                {revertingBlock === row.blockId ? '...' : (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m13 17 5-5-5-5"/><path d="m6 17 5-5-5-5"/></svg>
                                )}
                              </button>
                            )}
                          </div>
                          <div className={`pr-3 pl-1 text-right select-none ${getGutterPalette(row.rightType)}`}>
                            {row.rightNumber ?? ''}
                          </div>
                          <div className={`overflow-hidden px-4 whitespace-pre ${getPalette(row.rightType)}`}>
                            {row.rightText || ' '}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
