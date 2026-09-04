import { useState, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import { isFullBleedAgentLogo, type AgentPlatform } from '../agent-platforms';
import { formatClaudeUserEntryContent } from '../lib/formatClaudeUserEntryContent';
import type { Envelope, ConversationEntry } from '../types';

interface Props {
  message: Envelope;
  senderLabel: string;
  avatarLabel: string;
  avatarBackground: string;
  avatarLogoUrl?: string;
  avatarPlatform?: AgentPlatform;
  ownerName: string;
  onTap?: () => void;
}

const AI_PREVIEW_LINE_LIMIT = 8;
const PRETEXT_FALLBACK_FONT = '400 14px sans-serif';
const PRETEXT_LINE_HEIGHT = 22;

function visibleConversationEntries(entries: ConversationEntry[]): ConversationEntry[] {
  const nonEmptyEntries = entries.filter(entry => entry.content.trim().length > 0);
  const hasFinalAnswer = nonEmptyEntries.some(
    entry => entry.role === 'assistant' && entry.phase === 'final_answer',
  );
  if (!hasFinalAnswer) return nonEmptyEntries;
  return nonEmptyEntries.filter(
    entry => entry.role !== 'assistant' || entry.phase === 'final_answer',
  );
}

export function MessageBubble({
  message,
  senderLabel,
  avatarLabel,
  avatarBackground,
  avatarLogoUrl,
  avatarPlatform,
  ownerName,
  onTap,
}: Props) {
  const isFromUser = message.from === 'user';

  if (message.entries && message.entries.length > 0 && !isFromUser) {
    return (
      <StructuredMessageBubble
        message={message}
        senderLabel={senderLabel}
        avatarLabel={avatarLabel}
        avatarBackground={avatarBackground}
        avatarLogoUrl={avatarLogoUrl}
        avatarPlatform={avatarPlatform}
      />
    );
  }

  const truncatedBody = !isFromUser
    ? message.body.split('\n').slice(0, AI_PREVIEW_LINE_LIMIT).join('\n')
    : message.body;
  const isTruncated = !isFromUser && message.body.split('\n').length > AI_PREVIEW_LINE_LIMIT;

  return (
    <div className={`flex gap-3 ${isFromUser ? 'flex-row-reverse' : ''}`}>
      <MessageAvatar
        avatarLabel={avatarLabel}
        avatarBackground={avatarBackground}
        avatarLogoUrl={avatarLogoUrl}
        avatarPlatform={avatarPlatform}
      />

      <div className={`flex min-w-0 max-w-[70%] flex-col ${isFromUser ? 'items-end' : 'items-start'}`}>
        <div className={`mb-1 flex items-center gap-1 text-[11px] text-content-muted ${isFromUser ? 'justify-end' : ''}`}>
          <span className="font-medium">{senderLabel}</span>
          {message.to && message.to !== '' && (
            <>
              <svg className="h-2.5 w-2.5 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span>{message.to === 'user' ? ownerName : message.to}</span>
            </>
          )}
        </div>

        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed ${
            isFromUser
              ? 'rounded-tr-md text-white shadow-glow'
              : 'cursor-pointer border border-border bg-surface-muted/90 text-content shadow-sm transition hover:border-border-strong hover:bg-surface-hover rounded-tl-md'
          }`}
          style={isFromUser ? { background: avatarBackground } : undefined}
          onClick={!isFromUser ? onTap : undefined}
        >
          {truncatedBody}
          {isTruncated && (
            <span className="ml-1 text-xs text-content-subtle">… 点击查看全文</span>
          )}
        </div>

        <span className={`mt-1 text-[10px] tabular-nums text-content-subtle ${isFromUser ? 'text-right' : ''}`}>
          {new Date(message.ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>

      <div className="min-w-[48px] flex-1" />
    </div>
  );
}

// --- Structured agent message with ConversationEntry bubbles ---

function StructuredMessageBubble({
  message,
  senderLabel,
  avatarLabel,
  avatarBackground,
  avatarLogoUrl,
  avatarPlatform,
}: {
  message: Envelope;
  senderLabel: string;
  avatarLabel: string;
  avatarBackground: string;
  avatarLogoUrl?: string;
  avatarPlatform?: AgentPlatform;
}) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const entries = useMemo(() => visibleConversationEntries(message.entries!), [message.entries]);

  return (
    <div className="flex gap-3">
      <MessageAvatar
        avatarLabel={avatarLabel}
        avatarBackground={avatarBackground}
        avatarLogoUrl={avatarLogoUrl}
        avatarPlatform={avatarPlatform}
        wrapperClassName="mt-0.5"
      />

      <div className="flex min-w-0 max-w-[75%] flex-col">
        <div className="mb-1.5 flex items-center gap-1 text-[11px] text-content-muted">
          <span className="font-medium">{senderLabel}</span>
          {message.to && message.to !== '' && (
            <>
              <svg className="h-2.5 w-2.5 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span>{message.to === 'user' ? '群主' : message.to}</span>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          {entries.length > 0 ? (
            entries.map(entry => (
              <EntryBubble
                key={entry.id}
                entry={entry}
                avatarPlatform={avatarPlatform}
                collapsed={collapsedIds.has(entry.id)}
                onToggle={() => toggleCollapse(entry.id)}
              />
            ))
          ) : (
            <div className="rounded-xl border border-border bg-surface-muted/95 px-3 py-2 text-sm leading-relaxed text-content shadow-sm">
              {message.body}
            </div>
          )}
        </div>

        <span className="mt-1 text-[10px] tabular-nums text-content-subtle">
          {new Date(message.ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>

      <div className="min-w-[48px] flex-1" />
    </div>
  );
}

function MessageAvatar({
  avatarLabel,
  avatarBackground,
  avatarLogoUrl,
  avatarPlatform,
  wrapperClassName = '',
}: {
  avatarLabel: string;
  avatarBackground: string;
  avatarLogoUrl?: string;
  avatarPlatform?: AgentPlatform;
  wrapperClassName?: string;
}) {
  const logoImgClass =
    avatarPlatform && isFullBleedAgentLogo(avatarPlatform)
      ? 'h-full w-full object-cover object-center'
      : 'box-border h-full w-full p-1.5 object-contain object-center';

  return (
    <div
      className={[
        wrapperClassName,
        'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full shadow-md',
        avatarLogoUrl
          ? 'overflow-hidden bg-zinc-300 ring-1 ring-black/10 dark:bg-zinc-600 dark:ring-white/10'
          : 'text-sm font-bold text-white ring-2 ring-white/10',
      ]
        .filter(Boolean)
        .join(' ')}
      style={avatarLogoUrl ? undefined : { background: avatarBackground }}
    >
      {avatarLogoUrl ? (
        <img
          src={avatarLogoUrl}
          alt=""
          className={logoImgClass}
        />
      ) : (
        avatarLabel
      )}
    </div>
  );
}

function EntryBubble({
  entry,
  avatarPlatform,
  collapsed,
  onToggle,
}: {
  entry: ConversationEntry;
  avatarPlatform?: AgentPlatform;
  collapsed: boolean;
  onToggle: () => void;
}) {
  if (entry.role === 'user') {
    const { display, isPrettyJson } =
      avatarPlatform === 'claude-code' || avatarPlatform === 'openclaude'
        ? formatClaudeUserEntryContent(entry.content)
        : { display: entry.content, isPrettyJson: false };

    return (
      <div className="rounded-xl border border-accent/30 bg-accent-muted px-3 py-2 text-xs text-content">
        <span className="mr-1.5 font-semibold text-accent">user</span>
        {isPrettyJson ? (
          <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-content scrollbar-thin">
            {display}
          </pre>
        ) : (
          <span className="whitespace-pre-wrap break-words">{display}</span>
        )}
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div className="rounded-xl border border-border bg-surface-muted/95 px-3 py-2 text-sm leading-relaxed text-content whitespace-pre-wrap break-words shadow-sm">
        <PretextContent content={entry.content} />
        {entry.tokens && (
          <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-content-subtle">
            {entry.tokens.input > 0 && <span>in: {entry.tokens.input.toLocaleString()}</span>}
            {entry.tokens.output > 0 && <span>out: {entry.tokens.output.toLocaleString()}</span>}
            {entry.cost != null && entry.cost > 0 && <span>${entry.cost.toFixed(4)}</span>}
          </div>
        )}
      </div>
    );
  }

  if (entry.role === 'thinking') {
    return (
      <div
        className="cursor-pointer select-none rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 transition hover:border-amber-400/40"
        onClick={onToggle}
        title="点击展开/收起"
      >
        <div className="flex items-center gap-1">
          <span className="text-amber-300">💭</span>
          <span className="font-semibold">思考中</span>
          <svg
            className={`h-3 w-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
        {!collapsed && (
          <div className="mt-1.5 whitespace-pre-wrap break-words opacity-90">{entry.content}</div>
        )}
      </div>
    );
  }

  if (entry.role === 'tool') {
    return (
      <div className="rounded-xl border border-mint/25 bg-mint-dim px-3 py-2">
        <div className="flex items-center gap-1.5 text-mint">
          <span>⚙</span>
          {entry.toolName && <span className="font-semibold">{entry.toolName}</span>}
        </div>
        <div className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-content-muted scrollbar-thin">
          {entry.content}
        </div>
      </div>
    );
  }

  // system
  return (
    <div className="rounded-lg bg-surface-hover px-2.5 py-1.5 text-center text-[11px] text-content-subtle">
      {entry.content}
    </div>
  );
}

function PretextContent({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxWidth, setMaxWidth] = useState(0);
  const [font, setFont] = useState(PRETEXT_FALLBACK_FONT);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateLayoutInput = () => {
      setMaxWidth(Math.floor(el.clientWidth));
      const style = window.getComputedStyle(el);
      const resolvedFont = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`.trim();
      if (style.fontSize) {
        setFont(prev => (prev === resolvedFont ? prev : resolvedFont));
      }
    };

    updateLayoutInput();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateLayoutInput);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => {
    if (!content || maxWidth <= 0) return null;
    try {
      const prepared = prepareWithSegments(content, font, { whiteSpace: 'pre-wrap' });
      return layoutWithLines(prepared, maxWidth, PRETEXT_LINE_HEIGHT).lines;
    } catch {
      return null;
    }
  }, [content, font, maxWidth]);

  if (!lines) {
    return (
      <div ref={containerRef} className="whitespace-pre-wrap break-words">
        {content}
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {lines.map((line, index) => (
        <div key={`${index}-${line.end.segmentIndex}-${line.end.graphemeIndex}`}>{line.text || '\u00A0'}</div>
      ))}
    </div>
  );
}
