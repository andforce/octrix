import { EventEmitter } from 'events';
import {
  watch,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  type FSWatcher,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { StringDecoder } from 'string_decoder';
import type { ConversationEntry } from './models.js';

const execFileAsync = promisify(execFile);

const MAX_CONTENT_LEN = 2000;
const CODEX_STREAM_ENTRY_PREFIX = 'codex-stream-';
const CODEX_SESSION_PROBE_BYTES = 1024 * 1024;
const CODEX_EXPECTED_PROMPT_TTL_MS = 10 * 60 * 1000;
const CODEX_EXPECTED_PROMPT_LIMIT = 20;

function truncate(s: string, max = MAX_CONTENT_LEN): string {
  return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '') || '/';
}

function getTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function normalizeCodexPhase(value: unknown): ConversationEntry['phase'] | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function stringifyCodexValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function codexTurnId(payload: any, fallback?: string): string | undefined {
  return typeof payload?.turn_id === 'string' ? payload.turn_id
    : typeof payload?.turnId === 'string' ? payload.turnId
      : typeof payload?.internal_chat_message_metadata_passthrough?.turn_id === 'string'
        ? payload.internal_chat_message_metadata_passthrough.turn_id
        : fallback;
}

function codexDedupeKey(
  turnId: string | undefined,
  role: ConversationEntry['role'],
  phase: ConversationEntry['phase'] | undefined,
  itemType: string,
  content: string,
  scope?: string,
): string {
  return [
    'codex',
    turnId || 'unknown-turn',
    role,
    phase || 'unknown-phase',
    itemType,
    scope || 'default',
    stableHash(content),
  ].join(':');
}

function makeCodexEntry(
  role: ConversationEntry['role'],
  content: string,
  timestamp: number,
  options: {
    turnId?: string;
    phase?: ConversationEntry['phase'];
    itemType: string;
    source: NonNullable<ConversationEntry['source']>;
    toolName?: string;
    metrics?: ConversationEntry['metrics'];
    dedupeScope?: string;
    dedupeContent?: string;
    humanInput?: ConversationEntry['humanInput'];
  },
): ConversationEntry {
  const dedupeKey = codexDedupeKey(
    options.turnId,
    role,
    options.phase,
    options.itemType,
    options.dedupeContent ?? content,
    options.dedupeScope,
  );
  return {
    id: dedupeKey,
    role,
    content: truncate(content),
    timestamp,
    toolName: options.toolName,
    phase: options.phase,
    source: options.source,
    turnId: options.turnId,
    itemType: options.itemType,
    dedupeKey,
    metrics: options.metrics,
    humanInput: options.humanInput,
  };
}

function getMessageBlocks(message: any): Array<{ type: string; text?: string }> {
  const content = message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function stringifyClaudeToolResultContent(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((block: any) => {
        if (typeof block?.text === 'string') return block.text;
        if (typeof block?.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return stringifyCodexValue(value);
}

function stringifyClaudeVisibleUserContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyCodexValue(content);

  const visibleBlocks = content.filter((block: any) => block?.type !== 'tool_result');
  if (visibleBlocks.length === 0) return '';
  if (
    visibleBlocks.length === 1
    && visibleBlocks[0]?.type === 'text'
    && typeof visibleBlocks[0]?.text === 'string'
  ) {
    return visibleBlocks[0].text;
  }
  return JSON.stringify(visibleBlocks);
}

function getHomeDirForCwd(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  const match = normalized.match(/^\/Users\/([^/]+)/);
  if (match) return join('/Users', match[1]);
  return homedir();
}

export function detectProfileId(command: string): string | null {
  const cmd = command.toLowerCase().trim().split(/\s+/)[0].split('/').pop() ?? '';
  if (cmd.includes('openclaude')) return 'openclaude';
  if (cmd.includes('claude')) return 'claude';
  if (cmd.includes('cursor') || cmd === 'agent') return 'cursor-cli';
  if (cmd.includes('github-copilot-cli') || cmd === 'copilot' || cmd === 'gh-copilot') {
    return 'github-copilot-cli';
  }
  if (cmd.includes('codex')) return 'codex';
  if (cmd.includes('opencode')) return 'opencode';
  if (cmd.includes('kiro-cli') || cmd === 'kiro') return 'kiro-cli';
  if (cmd.includes('qodercli')) return 'qoder-cli';
  if (cmd.includes('codebuddy')) return 'codebuddy-cli';
  if (cmd.includes('gemini')) return 'gemini-cli';
  return null;
}

const CLAUDE_FAMILY_PROFILE_IDS = new Set(['claude', 'openclaude']);

function isClaudeFamilyProfile(profileId: string): boolean {
  return CLAUDE_FAMILY_PROFILE_IDS.has(profileId);
}

function claudeConfigDirName(profileId: string): '.claude' | '.openclaude' {
  return profileId === 'openclaude' ? '.openclaude' : '.claude';
}

export function isStreamingConversationEntry(entry: Pick<ConversationEntry, 'id'>): boolean {
  return entry.id.startsWith(CODEX_STREAM_ENTRY_PREFIX);
}

function getCursorTranscriptsDir(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  const encoded = normalized
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '');
  return join(
    getHomeDirForCwd(normalized),
    '.cursor',
    'projects',
    encoded,
    'agent-transcripts',
  );
}

export function getOpenCodeDbPath(cwd: string): string {
  return join(getHomeDirForCwd(cwd), '.local', 'share', 'opencode', 'opencode.db');
}

/** Kiro CLI 会话库（官方文档：SQLite，按目录键值存储于用户数据目录） */
export function getKiroCliDbPath(cwd: string): string {
  const home = getHomeDirForCwd(cwd);
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  }
  return join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

function parseKiroHistoryTurn(turn: any, index: number, conversationId: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const ts = getTimestamp(turn?.user?.timestamp);
  const turnId = `kiro-${conversationId}-${index}`;
  const prompt = turn?.user?.content?.Prompt?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    entries.push({
      id: `kiro-${conversationId}-${index}-u`,
      role: 'user',
      content: prompt,
      timestamp: ts,
      turnId,
    });
  }
  const assistantText = turn?.assistant?.Response?.content;
  if (typeof assistantText === 'string') {
    entries.push({
      id: `kiro-${conversationId}-${index}-a`,
      role: 'assistant',
      content: assistantText,
      timestamp: ts,
      turnId,
    });
  }
  return entries;
}

function parseNewKiroHistoryTurns(conversation: any, fromIndex: number): ConversationEntry[] {
  const history = conversation?.history;
  if (!Array.isArray(history)) return [];
  const convId = String(conversation?.conversation_id ?? 'unknown');
  const entries: ConversationEntry[] = [];
  for (let i = fromIndex; i < history.length; i++) {
    entries.push(...parseKiroHistoryTurn(history[i], i, convId));
  }
  return entries;
}

/** ~/.qoder/projects/-Users-name--project 形式的会话目录（与 Claude Code 编码规则一致） */
export function getQoderProjectDir(cwd: string): string {
  const home = getHomeDirForCwd(cwd);
  const encoded = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  return join(home, '.qoder', 'projects', encoded);
}

/**
 * CodeBuddy：`/Users/a/b/中文` → `Users-a-b-中文`（仅将 `/` 换为 `-`，保留中文等字符）
 * 对应 ~/.codebuddy/projects/编码目录/*.jsonl
 */
export function encodeCodeBuddyProjectPath(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  return normalized.replace(/^\/+/, '').replace(/\//g, '-');
}

export function getCodeBuddyProjectDir(cwd: string): string {
  const home = getHomeDirForCwd(cwd);
  const encoded = encodeCodeBuddyProjectPath(cwd);
  return join(home, '.codebuddy', 'projects', encoded);
}

export function startWhenFileExists(
  filePath: string,
  onReady: () => void,
  onWaiting: () => void,
  exists = existsSync,
  intervalMs = 1000,
): ReturnType<typeof setInterval> | null {
  if (exists(filePath)) {
    onReady();
    return null;
  }

  onWaiting();
  const timer = setInterval(() => {
    if (!exists(filePath)) return;
    clearInterval(timer);
    onReady();
  }, intervalMs);
  return timer;
}

// --- Parsers ---

export function parseCursorTranscriptObject(
  obj: any,
  turnIdByUuid?: Map<string, string>,
): ConversationEntry[] {
  const role = obj?.role;
  if (role !== 'user' && role !== 'assistant') return [];

  const ts = getTimestamp(obj?.timestamp);
  const turnId = typeof obj?.turnId === 'string'
    ? obj.turnId
    : role === 'user' && typeof obj?.uuid === 'string'
      ? obj.uuid
      : typeof obj?.parentUuid === 'string'
        ? turnIdByUuid?.get(obj.parentUuid) ?? obj.parentUuid
        : undefined;
  const blocks = getMessageBlocks(obj?.message);
  const entries: ConversationEntry[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block?.type !== 'text' || !block.text) continue;
    entries.push({
      id: obj?.uuid ? `${obj.uuid}-${index}` : uuidv4(),
      role,
      content: block.text,
      timestamp: ts,
      turnId,
    });
  }

  if (turnId && typeof obj?.uuid === 'string') {
    turnIdByUuid?.set(obj.uuid, turnId);
  }

  return entries;
}

interface CodexParseContext {
  turnId?: string;
}

function codexToolEntry(
  payload: any,
  timestamp: number,
  context: CodexParseContext,
  toolName: string,
  content: string,
): ConversationEntry[] {
  if (!content) return [];
  const turnId = codexTurnId(payload, context.turnId);
  return [makeCodexEntry('tool', content, timestamp, {
    turnId,
    itemType: payload.type,
    source: 'codex_jsonl_response_item',
    toolName,
    dedupeScope: payload.call_id || payload.id || toolName,
  })];
}

function parseCodexAgentMessageContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block: any) => typeof block?.text === 'string' ? block.text : '')
    .filter(Boolean);
}

function parseCodexJsonObject(value: unknown): any | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeHumanInputQuestions(rawQuestions: unknown): NonNullable<ConversationEntry['humanInput']>['questions'] {
  if (!Array.isArray(rawQuestions)) return [];
  const questions: NonNullable<ConversationEntry['humanInput']>['questions'] = [];
  rawQuestions.forEach((question: any, index: number) => {
    const id = typeof question?.id === 'string' && question.id ? question.id : `question-${index + 1}`;
    const prompt = typeof question?.question === 'string' ? question.question.trim() : '';
    if (!prompt) return;
    const options: NonNullable<ConversationEntry['humanInput']>['questions'][number]['options'] = [];
    if (Array.isArray(question?.options)) {
      for (const option of question.options) {
        const label = typeof option?.label === 'string' ? option.label.trim() : '';
        if (!label) continue;
        const description = typeof option?.description === 'string' ? option.description.trim() : undefined;
        options.push({ label, description });
      }
    }
    questions.push({
      id,
      header: typeof question?.header === 'string' ? question.header : undefined,
      question: prompt,
      options,
      multiSelect: question?.multiSelect === true ? true : undefined,
    });
  });
  return questions;
}

function parseCodexHumanInputRequest(payload: any, timestamp: number, context: CodexParseContext): ConversationEntry[] {
  const args = parseCodexJsonObject(payload.arguments);
  const questions = normalizeHumanInputQuestions(args?.questions);

  const callId = typeof payload.call_id === 'string' && payload.call_id
    ? payload.call_id
    : typeof payload.id === 'string' && payload.id
      ? payload.id
      : '';
  if (!callId || questions.length === 0) return [];

  const content = questions.map((question: any) => question.question).join('\n');
  return [makeCodexEntry('tool', content, timestamp, {
    turnId: codexTurnId(payload, context.turnId),
    itemType: 'request_user_input',
    source: 'codex_jsonl_response_item',
    toolName: 'request_user_input',
    dedupeScope: callId,
    dedupeContent: 'request_user_input',
    humanInput: {
      callId,
      status: 'pending',
      autoResolutionMs: typeof args?.autoResolutionMs === 'number' ? args.autoResolutionMs : undefined,
      questions,
    },
  })];
}

function parseCodexHumanInputAnswer(payload: any, timestamp: number, context: CodexParseContext): ConversationEntry[] {
  const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : '';
  if (!callId) return [];
  const output = parseCodexJsonObject(payload.output);
  const answers = output?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];

  const selectedAnswers: Record<string, string[]> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    const raw = (value as any)?.answers;
    const answerList = Array.isArray(raw)
      ? raw.filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
      : [];
    if (answerList.length > 0) selectedAnswers[questionId] = answerList;
  }

  if (Object.keys(selectedAnswers).length === 0) return [];
  const content = Object.entries(selectedAnswers)
    .map(([questionId, values]) => `${questionId}: ${values.join(', ')}`)
    .join('\n');

  return [makeCodexEntry('tool', content, timestamp, {
    turnId: codexTurnId(payload, context.turnId),
    itemType: 'request_user_input',
    source: 'codex_jsonl_response_item',
    toolName: 'request_user_input',
    dedupeScope: callId,
    dedupeContent: 'request_user_input',
    humanInput: {
      callId,
      status: 'answered',
      questions: [],
      selectedAnswers,
    },
  })];
}

function parseClaudeAskUserQuestionEntry(block: any, timestamp: number): ConversationEntry[] {
  if (block?.name !== 'AskUserQuestion') return [];
  const callId = typeof block.id === 'string' && block.id ? block.id : '';
  if (!callId) return [];
  const questions = normalizeHumanInputQuestions(block.input?.questions);
  if (questions.length === 0) return [];

  const content = questions.map(question => question.question).join('\n');
  return [{
    id: callId,
    role: 'tool',
    content: truncate(content),
    toolName: 'AskUserQuestion',
    timestamp,
    itemType: 'AskUserQuestion',
    dedupeKey: callId,
    humanInput: {
      callId,
      status: 'pending',
      questions,
    },
  }];
}

function parseClaudeAskUserQuestionResult(block: any, raw: string, timestamp: number): ConversationEntry[] {
  const callId = typeof block?.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : '';
  if (!callId) return [];
  const parsed = parseCodexJsonObject(raw);
  const selectedAnswers: Record<string, string[]> = {};
  if (parsed?.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)) {
    for (const [questionId, value] of Object.entries(parsed.answers)) {
      const rawAnswers = Array.isArray((value as any)?.answers) ? (value as any).answers : value;
      const answers = Array.isArray(rawAnswers)
        ? rawAnswers.filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
        : typeof rawAnswers === 'string' && rawAnswers.trim()
          ? [rawAnswers]
          : [];
      if (answers.length > 0) selectedAnswers[questionId] = answers;
    }
  }

  return [{
    id: callId,
    role: 'tool',
    content: truncate(raw),
    toolName: block.is_error ? 'AskUserQuestion ✗' : 'AskUserQuestion',
    timestamp,
    itemType: 'AskUserQuestion',
    dedupeKey: callId,
    humanInput: {
      callId,
      status: 'answered',
      questions: [],
      selectedAnswers: Object.keys(selectedAnswers).length > 0 ? selectedAnswers : undefined,
    },
  }];
}

export function parseCodexSessionObject(obj: any, context: CodexParseContext = {}): ConversationEntry[] {
  const ts = getTimestamp(obj?.timestamp);
  const type = obj?.type;
  const payload = obj?.payload;
  if (!payload) return [];
  const turnId = codexTurnId(payload, context.turnId);

  if (type === 'event_msg' && payload.type === 'user_message') {
    const text = payload.message;
    if (typeof text === 'string' && text) {
      return [{ id: uuidv4(), role: 'user', content: text, timestamp: ts, turnId }];
    }
  }

  if (type === 'event_msg' && payload.type === 'agent_message') {
    const text = payload.message;
    if (typeof text === 'string' && text) {
      return [makeCodexEntry('assistant', text, ts, {
        turnId,
        phase: normalizeCodexPhase(payload.phase),
        itemType: 'assistant_message',
        source: 'codex_jsonl_event',
      })];
    }
  }

  if (type === 'event_msg' && payload.type === 'task_complete') {
    const text = payload.last_agent_message;
    if (typeof text === 'string' && text) {
      return [makeCodexEntry('assistant', text, ts, {
        turnId,
        phase: 'final_answer',
        itemType: 'assistant_message',
        source: 'codex_jsonl_task_complete',
        metrics: {
          durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
          timeToFirstTokenMs: typeof payload.time_to_first_token_ms === 'number'
            ? payload.time_to_first_token_ms
            : undefined,
        },
      })];
    }
  }

  if (type === 'event_msg' && payload.type === 'agent_reasoning') {
    const text = payload.text;
    if (typeof text === 'string' && text) {
      return [makeCodexEntry('thinking', text, ts, {
        turnId,
        itemType: 'reasoning',
        source: 'codex_jsonl_event',
      })];
    }
  }

  if (type === 'event_msg' && payload.type === 'agent_reasoning_raw_content') {
    return [];
  }

  if (type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const blocks: any[] = Array.isArray(payload.content) ? payload.content : [];
    const entries: ConversationEntry[] = [];
    for (const block of blocks) {
      const text = block?.text;
      if ((block?.type === 'output_text' || block?.type === 'text') && typeof text === 'string' && text) {
        entries.push(makeCodexEntry('assistant', text, ts, {
          turnId,
          phase: normalizeCodexPhase(payload.phase),
          itemType: 'assistant_message',
          source: 'codex_jsonl_response_item',
        }));
      }
    }
    return entries;
  }

  if (type === 'response_item' && payload.type === 'agent_message') {
    return parseCodexAgentMessageContent(payload.content).map(text => makeCodexEntry('assistant', text, ts, {
      turnId,
      itemType: 'agent_message',
      source: 'codex_jsonl_response_item',
    }));
  }

  if (type === 'response_item' && payload.type === 'reasoning') {
    const summaryBlocks: any[] = Array.isArray(payload.summary) ? payload.summary : [];
    for (const block of summaryBlocks) {
      if (block?.type === 'summary_text' && typeof block.text === 'string' && block.text) {
        return [makeCodexEntry('thinking', block.text, ts, {
          turnId,
          itemType: 'reasoning',
          source: 'codex_jsonl_response_item',
        })];
      }
    }
  }

  if (type === 'response_item' && payload.type === 'function_call') {
    if (payload.name === 'request_user_input') {
      const entries = parseCodexHumanInputRequest(payload, ts, context);
      if (entries.length > 0) return entries;
    }
    const name = payload.name || 'unknown';
    const args = payload.arguments || '';
    return codexToolEntry(payload, ts, context, name, typeof args === 'string' ? args : stringifyCodexValue(args));
  }

  if (type === 'response_item' && payload.type === 'function_call_output') {
    const humanInputEntries = parseCodexHumanInputAnswer(payload, ts, context);
    if (humanInputEntries.length > 0) return humanInputEntries;
    const output = payload.output || '';
    return codexToolEntry(payload, ts, context, 'result', stringifyCodexValue(output));
  }

  if (type === 'response_item' && payload.type === 'custom_tool_call') {
    const name = payload.name || 'custom_tool_call';
    return codexToolEntry(payload, ts, context, name, stringifyCodexValue(payload.input));
  }

  if (type === 'response_item' && payload.type === 'custom_tool_call_output') {
    const name = payload.name || 'custom_tool_result';
    return codexToolEntry(payload, ts, context, name, stringifyCodexValue(payload.output));
  }

  if (type === 'response_item' && payload.type === 'tool_search_call') {
    return codexToolEntry(payload, ts, context, 'tool_search', stringifyCodexValue({
      execution: payload.execution,
      arguments: payload.arguments,
      status: payload.status,
    }));
  }

  if (type === 'response_item' && payload.type === 'tool_search_output') {
    return codexToolEntry(payload, ts, context, 'tool_search_result', stringifyCodexValue({
      execution: payload.execution,
      status: payload.status,
      tools: payload.tools,
    }));
  }

  if (type === 'response_item' && payload.type === 'local_shell_call') {
    return codexToolEntry(payload, ts, context, 'local_shell', stringifyCodexValue({
      status: payload.status,
      action: payload.action,
    }));
  }

  if (type === 'response_item' && payload.type === 'web_search_call') {
    return codexToolEntry(payload, ts, context, 'web_search', stringifyCodexValue({
      status: payload.status,
      action: payload.action,
    }));
  }

  if (type === 'response_item' && payload.type === 'image_generation_call') {
    return codexToolEntry(payload, ts, context, 'image_generation', stringifyCodexValue({
      status: payload.status,
      revised_prompt: payload.revised_prompt,
      result: payload.result ? '[image result]' : undefined,
    }));
  }

  return [];
}

function codexStreamEntryId(role: 'assistant' | 'thinking', itemId: unknown): string {
  const rawId = typeof itemId === 'string' && itemId ? itemId : uuidv4();
  return `${CODEX_STREAM_ENTRY_PREFIX}${role}-${rawId}`;
}

/* ================================================================== */
/*  GitHub Copilot CLI events.jsonl parser                             */
/*  Session dir: ~/.copilot/session-state/<uuid>/events.jsonl          */
/* ================================================================== */

export function parseCopilotEventObject(obj: any, activeTurnId?: string): ConversationEntry[] {
  const ts = getTimestamp(obj?.timestamp);
  const type = obj?.type as string | undefined;
  const data = obj?.data;
  const turnId = typeof data?.turnId === 'string' ? data.turnId : activeTurnId;
  if (!type || !data) return [];

  if (type === 'user.message') {
    const text = data.content;
    if (typeof text === 'string' && text) {
      return [{ id: obj.id || uuidv4(), role: 'user', content: text, timestamp: ts, turnId }];
    }
  }

  if (type === 'assistant.message') {
    const entries: ConversationEntry[] = [];
    const content = data.content;
    if (typeof content === 'string' && content) {
      entries.push({
        id: data.messageId || obj.id || uuidv4(),
        role: 'assistant',
        content,
        timestamp: ts,
        turnId,
      });
    }

    if (Array.isArray(data.toolRequests)) {
      for (const req of data.toolRequests) {
        const name = req.name || 'unknown';
        const args = req.arguments || '';
        entries.push({
          id: req.toolCallId || uuidv4(),
          role: 'tool',
          content: truncate(typeof args === 'string' ? args : JSON.stringify(args, null, 2)),
          toolName: name,
          timestamp: ts,
          turnId,
        });
      }
    }

    if (data.outputTokens && entries.length > 0) {
      entries[0].tokens = { input: 0, output: data.outputTokens, reasoning: 0 };
    }

    return entries;
  }

  if (type === 'tool.execution_complete') {
    const result = data.result;
    if (result) {
      const text = result.content || result.detailedContent || '';
      if (text) {
        return [{
          id: data.toolCallId || obj.id || uuidv4(),
          role: 'tool',
          content: truncate(typeof text === 'string' ? text : JSON.stringify(text)),
          toolName: 'result',
          timestamp: ts,
          turnId,
        }];
      }
    }
  }

  if (type === 'session.error') {
    const msg = data.message;
    if (typeof msg === 'string' && msg) {
      return [{ id: obj.id || uuidv4(), role: 'system', content: msg, timestamp: ts, turnId }];
    }
  }

  return [];
}

export function parseGeminiSessionFile(data: any): ConversationEntry[] {
  if (!data || !Array.isArray(data.messages)) return [];

  const entries: ConversationEntry[] = [];
  let activeTurnId: string | undefined;

  for (const msg of data.messages) {
    const ts = getTimestamp(msg.timestamp);
    const msgId = msg.id || uuidv4();

    if (msg.type === 'user') {
      activeTurnId = String(msgId);
      const parts: any[] = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        const text = part?.text;
        if (typeof text === 'string' && text) {
          entries.push({
            id: `${msgId}-u${entries.length}`,
            role: 'user',
            content: text,
            timestamp: ts,
            turnId: activeTurnId,
          });
        }
      }
      if (typeof msg.content === 'string' && msg.content) {
        entries.push({ id: msgId, role: 'user', content: msg.content, timestamp: ts, turnId: activeTurnId });
      }
      continue;
    }

    if (msg.type === 'gemini') {
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          const text = thought.description || thought.subject || '';
          if (text) {
            entries.push({
              id: `${msgId}-th${entries.length}`,
              role: 'thinking',
              content: truncate(text),
              timestamp: getTimestamp(thought.timestamp) || ts,
              turnId: activeTurnId,
            });
          }
        }
      }

      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const name = tc.displayName || tc.name || 'unknown';
          const status = tc.status || 'pending';
          const argsStr = tc.args ? truncate(JSON.stringify(tc.args, null, 2)) : '';

          let content = argsStr;
          if (tc.result) {
            const resultStr = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
            content = argsStr
              ? `${argsStr}\n\n${truncate(resultStr, 800)}`
              : truncate(resultStr, 800);
          }

          const statusSuffix = status === 'error' ? ' ✗' : status === 'completed' ? ' ✓' : '';

          entries.push({
            id: tc.id || `${msgId}-tc${entries.length}`,
            role: 'tool',
            content: content || `[${status}]`,
            toolName: `${name}${statusSuffix}`,
            timestamp: getTimestamp(tc.timestamp) || ts,
            turnId: activeTurnId,
          });
        }
      }

      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p: any) => p?.text).map((p: any) => p.text).join('\n')
            : '';

      if (textContent) {
        const entry: ConversationEntry = {
          id: `${msgId}-a${entries.length}`,
          role: 'assistant',
          content: textContent,
          timestamp: ts,
          turnId: activeTurnId,
        };

        if (msg.tokens) {
          entry.tokens = {
            input: msg.tokens.input || 0,
            output: msg.tokens.output || 0,
            reasoning: msg.tokens.thoughts || 0,
          };
        }

        entries.push(entry);
      }

      continue;
    }

    if (msg.type === 'info' || msg.type === 'warning' || msg.type === 'error') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (text) {
        entries.push({ id: msgId, role: 'system', content: text, timestamp: ts, turnId: activeTurnId });
      }
    }
  }

  return entries;
}

// --- ConversationWatcher ---

export class ConversationWatcher extends EventEmitter {
  private static codexSessionClaims = new Map<string, ConversationWatcher>();

  private profileId: string;
  private rawCwd: string;
  private cwd: string;
  private spawnTime: number;
  private stopped = false;

  /** True once a session file has been discovered and is being monitored. */
  get isActive(): boolean {
    return this.sessionFile !== null || this.ocSessionId !== null || this.kiroPollTimer !== null;
  }

  private sessionFile: string | null = null;
  private jsonlRemainder = '';
  private lastReadByteSize = 0;
  private jsonlDecoder = new StringDecoder('utf8');
  private codexCurrentTurnId: string | undefined;
  private copilotCurrentTurnId: string | undefined;
  private copilotPendingUserEntries: ConversationEntry[] = [];
  private claudeCurrentTurnId: string | undefined;
  private claudeTurnIdByUuid = new Map<string, string>();
  private cursorTurnIdByUuid = new Map<string, string>();
  private codeBuddyTurnIdByMessageId = new Map<string, string>();
  private codeBuddyCurrentTurnId: string | undefined;
  private dirWatcher: FSWatcher | null = null;
  private fileWatcher: FSWatcher | null = null;
  private filePollTimer: ReturnType<typeof setInterval> | null = null;
  private discoverTimer: ReturnType<typeof setInterval> | null = null;
  private discoverDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private codexStreamContent = new Map<string, { role: 'assistant' | 'thinking'; content: string }>();
  private codexExpectedPrompts: Array<{ content: string; recordedAt: number }> = [];
  private codexTerminalInput = '';
  private codexSessionInspections = new Map<string, {
    size: number;
    mtimeMs: number;
    cwd?: string;
    prompts: string[];
  }>();
  private claudeAskUserQuestionCallIds = new Set<string>();

  private ocSessionId: string | null = null;
  private ocSeenParts = new Map<string, string>();
  private ocTurnIdByMessageId = new Map<string, string>();
  private ocCurrentTurnId: string | undefined;
  private ocPollTimer: ReturnType<typeof setInterval> | null = null;

  private geminiLastMessageCount = 0;
  private geminiPollTimer: ReturnType<typeof setInterval> | null = null;

  private kiroPollTimer: ReturnType<typeof setInterval> | null = null;
  private kiroEmittedHistoryCount = 0;
  private kiroLastConvId: string | null = null;

  constructor(profileId: string, cwd: string) {
    super();
    this.profileId = profileId;
    this.rawCwd = cwd;
    this.cwd = normalizeCwd(cwd);
    this.spawnTime = Date.now();
    this.start();
  }

  private start() {
    if (this.stopped) return;

    if (isClaudeFamilyProfile(this.profileId)) {
      this.startClaudeCode(claudeConfigDirName(this.profileId));
      return;
    }

    switch (this.profileId) {
      case 'cursor-cli':
        this.startCursorCli();
        break;
      case 'codex':
        this.startCodexCli();
        break;
      case 'github-copilot-cli':
        this.startCopilotCli();
        break;
      case 'opencode':
        this.startOpenCode();
        break;
      case 'gemini-cli':
        this.startGeminiCli();
        break;
      case 'kiro-cli':
        this.startKiroCli();
        break;
      case 'qoder-cli':
        this.startQoderCli();
        break;
      case 'codebuddy-cli':
        this.startCodeBuddyCli();
        break;
      default:
        console.log(`[conversation] no watcher for profile "${this.profileId}"`);
        break;
    }
  }

  stop() {
    this.stopped = true;
    if (
      this.profileId === 'codex'
      && this.sessionFile
      && ConversationWatcher.codexSessionClaims.get(this.sessionFile) === this
    ) {
      ConversationWatcher.codexSessionClaims.delete(this.sessionFile);
    }
    this.dirWatcher?.close();
    this.fileWatcher?.close();
    if (this.filePollTimer) clearInterval(this.filePollTimer);
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    if (this.discoverDebounceTimer) clearTimeout(this.discoverDebounceTimer);
    if (this.ocPollTimer) clearInterval(this.ocPollTimer);
    if (this.geminiPollTimer) clearInterval(this.geminiPollTimer);
    if (this.kiroPollTimer) clearInterval(this.kiroPollTimer);
  }

  // --- Claude Code ---

  private supportsSessionFileSwitch(): boolean {
    return isClaudeFamilyProfile(this.profileId) || this.profileId === 'codex';
  }

  noteExpectedCodexPrompt(content: string) {
    if (this.profileId !== 'codex') return;
    const normalized = this.normalizeCodexPrompt(content);
    if (!normalized || normalized.startsWith('/')) return;
    const now = Date.now();
    this.codexExpectedPrompts = this.codexExpectedPrompts
      .filter(prompt => now - prompt.recordedAt <= CODEX_EXPECTED_PROMPT_TTL_MS)
      .slice(-(CODEX_EXPECTED_PROMPT_LIMIT - 1));
    this.codexExpectedPrompts.push({ content: normalized, recordedAt: now });
  }

  noteCodexTerminalInput(data: string) {
    if (this.profileId !== 'codex' || !data) return;
    const cleaned = data
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b./g, '');

    for (const character of cleaned) {
      if (character === '\r' || character === '\n') {
        if (this.codexTerminalInput) {
          this.noteExpectedCodexPrompt(this.codexTerminalInput);
          this.codexTerminalInput = '';
        }
      } else if (character === '\x7f' || character === '\b') {
        this.codexTerminalInput = Array.from(this.codexTerminalInput).slice(0, -1).join('');
      } else if (character >= ' ' && character !== '\x7f') {
        this.codexTerminalInput += character;
      }
    }
  }

  private normalizeCodexPrompt(content: string): string {
    return content.replace(/\r\n/g, '\n').trim();
  }

  private consumeExpectedCodexPrompt(content: string) {
    const normalized = this.normalizeCodexPrompt(content);
    const matchedIndex = this.codexExpectedPrompts.findIndex(expected => expected.content === normalized);
    if (matchedIndex >= 0) this.codexExpectedPrompts.splice(matchedIndex, 1);
  }

  private resetJsonlReadState() {
    this.jsonlRemainder = '';
    this.lastReadByteSize = 0;
    this.jsonlDecoder = new StringDecoder('utf8');
    this.codexCurrentTurnId = undefined;
    this.copilotCurrentTurnId = undefined;
    this.copilotPendingUserEntries = [];
    this.claudeCurrentTurnId = undefined;
    this.claudeTurnIdByUuid.clear();
    this.cursorTurnIdByUuid.clear();
    this.codeBuddyTurnIdByMessageId.clear();
    this.codeBuddyCurrentTurnId = undefined;
    this.codexStreamContent.clear();
  }

  private getClaudeProjectDir(configDirName = '.claude'): string {
    const encoded = this.cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    return join(getHomeDirForCwd(this.cwd), configDirName, 'projects', encoded);
  }

  private startClaudeCode(configDirName = '.claude') {
    const projectDir = this.getClaudeProjectDir(configDirName);
    console.log(`[conversation] watching dir: ${projectDir}`);

    this.discoverTimer = setInterval(() => {
      if (this.stopped || (!this.supportsSessionFileSwitch() && this.sessionFile)) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      if (!existsSync(projectDir)) return;
      try {
        const found = this.findNewSessionFile(projectDir);
        if (found) this.onSessionFileFound(found);
      } catch (err) {
        console.error('[conversation] discover error:', err);
      }
    }, 500);

    if (existsSync(projectDir)) {
      try {
        this.dirWatcher = watch(projectDir, (_event, filename) => {
          if (!filename?.endsWith('.jsonl')) return;
          try {
            const found = this.findNewSessionFile(projectDir);
            if (found) this.onSessionFileFound(found);
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    }
  }

  private findNewSessionFile(projectDir: string): string | null {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    let bestFile: string | null = null;
    let bestScore = 0;

    for (const f of files) {
      try {
        const full = join(projectDir, f);
        const st = statSync(full);
        const birthPassed = st.birthtimeMs >= this.spawnTime - 3000;
        const mtimePassed = st.mtimeMs >= this.spawnTime - 3000;
        if (!birthPassed && !mtimePassed) continue;
        const score = Math.max(st.birthtimeMs, st.mtimeMs);
        if (score > bestScore) {
          bestScore = score;
          bestFile = full;
        }
      } catch { /* ignore */ }
    }

    return bestFile;
  }

  private onSessionFileFound(filePath: string) {
    if (this.sessionFile === filePath) return;

    if (this.profileId === 'codex') {
      const claimedBy = ConversationWatcher.codexSessionClaims.get(filePath);
      if (claimedBy && claimedBy !== this) return;
      ConversationWatcher.codexSessionClaims.set(filePath, this);
    }

    const previousSessionFile = this.sessionFile;
    const switchingSession = this.sessionFile !== null;
    if (switchingSession && !this.supportsSessionFileSwitch()) {
      if (
        this.profileId === 'codex'
        && ConversationWatcher.codexSessionClaims.get(filePath) === this
      ) {
        ConversationWatcher.codexSessionClaims.delete(filePath);
      }
      return;
    }

    if (
      this.profileId === 'codex'
      && previousSessionFile
      && ConversationWatcher.codexSessionClaims.get(previousSessionFile) === this
    ) {
      ConversationWatcher.codexSessionClaims.delete(previousSessionFile);
    }

    this.fileWatcher?.close();
    this.fileWatcher = null;
    if (this.filePollTimer) {
      clearInterval(this.filePollTimer);
      this.filePollTimer = null;
    }

    this.sessionFile = filePath;

    if (this.profileId === 'codex') {
      const session = this.inspectCodexSession(filePath);
      for (const prompt of session.prompts) this.consumeExpectedCodexPrompt(prompt);
    }

    if (!this.supportsSessionFileSwitch()) {
      if (this.discoverTimer) {
        clearInterval(this.discoverTimer);
        this.discoverTimer = null;
      }
      this.dirWatcher?.close();
      this.dirWatcher = null;
    }

    console.log(`[conversation] found session: ${filePath}`);
    this.resetJsonlReadState();
    if (switchingSession) {
      this.emit('reset', { reason: 'session_switch', filePath });
    }
    this.readJsonlUpdates();

    try {
      this.fileWatcher = watch(filePath, () => {
        this.readJsonlUpdates();
      });
    } catch { /* ignore */ }

    this.filePollTimer = setInterval(() => this.readJsonlUpdates(), 250);
    this.filePollTimer.unref?.();
  }

  private readJsonlUpdates() {
    if (!this.sessionFile || this.stopped) return;

    try {
      const fileSizeBytes = statSync(this.sessionFile).size;
      if (fileSizeBytes < this.lastReadByteSize) {
        this.resetJsonlReadState();
        this.emit('reset', { reason: 'truncate', filePath: this.sessionFile });
      }
      if (fileSizeBytes <= this.lastReadByteSize) return;

      const bytesToRead = fileSizeBytes - this.lastReadByteSize;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const fd = openSync(this.sessionFile, 'r');
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, buffer, 0, bytesToRead, this.lastReadByteSize);
      } finally {
        closeSync(fd);
      }
      if (bytesRead <= 0) return;

      this.lastReadByteSize += bytesRead;
      const newContent = this.jsonlDecoder.write(buffer.subarray(0, bytesRead));
      if (!newContent) return;

      const combined = this.jsonlRemainder + newContent;
      const parts = combined.split('\n');
      this.jsonlRemainder = combined.endsWith('\n') ? '' : parts.pop() ?? '';
      const lines = parts.filter(Boolean);
      if (this.jsonlRemainder) {
        try {
          JSON.parse(this.jsonlRemainder);
          lines.push(this.jsonlRemainder);
          this.jsonlRemainder = '';
        } catch { /* wait for the rest of the partial JSONL record */ }
      }
      for (const line of lines) {
        const entries = this.parseTranscriptLine(line);
        if (entries.length > 0) {
          // Preserve transcript order across lifecycle callbacks and entries.
          // In particular, a later turn-completed event must not overtake the
          // user boundary returned by an earlier JSONL record.
          this.emit('entries', entries);
        }
      }
    } catch { /* ignore */ }
  }

  private parseTranscriptLine(line: string): ConversationEntry[] {
    try {
      const obj = JSON.parse(line);
      if (this.profileId === 'cursor-cli') {
        return parseCursorTranscriptObject(obj, this.cursorTurnIdByUuid);
      }
      if (this.profileId === 'codex') {
        return this.parseCodexEntry(obj);
      }
      if (this.profileId === 'github-copilot-cli') {
        if (obj?.type === 'user.message' && !this.copilotCurrentTurnId) {
          this.copilotPendingUserEntries.push(...parseCopilotEventObject(obj));
          return [];
        }
        if (obj?.type === 'assistant.turn_start' && typeof obj?.data?.turnId === 'string') {
          this.copilotCurrentTurnId = obj.data.turnId;
          this.emit('turn-started', obj.data.turnId);
          const pendingUsers = this.copilotPendingUserEntries.map(entry => ({
            ...entry,
            turnId: obj.data.turnId,
          }));
          this.copilotPendingUserEntries = [];
          return pendingUsers;
        }
        const entries = parseCopilotEventObject(obj, this.copilotCurrentTurnId);
        if (obj?.type === 'assistant.turn_end' && typeof obj?.data?.turnId === 'string') {
          this.emit('turn-completed', obj.data.turnId);
          if (this.copilotCurrentTurnId === obj.data.turnId) {
            this.copilotCurrentTurnId = undefined;
          }
        }
        return entries;
      }
      if (this.profileId === 'codebuddy-cli') {
        return this.parseCodeBuddyEntry(obj);
      }
      if (this.profileId === 'qoder-cli') {
        return this.parseQoderEntry(obj);
      }
      if (isClaudeFamilyProfile(this.profileId)) {
        return this.parseClaudeEntry(obj);
      }
      return [];
    } catch {
      return [];
    }
  }

  private parseCodexEntry(obj: any): ConversationEntry[] {
    if (
      obj?.type === 'event_msg'
      && obj?.payload?.type === 'user_message'
      && typeof obj?.payload?.message === 'string'
    ) {
      this.consumeExpectedCodexPrompt(obj.payload.message);
    }
    if (obj?.type === 'event_msg' && obj?.payload?.type === 'task_started') {
      const turnId = codexTurnId(obj.payload);
      if (turnId) {
        this.codexCurrentTurnId = turnId;
        this.emit('turn-started', turnId);
      }
    }

    const parsed = parseCodexSessionObject(obj, { turnId: this.codexCurrentTurnId });
    if (obj?.type === 'event_msg' && obj?.payload?.type === 'task_complete') {
      const turnId = codexTurnId(obj.payload);
      if (turnId) {
        this.codexCurrentTurnId = turnId;
        this.emit('turn-completed', turnId);
      }
      this.codexCurrentTurnId = undefined;
    }
    if (parsed.length > 0) return parsed;

    const payload = obj?.payload;
    if (obj?.type !== 'event_msg' || !payload || typeof payload.delta !== 'string') return [];

    let role: 'assistant' | 'thinking' | null = null;
    if (payload.type === 'agent_message_content_delta') {
      role = 'assistant';
    } else if (payload.type === 'reasoning_content_delta') {
      role = 'thinking';
    }
    if (!role) return [];

    const id = codexStreamEntryId(role, payload.item_id);
    const previous = this.codexStreamContent.get(id)?.content ?? '';
    const content = truncate(previous + payload.delta);
    this.codexStreamContent.set(id, { role, content });

    return [{
      id,
      role,
      content,
      timestamp: getTimestamp(obj?.timestamp),
      turnId: this.codexCurrentTurnId,
    }];
  }

  private parseClaudeEntry(obj: any): ConversationEntry[] {
    const entries: ConversationEntry[] = [];
    const ts = getTimestamp(obj.timestamp);
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : undefined;
    const parentUuid = typeof obj.parentUuid === 'string' ? obj.parentUuid : undefined;
    const visibleUserContent = obj.type === 'user' && obj.message && !obj.isMeta
      ? stringifyClaudeVisibleUserContent(obj.message.content)
      : '';
    const startsTurn = !!visibleUserContent && !!uuid;
    const turnId = startsTurn
      ? uuid
      : (parentUuid ? this.claudeTurnIdByUuid.get(parentUuid) ?? parentUuid : this.claudeCurrentTurnId);
    if (startsTurn) this.claudeCurrentTurnId = turnId;

    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const [index, block] of content.entries()) {
          if (block?.type !== 'tool_result') continue;
          const raw = stringifyClaudeToolResultContent(
            block.content !== undefined ? block.content : obj.toolUseResult,
          );
          if (!raw) continue;
          if (typeof block.tool_use_id === 'string' && this.claudeAskUserQuestionCallIds.has(block.tool_use_id)) {
            entries.push(...parseClaudeAskUserQuestionResult(block, raw, ts));
            if (entries.at(-1)?.itemType === 'AskUserQuestion') continue;
          }
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
          entries.push({
            id: toolUseId ? `${toolUseId}-result` : `${obj.uuid || uuidv4()}-result-${index}`,
            role: 'tool',
            content: truncate(raw),
            toolName: block.is_error ? 'result ✗' : 'result',
            timestamp: ts,
          });
        }
      }

      if (!obj.isMeta) {
        const visibleContent = visibleUserContent;
        if (visibleContent) {
          entries.push({ id: obj.uuid || uuidv4(), role: 'user', content: visibleContent, timestamp: ts });
        }
      }
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      const blocks = Array.isArray(obj.message.content)
        ? obj.message.content
        : [{ type: 'text', text: obj.message.content }];

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          entries.push({
            id: `${obj.uuid || ''}-t${entries.length}`,
            role: 'assistant',
            content: block.text,
            timestamp: ts,
          });
        } else if (block.type === 'thinking' && block.thinking) {
          entries.push({
            id: `${obj.uuid || ''}-k${entries.length}`,
            role: 'thinking',
            content: truncate(block.thinking),
            timestamp: ts,
          });
        } else if (block.type === 'tool_use') {
          const askUserEntries = parseClaudeAskUserQuestionEntry(block, ts);
          if (askUserEntries.length > 0) {
            this.claudeAskUserQuestionCallIds.add(askUserEntries[0].humanInput!.callId);
            entries.push(...askUserEntries);
            continue;
          }
          const inputStr = JSON.stringify(block.input, null, 2);
          entries.push({
            id: block.id || `${obj.uuid || ''}-u${entries.length}`,
            role: 'tool',
            content: truncate(inputStr),
            toolName: block.name,
            timestamp: ts,
          });
        }
      }

      if (obj.message.usage && entries.length > 0) {
        const last = entries[entries.length - 1];
        last.tokens = {
          input: obj.message.usage.input_tokens || 0,
          output: obj.message.usage.output_tokens || 0,
          reasoning: 0,
        };
      }
    }

    if (obj.type === 'tool_result') {
      const raw =
        typeof obj.content === 'string'
          ? obj.content
          : JSON.stringify(obj.content);
      if (typeof obj.tool_use_id === 'string' && this.claudeAskUserQuestionCallIds.has(obj.tool_use_id)) {
        const askUserEntries = parseClaudeAskUserQuestionResult(obj, raw, ts);
        if (askUserEntries.length > 0) {
          entries.push(...askUserEntries);
          if (turnId) {
            for (const entry of entries) entry.turnId = turnId;
            if (uuid) this.claudeTurnIdByUuid.set(uuid, turnId);
          }
          return entries;
        }
      }
      entries.push({
        id: obj.tool_use_id ? `${obj.tool_use_id}-result` : uuidv4(),
        role: 'tool',
        content: truncate(raw),
        toolName: 'result',
        timestamp: ts,
      });
    }

    if (turnId) {
      for (const entry of entries) entry.turnId = turnId;
      if (uuid) this.claudeTurnIdByUuid.set(uuid, turnId);
    }

    return entries;
  }

  // --- Cursor CLI ---

  private getCursorTranscriptsCandidates(): string[] {
    const candidates: string[] = [];
    const home = getHomeDirForCwd(this.cwd);
    let dir = this.cwd;
    while (dir.length >= home.length && dir !== '/') {
      const transcriptsDir = getCursorTranscriptsDir(dir);
      if (existsSync(transcriptsDir)) {
        candidates.push(transcriptsDir);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return candidates;
  }

  private startCursorCli() {
    const candidates = this.getCursorTranscriptsCandidates();
    const primaryDir = getCursorTranscriptsDir(this.cwd);
    console.log(`[conversation] watching Cursor transcripts: ${primaryDir} (+${candidates.length - (candidates.includes(primaryDir) ? 1 : 0)} parent candidates)`);

    this.discoverTimer = setInterval(() => {
      if (this.sessionFile || this.stopped) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      try {
        for (const dir of candidates) {
          const found = this.findNewCursorSessionFile(dir);
          if (found) {
            this.onSessionFileFound(found);
            return;
          }
        }
      } catch (err) {
        console.error('[conversation] Cursor discover error:', err);
      }
    }, 500);

    for (const dir of candidates) {
      try {
        const w = watch(dir, () => {
          if (this.sessionFile) return;
          try {
            for (const d of candidates) {
              const found = this.findNewCursorSessionFile(d);
              if (found) {
                this.onSessionFileFound(found);
                return;
              }
            }
          } catch { /* ignore */ }
        });
        if (!this.dirWatcher) this.dirWatcher = w;
      } catch { /* ignore */ }
    }
  }

  // --- Qoder CLI ---

  private startQoderCli() {
    const projectDir = getQoderProjectDir(this.rawCwd);
    console.log(`[conversation] watching Qoder CLI sessions: ${projectDir}`);

    this.discoverTimer = setInterval(() => {
      if (this.sessionFile || this.stopped) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      if (!existsSync(projectDir)) return;
      try {
        const found = this.findNewQoderSessionFile(projectDir);
        if (found) this.onSessionFileFound(found);
      } catch (err) {
        console.error('[conversation] Qoder discover error:', err);
      }
    }, 500);

    if (existsSync(projectDir)) {
      try {
        this.dirWatcher = watch(projectDir, (_event, filename) => {
          if (this.sessionFile || !filename?.endsWith('.jsonl')) return;
          const full = join(projectDir, filename);
          if (existsSync(full)) {
            try {
              const st = statSync(full);
              if (st.birthtimeMs >= this.spawnTime - 3000) {
                this.onSessionFileFound(full);
              }
            } catch { /* ignore */ }
          }
        });
      } catch { /* ignore */ }
    }
  }

  private findNewQoderSessionFile(projectDir: string): string | null {
    if (!existsSync(projectDir)) return null;
    let files: string[];
    try {
      files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return null;
    }

    let bestFile: string | null = null;
    let bestBirth = 0;

    for (const f of files) {
      try {
        const full = join(projectDir, f);
        const st = statSync(full);
        if (st.birthtimeMs >= this.spawnTime - 3000 && st.birthtimeMs > bestBirth) {
          bestBirth = st.birthtimeMs;
          bestFile = full;
        }
      } catch { /* ignore */ }
    }

    return bestFile;
  }

  // --- CodeBuddy CLI ---

  private startCodeBuddyCli() {
    const projectDir = getCodeBuddyProjectDir(this.rawCwd);
    console.log(`[conversation] watching CodeBuddy sessions: ${projectDir}`);

    this.discoverTimer = setInterval(() => {
      if (this.sessionFile || this.stopped) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      if (!existsSync(projectDir)) return;
      try {
        const found = this.findNewCodeBuddySessionFile(projectDir);
        if (found) this.onSessionFileFound(found);
      } catch (err) {
        console.error('[conversation] CodeBuddy discover error:', err);
      }
    }, 500);

    if (existsSync(projectDir)) {
      try {
        this.dirWatcher = watch(projectDir, (_event, filename) => {
          if (this.sessionFile || !filename?.endsWith('.jsonl')) return;
          const full = join(projectDir, filename);
          if (existsSync(full)) {
            try {
              const st = statSync(full);
              if (st.birthtimeMs >= this.spawnTime - 3000) {
                this.onSessionFileFound(full);
              }
            } catch { /* ignore */ }
          }
        });
      } catch { /* ignore */ }
    }
  }

  private findNewCodeBuddySessionFile(projectDir: string): string | null {
    if (!existsSync(projectDir)) return null;
    let files: string[];
    try {
      files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return null;
    }

    let bestFile: string | null = null;
    let bestBirth = 0;

    for (const f of files) {
      try {
        const full = join(projectDir, f);
        const st = statSync(full);
        if (st.birthtimeMs >= this.spawnTime - 3000 && st.birthtimeMs > bestBirth) {
          bestBirth = st.birthtimeMs;
          bestFile = full;
        }
      } catch { /* ignore */ }
    }

    return bestFile;
  }

  // --- Codex CLI ---

  private getCodexSessionsDir(): string {
    return join(homedir(), '.codex', 'sessions');
  }

  private startCodexCli() {
    const sessionsDir = this.getCodexSessionsDir();
    console.log(`[conversation] watching Codex sessions: ${sessionsDir}`);

    const discover = () => {
      if (this.stopped) {
        if (this.discoverTimer) clearInterval(this.discoverTimer);
        this.discoverTimer = null;
        return;
      }
      if (!existsSync(sessionsDir)) return;
      try {
        const found = this.findNewCodexSessionFile(sessionsDir);
        if (found) this.onSessionFileFound(found);
      } catch (err) {
        console.error('[conversation] Codex discover error:', err);
      }
    };

    const scheduleDiscover = () => {
      if (this.discoverDebounceTimer || this.stopped) return;
      this.discoverDebounceTimer = setTimeout(() => {
        this.discoverDebounceTimer = null;
        discover();
      }, 50);
      this.discoverDebounceTimer.unref?.();
    };

    discover();
    this.discoverTimer = setInterval(discover, 250);
    this.discoverTimer.unref?.();

    if (existsSync(sessionsDir)) {
      try {
        this.dirWatcher = watch(sessionsDir, { recursive: true }, scheduleDiscover);
      } catch { /* recursive fs.watch is best-effort; polling remains as fallback */ }
    }
  }

  private inspectCodexSession(filePath: string): { cwd?: string; prompts: string[] } {
    let fd: number | undefined;
    try {
      const stat = statSync(filePath);
      const cached = this.codexSessionInspections.get(filePath);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return { cwd: cached.cwd, prompts: cached.prompts };
      }
      const probeSize = Math.min(stat.size, CODEX_SESSION_PROBE_BYTES);
      if (probeSize <= 0) return { prompts: [] };
      const buffer = Buffer.allocUnsafe(probeSize);
      fd = openSync(filePath, 'r');
      const bytesRead = readSync(fd, buffer, 0, probeSize, 0);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      let cwd: string | undefined;
      const prompts: string[] = [];

      for (const line of lines) {
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.type === 'session_meta' && typeof obj?.payload?.cwd === 'string') {
          cwd = normalizeCwd(obj.payload.cwd);
        }
        if (
          obj?.type === 'event_msg'
          && obj?.payload?.type === 'user_message'
          && typeof obj?.payload?.message === 'string'
        ) {
          prompts.push(obj.payload.message);
        }
        if (
          obj?.type === 'response_item'
          && obj?.payload?.type === 'message'
          && obj?.payload?.role === 'user'
        ) {
          const parts = Array.isArray(obj.payload.content) ? obj.payload.content : [];
          const text = parts
            .map((part: any) => part?.text ?? part?.input_text ?? '')
            .filter(Boolean)
            .join('\n');
          if (text) {
            prompts.push(text);
          }
        }
      }
      this.codexSessionInspections.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        cwd,
        prompts,
      });
      return { cwd, prompts };
    } catch {
      return { prompts: [] };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private codexSessionMatchesExpectedPrompt(filePath: string): boolean {
    const claimedBy = ConversationWatcher.codexSessionClaims.get(filePath);
    if (claimedBy && claimedBy !== this) return false;

    const session = this.inspectCodexSession(filePath);
    if (session.cwd !== this.cwd || session.prompts.length === 0) return false;
    const now = Date.now();
    this.codexExpectedPrompts = this.codexExpectedPrompts.filter(
      expected => now - expected.recordedAt <= CODEX_EXPECTED_PROMPT_TTL_MS,
    );
    if (this.codexExpectedPrompts.length === 0) return false;
    const prompts = new Set(session.prompts.map(prompt => this.normalizeCodexPrompt(prompt)));
    return this.codexExpectedPrompts.some(expected => prompts.has(expected.content));
  }

  private findNewCodexSessionFile(sessionsDir: string): string | null {
    const nowMs = Date.now();
    this.codexExpectedPrompts = this.codexExpectedPrompts.filter(
      expected => nowMs - expected.recordedAt <= CODEX_EXPECTED_PROMPT_TTL_MS,
    );
    if (this.codexExpectedPrompts.length === 0) return null;

    let bestFile: string | null = null;
    let bestBirth = 0;

    const scanDir = (dir: string) => {
      let dirEntries: string[];
      try {
        dirEntries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of dirEntries) {
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            scanDir(full);
          } else if (entry.endsWith('.jsonl')) {
            if (
              full !== this.sessionFile
              && st.birthtimeMs >= this.spawnTime - 3000
              && st.birthtimeMs > bestBirth
              && this.codexSessionMatchesExpectedPrompt(full)
            ) {
              bestBirth = st.birthtimeMs;
              bestFile = full;
            }
          }
        } catch { /* ignore */ }
      }
    };

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayDir = join(sessionsDir, yyyy, mm, dd);

    if (existsSync(todayDir)) scanDir(todayDir);
    if (!bestFile) scanDir(sessionsDir);
    return bestFile;
  }

  // --- GitHub Copilot CLI ---

  private getCopilotSessionStateDir(): string {
    return join(homedir(), '.copilot', 'session-state');
  }

  private startCopilotCli() {
    const stateDir = this.getCopilotSessionStateDir();
    console.log(`[conversation] watching Copilot session-state: ${stateDir}`);

    this.discoverTimer = setInterval(() => {
      if (this.sessionFile || this.stopped) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      if (!existsSync(stateDir)) return;
      try {
        const found = this.findNewCopilotSessionFile(stateDir);
        if (found) this.onSessionFileFound(found);
      } catch (err) {
        console.error('[conversation] Copilot discover error:', err);
      }
    }, 500);
  }

  private findNewCopilotSessionFile(stateDir: string): string | null {
    let bestFile: string | null = null;
    let bestBirth = 0;

    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(stateDir);
    } catch {
      return null;
    }

    for (const dirName of sessionDirs) {
      const dirPath = join(stateDir, dirName);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const eventsFile = join(dirPath, 'events.jsonl');
      if (!existsSync(eventsFile)) continue;

      try {
        const st = statSync(eventsFile);
        if (st.birthtimeMs >= this.spawnTime - 3000 && st.birthtimeMs > bestBirth) {
          const wsFile = join(dirPath, 'workspace.yaml');
          if (existsSync(wsFile)) {
            const wsContent = readFileSync(wsFile, 'utf-8');
            const cwdMatch = wsContent.match(/^cwd:\s*(.+)$/m);
            if (cwdMatch) {
              const sessionCwd = normalizeCwd(cwdMatch[1].trim());
              if (sessionCwd !== this.cwd) continue;
            }
          }
          bestBirth = st.birthtimeMs;
          bestFile = eventsFile;
        }
      } catch { /* ignore */ }
    }

    return bestFile;
  }

  private findNewCursorSessionFile(transcriptsDir: string): string | null {
    const dirs = readdirSync(transcriptsDir);
    let bestFile: string | null = null;
    let bestBirth = 0;
    let bestMtimeFile: string | null = null;
    let bestMtime = 0;

    const candidates: Array<{dirName:string,filePath:string,birth:number,mtime:number,passed:boolean,mtimePassed:boolean}> = [];

    for (const dirName of dirs) {
      const dirPath = join(transcriptsDir, dirName);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const filePath = join(dirPath, `${dirName}.jsonl`);
      if (!existsSync(filePath)) continue;

      try {
        const st = statSync(filePath);
        const birth = st.birthtimeMs;
        const mtime = st.mtimeMs;
        const passed = birth >= this.spawnTime - 3000;
        const mtimePassed = mtime >= this.spawnTime - 3000;
        candidates.push({dirName,filePath,birth,mtime,passed,mtimePassed});
        if (passed && birth > bestBirth) {
          bestBirth = birth;
          bestFile = filePath;
        }
        if (mtimePassed && mtime > bestMtime) {
          bestMtime = mtime;
          bestMtimeFile = filePath;
        }
      } catch { /* ignore */ }
    }

    return bestFile ?? bestMtimeFile;
  }

  private parseCodeBuddyEntry(obj: any): ConversationEntry[] {
    if (obj?.type !== 'message') return [];
    if (obj?.providerData?.skipRun) return [];

    const role = obj.role;
    if (role !== 'user' && role !== 'assistant') return [];

    const ts = getTimestamp(obj.timestamp);
    const messageId = typeof obj.id === 'string' ? obj.id : undefined;
    const parentId = typeof obj.parentId === 'string' ? obj.parentId
      : typeof obj.parent_id === 'string' ? obj.parent_id
        : typeof obj.providerData?.parentId === 'string' ? obj.providerData.parentId
          : undefined;
    const turnId = role === 'user'
      ? messageId
      : (parentId ? this.codeBuddyTurnIdByMessageId.get(parentId) ?? parentId : this.codeBuddyCurrentTurnId);
    if (role === 'user') this.codeBuddyCurrentTurnId = turnId;
    if (messageId && turnId) this.codeBuddyTurnIdByMessageId.set(messageId, turnId);
    const blocks = Array.isArray(obj.content) ? obj.content : [];

    if (role === 'user') {
      const texts = blocks
        .filter((b: any) => (b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
      if (!texts.trim()) return [];
      if (texts.includes('<system-reminder>')) return [];
      return [{ id: obj.id || uuidv4(), role: 'user', content: texts, timestamp: ts, turnId }];
    }

    const entries: ConversationEntry[] = [];
    for (const block of blocks) {
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string' && block.text.trim()) {
        entries.push({
          id: `${obj.id || uuidv4()}-out${entries.length}`,
          role: 'assistant',
          content: block.text,
          timestamp: ts,
          turnId,
        });
      }
    }
    if (entries.length > 0) {
      const usage = obj.message?.usage ?? obj.providerData?.usage;
      if (usage && typeof usage.input_tokens === 'number') {
        const last = entries[entries.length - 1];
        last.tokens = {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          reasoning: 0,
        };
      }
    }
    return entries;
  }

  private parseQoderEntry(obj: any): ConversationEntry[] {
    if (obj?.isMeta === true) return [];
    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
      const normalized = { ...obj, message: { ...obj.message, content: text } };
      return this.parseClaudeEntry(normalized);
    }
    return this.parseClaudeEntry(obj);
  }

  // --- Gemini CLI ---

  private getGeminiProjectName(): string | null {
    const projectsFile = join(homedir(), '.gemini', 'projects.json');
    if (!existsSync(projectsFile)) return null;
    try {
      const data = JSON.parse(readFileSync(projectsFile, 'utf-8'));
      const projects: Record<string, string> = data?.projects || data;
      if (typeof projects !== 'object') return null;

      for (const [absPath, name] of Object.entries(projects)) {
        if (normalizeCwd(absPath) === this.cwd) return name;
      }
    } catch { /* ignore */ }
    return null;
  }

  private getGeminiChatsDir(projectName: string): string {
    return join(homedir(), '.gemini', 'tmp', projectName, 'chats');
  }

  private startGeminiCli() {
    console.log(`[conversation] starting Gemini CLI watcher, cwd=${this.cwd}`);

    const discover = (): boolean => {
      if (this.stopped) return false;

      const projectName = this.getGeminiProjectName();
      if (!projectName) return false;

      const chatsDir = this.getGeminiChatsDir(projectName);
      if (!existsSync(chatsDir)) return false;

      const sessionFile = this.findNewGeminiSessionFile(chatsDir);
      if (!sessionFile) return false;

      console.log(`[conversation] Gemini session found: ${sessionFile}`);
      this.sessionFile = sessionFile;
      this.geminiLastMessageCount = 0;

      this.readGeminiUpdates();

      try {
        this.fileWatcher = watch(sessionFile, () => {
          this.readGeminiUpdates();
        });
      } catch { /* ignore */ }

      return true;
    };

    if (discover()) return;

    this.discoverTimer = setInterval(() => {
      if (this.sessionFile || this.stopped) {
        clearInterval(this.discoverTimer!);
        this.discoverTimer = null;
        return;
      }
      discover();
    }, 500);
  }

  private findNewGeminiSessionFile(chatsDir: string): string | null {
    let files: string[];
    try {
      files = readdirSync(chatsDir).filter(
        f => f.startsWith('session-') && f.endsWith('.json'),
      );
    } catch {
      return null;
    }

    let bestFile: string | null = null;
    let bestBirth = 0;

    for (const f of files) {
      const full = join(chatsDir, f);
      try {
        const st = statSync(full);
        if (st.birthtimeMs >= this.spawnTime - 3000 && st.birthtimeMs > bestBirth) {
          bestBirth = st.birthtimeMs;
          bestFile = full;
        }
      } catch { /* ignore */ }
    }

    return bestFile;
  }

  private readGeminiUpdates() {
    if (!this.sessionFile || this.stopped) return;

    try {
      const raw = readFileSync(this.sessionFile, 'utf-8');
      const data = JSON.parse(raw);
      const allEntries = parseGeminiSessionFile(data);

      if (allEntries.length > this.geminiLastMessageCount) {
        const newEntries = allEntries.slice(this.geminiLastMessageCount);
        this.geminiLastMessageCount = allEntries.length;

        if (newEntries.length > 0) {
          this.emit('entries', newEntries);
        }
      }
    } catch { /* ignore */ }
  }

  // --- OpenCode ---

  private startOpenCode() {
    const dbPath = getOpenCodeDbPath(this.cwd);
    const waitForDb = startWhenFileExists(
      dbPath,
      () => {
        if (this.stopped) return;
      console.log(`[conversation] OpenCode polling db, cwd=${this.cwd}`);
        this.discoverOpenCodeSession(dbPath);
      },
      () => {
        console.log(`[conversation] OpenCode db not found yet, waiting: ${dbPath}`);
      },
    );

    if (waitForDb) this.discoverTimer = waitForDb;
  }

  private discoverOpenCodeSession(dbPath: string) {
    const poll = setInterval(async () => {
      if (this.stopped) {
        clearInterval(poll);
        return;
      }
      try {
        const escapedCwd = this.cwd.replace(/'/g, "''");
        const { stdout } = await execFileAsync('sqlite3', [
          '-cmd', '.timeout 3000', dbPath,
          `SELECT id FROM session WHERE directory = '${escapedCwd}' AND time_created > ${this.spawnTime - 5000} ORDER BY time_created DESC LIMIT 1;`,
        ]);
        const id = stdout.trim();
        if (id) {
          clearInterval(poll);
          this.ocSessionId = id;
          console.log(`[conversation] OpenCode session: ${id}`);
          this.pollOpenCodeParts(dbPath);
        }
      } catch (err) {
        console.error('[conversation] OpenCode discover error:', err);
      }
    }, 1000);

    this.discoverTimer = poll;
  }

  // --- Kiro CLI ---

  private startKiroCli() {
    const dbPath = getKiroCliDbPath(this.cwd);
    const waitForDb = startWhenFileExists(
      dbPath,
      () => {
        if (this.stopped) return;
        console.log(`[conversation] Kiro CLI polling db, cwd=${this.cwd}`);
        this.pollKiroSessions(dbPath);
      },
      () => {
        console.log(`[conversation] Kiro CLI db not found yet, waiting: ${dbPath}`);
      },
    );

    if (waitForDb) this.discoverTimer = waitForDb;
  }

  private pollKiroSessions(dbPath: string) {
    const read = async () => {
      if (this.stopped) return;
      try {
        const escapedCwd = this.cwd.replace(/'/g, "''");
        const { stdout } = await execFileAsync('sqlite3', [
          '-cmd', '.timeout 3000', '-json', dbPath,
          `SELECT value FROM conversations_v2 WHERE key = '${escapedCwd}' ORDER BY updated_at DESC LIMIT 1;`,
        ], { maxBuffer: 10 * 1024 * 1024 });

        if (!stdout.trim()) return;

        const rows = JSON.parse(stdout) as Array<{ value: string }>;
        if (!rows.length) return;

        const raw = rows[0].value;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const convId = String(parsed?.conversation_id ?? '');
        if (convId !== this.kiroLastConvId) {
          this.kiroLastConvId = convId;
          this.kiroEmittedHistoryCount = 0;
        }

        const history = parsed?.history;
        if (!Array.isArray(history) || history.length <= this.kiroEmittedHistoryCount) return;

        const newEntries = parseNewKiroHistoryTurns(parsed, this.kiroEmittedHistoryCount);
        this.kiroEmittedHistoryCount = history.length;

        if (newEntries.length > 0) {
          this.emit('entries', newEntries);
        }
      } catch (err) {
        console.error('[conversation] Kiro CLI poll error:', err);
      }
    };

    read();
    this.kiroPollTimer = setInterval(read, 1000);
  }

  private pollOpenCodeParts(dbPath: string) {
    const read = async () => {
      if (this.stopped || !this.ocSessionId) return;
      try {
        const { stdout, stderr } = await execFileAsync('sqlite3', [
          '-cmd', '.timeout 3000', '-json', dbPath,
          `SELECT p.id, p.data, p.time_created, m.id as message_id, m.data as msg_data
           FROM part p
           JOIN message m ON p.message_id = m.id
           WHERE p.session_id = '${this.ocSessionId}'
           ORDER BY p.time_created;`,
        ], { maxBuffer: 10 * 1024 * 1024 });

        if (stderr) console.error('[conversation] sqlite3 stderr:', stderr);
        if (!stdout.trim()) return;

        const rows = JSON.parse(stdout);
        const newRows = rows.filter(
          (r: any) => !this.ocSeenParts.has(r.id) || this.ocSeenParts.get(r.id) !== r.data,
        );
        if (newRows.length === 0) return;

        for (const r of newRows) this.ocSeenParts.set(r.id, r.data);

        const entries: ConversationEntry[] = [];
        for (const row of newRows) {
          try {
            const partData = JSON.parse(row.data);
            const msgData = JSON.parse(row.msg_data);
            const e = this.parseOpenCodePart(
              partData, msgData, row.id, row.time_created, row.message_id,
            );
            if (e) entries.push(e);
          } catch (err) {
            console.error('[conversation] part parse error:', err);
          }
        }

        if (entries.length > 0) {
          this.emit('entries', entries);
        }
      } catch (err) {
        console.error('[conversation] OpenCode poll error:', err);
      }
    };

    read();
    this.ocPollTimer = setInterval(read, 1000);
  }

  private parseOpenCodePart(
    part: any, msg: any, partId: string, ts: number, databaseMessageId?: string,
  ): ConversationEntry | null {
    const role = msg.role as string;
    const messageId = typeof msg.id === 'string' ? msg.id : databaseMessageId;
    const parentId = typeof msg.parentID === 'string' ? msg.parentID
      : typeof msg.parentId === 'string' ? msg.parentId
        : typeof msg.parent_id === 'string' ? msg.parent_id
          : undefined;
    const turnId = role === 'user'
      ? messageId
      : (parentId ? this.ocTurnIdByMessageId.get(parentId) ?? parentId : this.ocCurrentTurnId);
    if (role === 'user') this.ocCurrentTurnId = turnId;
    if (messageId && turnId) this.ocTurnIdByMessageId.set(messageId, turnId);

    if (part.type === 'text' && part.text) {
      return {
        id: partId,
        role: role === 'user' ? 'user' : 'assistant',
        content: part.text,
        timestamp: ts,
        turnId,
        tokens: msg.tokens
          ? { input: msg.tokens.input || 0, output: msg.tokens.output || 0, reasoning: msg.tokens.reasoning || 0 }
          : undefined,
        cost: msg.cost,
      };
    }

    if (part.type === 'reasoning' && part.text) {
      return { id: partId, role: 'thinking', content: truncate(part.text), timestamp: ts, turnId };
    }

    if (part.type === 'tool' && part.state) {
      const toolName = part.tool || 'unknown';
      const status = part.state.status || 'pending';
      const input = part.state.input;
      const output = part.state.output;
      const error = part.state.error;

      let content: string;
      if (status === 'error' && error) {
        const inputSummary = input ? this.formatToolInput(toolName, input) : '';
        content = inputSummary ? `${inputSummary}\n\n❌ ${error}` : `❌ ${error}`;
      } else if (status === 'completed' && output) {
        const inputSummary = input ? this.formatToolInput(toolName, input) : '';
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
        content = inputSummary
          ? `${inputSummary}\n\n${truncate(outputStr, 800)}`
          : truncate(outputStr, 800);
      } else if (input) {
        content = this.formatToolInput(toolName, input);
      } else {
        content = `[${status}]`;
      }

      return {
        id: partId,
        role: 'tool',
        content,
        toolName: `${toolName}${status === 'error' ? ' ✗' : status === 'completed' ? ' ✓' : ''}`,
        timestamp: ts,
        turnId,
      };
    }

    if (part.type === 'step-finish' && part.tokens) {
      const t = part.tokens;
      const total = t.total || 0;
      const outputTokens = t.output || 0;
      const reasoning = t.reasoning || 0;
      const cached = t.cache?.read || 0;
      const cost = part.cost ?? 0;

      const parts: string[] = [];
      if (total) parts.push(`tokens: ${total.toLocaleString()}`);
      if (outputTokens) parts.push(`output: ${outputTokens}`);
      if (reasoning) parts.push(`reasoning: ${reasoning}`);
      if (cached) parts.push(`cache: ${cached.toLocaleString()}`);
      if (cost > 0) parts.push(`$${cost.toFixed(4)}`);

      if (parts.length > 0) {
        return { id: partId, role: 'system', content: parts.join('  ·  '), timestamp: ts, turnId };
      }
    }

    return null;
  }

  private formatToolInput(toolName: string, input: any): string {
    if (!input) return '';
    switch (toolName) {
      case 'read':
        return input.filePath || JSON.stringify(input);
      case 'write':
        return `${input.filePath || '?'}\n${truncate(input.content || '', 500)}`;
      case 'edit':
        return `${input.filePath || '?'}\n${truncate(input.diff || input.old || '', 500)}`;
      case 'bash':
        return input.command || JSON.stringify(input);
      case 'glob':
        return input.pattern || JSON.stringify(input);
      case 'grep':
        return `${input.pattern || ''} ${input.path || ''}`.trim() || JSON.stringify(input);
      case 'fetch':
        return input.url || JSON.stringify(input);
      case 'todowrite':
      case 'todoupdate':
        return truncate(JSON.stringify(input, null, 2), 500);
      default:
        return truncate(JSON.stringify(input, null, 2), 500);
    }
  }
}
