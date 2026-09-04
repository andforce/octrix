import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { getSupportedAgent, isSupportedAgentPlatform } from '../src/agent-platforms.js';
import { ConversationWatcher, detectProfileId, isStreamingConversationEntry } from './conversation-watcher.js';
import { CodexTerminalActivityTracker } from './codex-terminal-activity.js';
import { MACOS_APP_BIN_DIRS, SYSTEM_BIN_DIRS, userBinDirs } from './cli-paths.js';
import { conversationEntryKey, type ConversationEntry } from './models.js';

const STARTUP_FAILURE_WINDOW_MS = 2_000;
const STARTUP_WAIT_INTERVAL_MS = 50;
const require = createRequire(import.meta.url);

function runtimeNodeDirs(env?: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];

  const explicitNode = env?.CLI_BRIDGE_NODE;
  if (explicitNode) dirs.push(path.dirname(explicitNode));

  if (process.execPath) dirs.push(path.dirname(process.execPath));
  return dirs.filter(Boolean);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePathDirs(
  pathValues: Array<string | undefined> = [process.env.PATH],
  env?: NodeJS.ProcessEnv,
): string[] {
  const homeDir = env?.HOME || os.homedir();
  const parts = pathValues
    .flatMap(value => (value ?? '').split(':'))
    .map(part => part.trim())
    .filter(Boolean);
  return [...new Set([
    ...runtimeNodeDirs(env),
    ...userBinDirs(homeDir),
    ...parts,
    ...SYSTEM_BIN_DIRS,
    ...MACOS_APP_BIN_DIRS,
  ])];
}

export function augmentedPath(
  pathValues: Array<string | undefined> = [process.env.PATH],
  env?: NodeJS.ProcessEnv,
): string {
  return candidatePathDirs(pathValues, env).join(':');
}

export function resolveBinary(
  name: string,
  pathValues: Array<string | undefined> = [process.env.PATH],
  env?: NodeJS.ProcessEnv,
): string {
  for (const dir of candidatePathDirs(pathValues, env)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return name;
}

export interface ManagedProcess {
  id: string;
  agentId?: string;
  groupId?: string;
  name: string;
  command: string;
  platform?: string;
  sessionName: string;
  launchedAt: number;
  isRunning: boolean;
  logFilePath?: string;
}

interface PendingResponseIdentity {
  /** Opaque response handle seeded from the dispatch request's clientMsgId. */
  responseId?: string;
  /** Envelope currently shown to clients for this response. */
  envelopeId?: string;
  /** Native turn identifier emitted by the CLI transcript, when available. */
  transcriptTurnId?: string;
}

interface PendingInputDispatch {
  deferredTimer?: ReturnType<typeof setTimeout>;
  payloadTimer?: ReturnType<typeof setTimeout>;
  enterTimer?: ReturnType<typeof setTimeout>;
  started: boolean;
  payloadWritten: boolean;
  submitted: boolean;
}

interface PendingResponse {
  identity: PendingResponseIdentity;
  groupId: string;
  taskSessionId?: string;
  snapshotOffset: number;
  lastFileSize: number;
  stableCount: number;
  hasStructuredEntries?: boolean;
  lastStructuredAt?: number;
  rawCompletedAt?: number;
  entryStartIndex: number;
  minEntryTimestampMs?: number;
  sentText?: string;
  createdAt: number;
  inputDispatch?: PendingInputDispatch;
}

interface ConversationState {
  watcher: ConversationWatcher;
  allEntries: ConversationEntry[];
  groupId: string;
  taskSessionId?: string;
  lastEnvelopeId?: string;
  suppressUnclaimedUntil?: number;
  activeTranscriptTurnId?: string;
  interruptedTranscriptTurnIds?: Set<string>;
  unresolvedInterruptedPrompts?: string[];
  pendingTranscriptTurnId?: string;
  awaitingTurnBoundaryAfterInterrupt?: boolean;
}

interface ConversationWatcherResetEvent {
  reason?: 'session_switch' | 'truncate';
  filePath?: string;
}

interface WorkspaceTerminalSession {
  terminalId: string;
  terminalName: string;
  procId: string;
  workingDirectory: string;
}

interface AgentFailureInfo {
  agentId: string;
  procId: string;
  exitCode: number | null;
  message: string;
  logFilePath?: string;
  failedAt: number;
}

export type ModelPickerStatus = 'starting' | 'selecting' | 'fallback' | 'chosen' | 'cancelled' | 'expired';
export type ModelPickerInputAction = 'up' | 'down' | 'enter' | 'escape';
export type ModelPickerMode = 'model' | 'effort';

export interface ModelPickerOption {
  id: string;
  label: string;
  isCurrent?: boolean;
}

export interface ModelPickerSnapshot {
  agentId: string;
  groupId: string;
  mode: ModelPickerMode;
  status: ModelPickerStatus;
  options: ModelPickerOption[];
  selectedIndex: number | null;
  rawPreview: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export type AgentStartupPromptKind = 'workspace-trust' | 'bypass-permissions';
export type AgentStartupPromptAction = 'accept' | 'decline';

export interface AgentStartupPrompt {
  kind: AgentStartupPromptKind;
  agentId: string;
  agentName: string;
  groupId: string;
  directory: string;
  rawPreview: string;
  detectedAt: number;
  updatedAt: number;
}

interface ModelPickerSession {
  agentId: string;
  groupId: string;
  mode: ModelPickerMode;
  raw: string;
  startedAt: number;
  updatedAt: number;
  status: ModelPickerStatus;
  error?: string;
  autoOpenedEffort?: boolean;
}

interface ParsedModelPicker {
  options: ModelPickerOption[];
  selectedIndex: number | null;
  rawPreview: string;
  kind?: 'codex-model' | 'codex-effort' | 'claude-model' | 'claude-effort' | 'generic';
}

const MODEL_PICKER_FALLBACK_AFTER_MS = 3_500;
const MODEL_PICKER_SESSION_TTL_MS = 120_000;
const MODEL_PICKER_MAX_RAW_CHARS = 80_000;
const MODEL_PICKER_RESTART_DELAY_MS = 180;
const AGENT_STARTUP_PROMPT_MAX_RAW_CHARS = 80_000;
const CLAUDE_FAMILY_PLATFORMS = new Set(['claude-code', 'openclaude']);
const AGENT_STARTUP_PROMPT_PLATFORMS = CLAUDE_FAMILY_PLATFORMS;
const BRACKETED_PASTE_MULTILINE_PLATFORMS = new Set([
  'claude-code',
  'openclaude',
  'opencode',
  'github-copilot-cli',
  'openai-codex-cli',
  'cursor-cli',
  'kiro-cli',
  'qoder-cli',
  'codebuddy-cli',
]);
const RESPONSE_REFRESH_INTERVAL_MS = 200;
const STRUCTURED_WATCHER_RAW_LINGER_MS = 30_000;
const STRUCTURED_ENTRY_QUIET_MS = 1_000;
const INTERRUPT_TAIL_SUPPRESSION_MS = 2_000;
const INTERRUPT_BOUNDARY_WAIT_MS = 2_000;
const DEFAULT_RESPONSE_INTERRUPT_KEY = '\x1b';
const GEMINI_RESPONSE_INTERRUPT_KEY = '\x03';

function normalizeOutput(output: string): string {
  return output.split('\n').map(line => line.trimEnd()).join('\n');
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-Ba-z]/g, '')
    .replace(/\x1b[>=<NOM78DEFHZ\\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

function terminalTextForParsing(raw: string): string {
  return stripAnsi(raw.replace(/\r/g, '\n'))
    .replace(/\x00/g, '')
    .replace(/[\x0e\x0f]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');
}

function modelPickerRawPreview(raw: string): string {
  const text = terminalTextForParsing(raw);
  const lines = text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  return lines.slice(-80).join('\n');
}

function agentStartupPromptTextForParsing(raw: string): string {
  return terminalTextForParsing(
    raw
      .replace(/\x1b\[(\d+)C/g, (_, count) => ' '.repeat(Math.min(Number(count) || 1, 20)))
      .replace(/\x1b\[(\d*)G/g, (_, count) => ' '.repeat(Math.min(Number(count) || 1, 200)))
      .replace(/\x1b\[(\d+)D/g, ''),
  ).replace(/[ \t]+/g, ' ');
}

export function parseWorkspaceTrustPromptOutput(raw: string): { directory: string; rawPreview: string } | null {
  const text = agentStartupPromptTextForParsing(raw);
  const promptStart = text.lastIndexOf('Accessing workspace:');
  if (promptStart < 0) return null;

  const section = text.slice(promptStart);
  if (!/Quick safety check:/i.test(section)) return null;
  if (!/Yes,\s*I trust this folder/i.test(section)) return null;
  if (!/Enter to confirm/i.test(section)) return null;

  const directoryMatch = section.match(/Accessing workspace:\s*\n+\s*([^\n]+)/i);
  const directory = directoryMatch?.[1]?.trim() ?? '';
  const rawPreview = section
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, 80)
    .join('\n');

  return { directory, rawPreview };
}

export function parseBypassPermissionsPromptOutput(raw: string): { rawPreview: string } | null {
  const text = agentStartupPromptTextForParsing(raw);
  const promptStart = Math.max(
    text.lastIndexOf('WARNING: Claude Code running in Bypass Permissions mode'),
    text.lastIndexOf('Claude Code running in Bypass Permissions mode'),
  );
  if (promptStart < 0) return null;

  const section = text.slice(promptStart);
  if (!/No,\s*exit/i.test(section)) return null;
  if (!/Yes,\s*I accept/i.test(section)) return null;
  if (!/Enter to confirm/i.test(section)) return null;

  const rawPreview = section
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, 80)
    .join('\n');
  return { rawPreview };
}

export function parseAgentStartupPromptOutput(
  raw: string,
): { kind: AgentStartupPromptKind; directory: string; rawPreview: string } | null {
  const workspaceTrust = parseWorkspaceTrustPromptOutput(raw);
  const bypassPermissions = parseBypassPermissionsPromptOutput(raw);
  if (!workspaceTrust && !bypassPermissions) return null;

  if (bypassPermissions && !workspaceTrust) {
    return {
      kind: 'bypass-permissions',
      directory: '',
      rawPreview: bypassPermissions.rawPreview,
    };
  }
  if (workspaceTrust && !bypassPermissions) {
    return { kind: 'workspace-trust', ...workspaceTrust };
  }

  const text = agentStartupPromptTextForParsing(raw);
  const workspaceIndex = workspaceTrust ? text.lastIndexOf('Accessing workspace:') : -1;
  const bypassIndex = bypassPermissions ? text.lastIndexOf('Bypass Permissions mode') : -1;
  if (bypassPermissions && bypassIndex > workspaceIndex) {
    return {
      kind: 'bypass-permissions',
      directory: '',
      rawPreview: bypassPermissions.rawPreview,
    };
  }
  return workspaceTrust ? { kind: 'workspace-trust', ...workspaceTrust } : null;
}

function agentStartupPromptActionPayload(
  prompt: AgentStartupPrompt,
  action: AgentStartupPromptAction,
): string {
  const acceptPattern = prompt.kind === 'workspace-trust'
    ? /Yes,\s*I trust this folder/i
    : /Yes,\s*I accept/i;
  const declinePattern = /No,\s*exit/i;
  const targetPattern = action === 'accept' ? acceptPattern : declinePattern;
  const choices = prompt.rawPreview
    .split('\n')
    .filter(line => acceptPattern.test(line) || declinePattern.test(line));
  const selectedIndex = choices.findIndex(line => /[❯›]/u.test(line));
  const targetIndex = choices.findIndex(line => targetPattern.test(line));

  if (selectedIndex >= 0 && targetIndex >= 0) {
    const offset = targetIndex - selectedIndex;
    if (offset > 0) return `${'\x1b[B'.repeat(offset)}\r`;
    if (offset < 0) return `${'\x1b[A'.repeat(-offset)}\r`;
    return '\r';
  }

  // Current Claude Code versions default both safety prompts to "No, exit".
  // Preserve compatibility with output variants where the selection marker is
  // unavailable by moving down once for acceptance and confirming in place for exit.
  return action === 'accept' ? '\x1b[B\r' : '\r';
}

const MODEL_LINE_KEYWORD = /\b(?:gpt|claude|sonnet|opus|haiku|codex|copilot|o[1-9]\d?|auto|default|fast|balanced)\b/i;
const MODEL_HEADER_LINE = /^(?:select|choose|switch|available|current|use arrows|press|enter|esc|escape|model|models|\/model|选择|切换|模型)/i;
const CLAUDE_MODEL_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]*(?:\\[[^\\]\\s]+\\])?';
const CLAUDE_EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
  { value: 'max', label: 'Max' },
  { value: 'ultracode', label: 'Ultracode' },
];

function shouldIgnoreModelPickerLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '').toLowerCase();
  return line.startsWith('/')
    || line.includes('│')
    || /[╭╮╰╯─]/u.test(line)
    || compact.includes('/model/model')
    || compact.includes('choosewhatmodel')
    || compact.includes('/modeltochange')
    || compact.includes('use/skills')
    || compact.includes('claudecodev')
    || compact.includes('tipsforgettingstarted')
    || compact.includes('welcomeback')
    || compact.includes('what\'snew')
    || compact.includes('claudesonnet5sessions')
    || compact.includes('apiusagebilling')
    || compact.includes('/release-notes')
    || compact.includes('permissionmode')
    || compact.includes('switchbetweenclaudemodels')
    || compact.includes('yourpickbecomesthedefault')
    || compact.includes('referencefortheclaudeapi')
    || compact.includes('beforeopeningthetargetfile')
    || compact.includes("don'tskipbecause")
    || line.includes(' · ');
}

function parseModelPickerLine(line: string): { label: string; selected: boolean; current: boolean } | null {
  let cleaned = line
    .replace(/^[│┃|]\s*/, '')
    .replace(/\s*[│┃|]$/, '')
    .trim();

  if (!cleaned) return null;
  if (shouldIgnoreModelPickerLine(cleaned)) return null;

  let selected = false;
  let current = /\b(?:current|selected|active)\b|当前|已选/i.test(cleaned);

  if (/^(?:[>›▸➜→❯]|●|◉|◆|✓|✔)\s*/u.test(cleaned)) {
    selected = true;
    cleaned = cleaned.replace(/^(?:[>›▸➜→❯]|●|◉|◆|✓|✔)\s*/u, '').trim();
  } else {
    cleaned = cleaned.replace(/^(?:[○◦]\s*)/u, '').trim();
  }

  if (!cleaned) return null;
  if (shouldIgnoreModelPickerLine(cleaned)) return null;

  const checkbox = cleaned.match(/^\[([ x*✓✔])\]\s*(.+)$/iu);
  if (checkbox) {
    selected = selected || checkbox[1].trim().length > 0;
    cleaned = checkbox[2].trim();
  }

  const numbered = cleaned.match(/^(?:\(?\d+\)?[.)])\s+(.+)$/);
  if (numbered) {
    cleaned = numbered[1].trim();
  }

  cleaned = cleaned
    .replace(/\s*(?:\((?:current|selected|active|default)\)|\[(?:current|selected|active|default)\]|当前|已选).*$/iu, '')
    .trim();

  if (!cleaned) return null;

  const headerLike = MODEL_HEADER_LINE.test(cleaned);
  const hasModelKeyword = MODEL_LINE_KEYWORD.test(cleaned);
  const hasModelShape = /(?:^|\s)(?:o\d(?:-[\w.-]+)?|gpt-[\w.-]+|claude-[\w.-]+)(?:\s|$)/i.test(cleaned);
  const hasModelMarker = current || !!checkbox || !!numbered;
  if (headerLike && !hasModelKeyword && !hasModelMarker) return null;
  if (!hasModelKeyword && !hasModelShape && !hasModelMarker) return null;

  return { label: cleaned, selected, current };
}

function normalizeClaudeModelDescription(description: string): string {
  return description
    .replace(/[✓✔]/gu, '')
    .replace(/\[(?:\d{1,3})(?:;\d{1,3})*m\]?/g, '')
    .replace(/\bCusom\b/g, 'Custom')
    .replace(/\bCustommodel\b/gi, 'Custom model')
    .replace(/\bCustom\s*(Opus|Sonnet|Haiku)model\b/gi, 'Custom $1 model')
    .replace(/\bCustom\s*(Opus|Sonnet|Haiku)ml\b/gi, 'Custom $1 model')
    .replace(/\((\d+M)context\)/gi, '($1 context)')
    .replace(/\b(\d+M)context\b/gi, '$1 context')
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)\s*/g, ') ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseClaudePickerTerminalOutput(text: string, rawPreview: string): ParsedModelPicker | null {
  const selectIndex = Math.max(text.lastIndexOf('Select model'), text.lastIndexOf('Selectmodel'));
  const switchIndex = Math.max(
    text.lastIndexOf('Switch between Claude models'),
    text.lastIndexOf('Switch betweenClaudemodels'),
  );
  const startIndex = Math.max(selectIndex, switchIndex);
  if (startIndex < 0) return null;

  let section = text.slice(startIndex);
  const footerMatch = section.match(/(?:Enter\s*to\s*set|Entertoset|Esc\s*to\s*cancel|Esctocancel)/i);
  if (footerMatch?.index !== undefined) {
    section = section.slice(0, footerMatch.index);
  }

  const normalizedSection = section
    .replace(/(?=(?:[>›▸➜→❯]\s*)?\d+[.)]\s*Default\s*\(recommended\))/giu, '\n')
    .replace(
      new RegExp(`(?=(?:[>›▸➜→❯]\\s*)?\\d+[.)]\\s*${CLAUDE_MODEL_ID_PATTERN}\\s*[✓✔]?\\s*(?:Custom|Cusom)\\s*(?:Opus|Sonnet|Haiku|model))`, 'giu'),
      '\n',
    );

  const options: ModelPickerOption[] = [];
  const seen = new Set<string>();
  let selectedIndex: number | null = null;

  for (const rawLine of normalizedSection.split('\n')) {
    let line = rawLine
      .replace(/^[│┃|]\s*/, '')
      .replace(/\s*[│┃|]$/, '')
      .trim();
    if (!line) continue;

    let selected = false;
    if (/^(?:[>›▸➜→❯]|●|◉|◆)\s*/u.test(line)) {
      selected = true;
      line = line.replace(/^(?:[>›▸➜→❯]|●|◉|◆)\s*/u, '').trim();
    }
    line = line.replace(/^(?:\(?\d+\)?[.)])\s*/, '').trim();

    const checked = /[✓✔]/u.test(line);
    selected = selected || checked;

    let label: string | null = null;
    const compactLine = line.replace(/\s+/g, '');
    if (/^Default\(recommended\)/i.test(compactLine)) {
      label = 'Default (recommended)';
    } else {
      const customMatch = line.match(new RegExp(`^(${CLAUDE_MODEL_ID_PATTERN})\\s*[✓✔]?\\s*((?:Custom|Cusom).*)$`, 'i'));
      if (customMatch) {
        const modelId = customMatch[1].trim();
        const description = normalizeClaudeModelDescription(customMatch[2]);
        label = description ? `${modelId} - ${description}` : modelId;
      }
    }

    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (selected && selectedIndex === null) {
      selectedIndex = options.length;
    }
    options.push({
      id: `model-${options.length}`,
      label,
      ...(checked ? { isCurrent: true } : {}),
    });
  }

  if (options.length === 0) return null;
  return { options, selectedIndex, rawPreview, kind: 'claude-model' };
}

function looksLikeClaudeModelPicker(text: string): boolean {
  const compact = text.replace(/\s+/g, '').toLowerCase();
  return compact.includes('selectmodel') && compact.includes('switchbetweenclaudemodels');
}

function parseClaudeEffortPickerTerminalOutput(text: string, rawPreview: string): ParsedModelPicker | null {
  const compact = text.replace(/\s+/g, '').toLowerCase();
  if (!compact.includes('lowmediumhighxhighmaxultracode')) return null;
  if (!compact.includes('←/→toadjust') && !compact.includes('entertoconfirm')) return null;

  const matches = [...text.matchAll(/◈\s*(low|medium|high|xhigh|max|ultracode)\s*·?\s*\/effort/giu)];
  const selectedValue = matches.at(-1)?.[1]?.toLowerCase();
  const selectedIndex = selectedValue
    ? CLAUDE_EFFORT_OPTIONS.findIndex(option => option.value === selectedValue)
    : null;
  const normalizedSelectedIndex = selectedIndex !== null && selectedIndex >= 0 ? selectedIndex : null;
  const options = CLAUDE_EFFORT_OPTIONS.map((option, index) => ({
    id: `model-${index}`,
    label: option.label,
    ...(index === normalizedSelectedIndex ? { isCurrent: true } : {}),
  }));

  return {
    options,
    selectedIndex: normalizedSelectedIndex,
    rawPreview,
    kind: 'claude-effort',
  };
}

function parseCodexNumberedSection(
  section: string,
  kind: 'codex-model' | 'codex-effort',
): { options: ModelPickerOption[]; selectedIndex: number | null } {
  const options: ModelPickerOption[] = [];
  let selectedIndex: number | null = null;
  const seen = new Set<string>();
  const normalizedSection = kind === 'codex-effort'
    ? section.replace(/(?=(?:›\s*)?\d+\.\s*(?:Low|Medium|High|Extra high))/giu, '\n')
    : section.replace(/(?=(?:›\s*)?\d+\.\s*(?:gpt-|o\d|codex)[a-z0-9._-]*)/gu, '\n');
  const itemPattern = kind === 'codex-effort'
    ? /(?:^|\s)(›\s*)?(\d+)\.\s*(Low|Medium|High|Extra high)\s*(?:\((current|default)\))?/giu
    : /(?:^|\s)(›\s*)?(\d+)\.\s*([a-z0-9][a-z0-9._-]*)\s*(?:\((current|default)\))?/gu;

  for (const match of normalizedSection.matchAll(itemPattern)) {
    const label = match[3].trim();
    const marker = match[1];
    const tag = match[4]?.toLowerCase();
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const isCurrent = tag === 'current';
    if ((marker || isCurrent) && selectedIndex === null) {
      selectedIndex = options.length;
    }
    options.push({
      id: `model-${options.length}`,
      label,
      ...(isCurrent ? { isCurrent: true } : {}),
    });
  }

  return { options, selectedIndex };
}

function parseCodexPickerTerminalOutput(text: string, rawPreview: string): ParsedModelPicker | null {
  const effortIndex = text.lastIndexOf('Select Reasoning Level');
  const modelIndex = text.lastIndexOf('Select Model and Effort');
  if (effortIndex >= 0 && effortIndex > modelIndex) {
    const section = text.slice(effortIndex, text.indexOf('Press enter', effortIndex) >= 0
      ? text.indexOf('Press enter', effortIndex)
      : undefined);
    const parsed = parseCodexNumberedSection(section, 'codex-effort');
    if (parsed.options.length > 0) {
      return { ...parsed, rawPreview, kind: 'codex-effort' };
    }
  }
  if (modelIndex >= 0) {
    const section = text.slice(modelIndex, text.indexOf('Press enter', modelIndex) >= 0
      ? text.indexOf('Press enter', modelIndex)
      : undefined);
    const parsed = parseCodexNumberedSection(section, 'codex-model');
    if (parsed.options.length > 0) {
      return { ...parsed, rawPreview, kind: 'codex-model' };
    }
  }
  return null;
}

export function parseModelPickerTerminalOutput(raw: string): ParsedModelPicker {
  const rawPreview = modelPickerRawPreview(raw);
  const text = terminalTextForParsing(raw);
  const codexParsed = parseCodexPickerTerminalOutput(text, rawPreview);
  if (codexParsed) return codexParsed;
  const claudeEffortParsed = parseClaudeEffortPickerTerminalOutput(text, rawPreview);
  if (claudeEffortParsed) return claudeEffortParsed;
  const claudeParsed = parseClaudePickerTerminalOutput(text, rawPreview);
  if (claudeParsed) return claudeParsed;
  if (looksLikeClaudeModelPicker(text)) {
    return { options: [], selectedIndex: null, rawPreview, kind: 'claude-model' };
  }

  const lines = text.split('\n');
  const options: ModelPickerOption[] = [];
  const seen = new Set<string>();
  let selectedIndex: number | null = null;

  for (const line of lines) {
    const parsed = parseModelPickerLine(line);
    if (!parsed) continue;
    const key = parsed.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const option: ModelPickerOption = {
      id: `model-${options.length}`,
      label: parsed.label,
      ...(parsed.current ? { isCurrent: true } : {}),
    };
    if (parsed.selected && selectedIndex === null) {
      selectedIndex = options.length;
    }
    if (parsed.current && selectedIndex === null) {
      selectedIndex = options.length;
    }
    options.push(option);
  }

  return { options, selectedIndex, rawPreview, kind: 'generic' };
}

function readLogFromOffset(filePath: string, offset: number): string {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length <= offset) return '';
    return buffer.slice(offset).toString('utf-8');
  } catch {
    return '';
  }
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function usesGeminiInputMode(proc: Pick<ManagedProcess, 'name' | 'command'>): boolean {
  return proc.name.startsWith('Gemini CLI') || /\bgemini\b/i.test(proc.command);
}

function responseInterruptKey(proc: Pick<ManagedProcess, 'name' | 'command'>): string {
  return usesGeminiInputMode(proc)
    ? GEMINI_RESPONSE_INTERRUPT_KEY
    : DEFAULT_RESPONSE_INTERRUPT_KEY;
}

function isCodexProcess(proc: Pick<ManagedProcess, 'name' | 'command' | 'platform'>): boolean {
  return proc.platform === 'openai-codex-cli'
    || proc.name.startsWith('Codex CLI')
    || proc.name.startsWith('OpenAI Codex CLI')
    || /\bcodex\b/i.test(proc.command);
}

function isClaudeFamilyProcess(proc: Pick<ManagedProcess, 'name' | 'command' | 'platform'>): boolean {
  return (proc.platform ? CLAUDE_FAMILY_PLATFORMS.has(proc.platform) : false)
    || proc.name.startsWith('Claude Code')
    || proc.name.startsWith('OpenClaude')
    || /\b(?:claude|openclaude)\b/i.test(proc.command);
}

function isClaudeModelPickerProcess(proc: Pick<ManagedProcess, 'name' | 'command' | 'platform'>): boolean {
  return isClaudeFamilyProcess(proc);
}

function usesBracketedPasteForMultilineInput(proc: Pick<ManagedProcess, 'name' | 'command' | 'platform'>): boolean {
  if (usesGeminiInputMode(proc)) return false;
  return (proc.platform ? BRACKETED_PASTE_MULTILINE_PLATFORMS.has(proc.platform) : false)
    || isCodexProcess(proc)
    || isClaudeFamilyProcess(proc);
}

function ensureNodePtyHelpersExecutable() {
  try {
    const packageJsonPath = require.resolve('node-pty/package.json');
    const prebuildsDir = path.join(path.dirname(packageJsonPath), 'prebuilds');
    const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const helperPath = path.join(prebuildsDir, entry.name, 'spawn-helper');
      if (fs.existsSync(helperPath)) {
        fs.chmodSync(helperPath, 0o755);
      }
    }
  } catch {
    // Ignore best-effort permission fixes; spawnPty will surface real launch errors.
  }
}

ensureNodePtyHelpersExecutable();

export type OnAgentOutput = (agentName: string, groupId: string, taskSessionId: string | undefined, content: string, existingId?: string) => string;
export type OnAgentOutputComplete = (agentName: string, groupId: string, taskSessionId: string | undefined, content: string) => void;
export type OnConversationEntries = (
  agentName: string,
  groupId: string,
  taskSessionId: string | undefined,
  entries: ConversationEntry[],
  existingId?: string,
  status?: 'streaming' | 'complete',
) => string;
export type OnProcessChange = () => void;
export type OnPtyOutput = (agentId: string, groupId: string, data: string) => void;
export type OnPtyExit = (agentId: string, groupId: string, exitCode: number | null) => void;
export type OnWorkspaceTerminalOutput = (terminalId: string, data: string) => void;
export type OnWorkspaceTerminalExit = (terminalId: string, exitCode: number | null) => void;

export class ProcessManager {
  processes: ManagedProcess[] = [];
  outputs = new Map<string, string>();
  private agentProcessMap = new Map<string, string>();
  private ptyProcesses = new Map<string, IPty>();
  private outputBuffers = new Map<string, string[]>();
  private recentAgentFailures = new Map<string, AgentFailureInfo>();
  private exitedAgentBuffers = new Map<string, { procId: string; exitCode: number | null }>();
  private workspaceTerminalSessions = new Map<string, WorkspaceTerminalSession>();
  private workspaceTerminalProcMap = new Map<string, string>();
  private modelPickerSessions = new Map<string, ModelPickerSession>();
  private codexTerminalActivities = new Map<string, CodexTerminalActivityTracker>();
  private agentStartupPrompts = new Map<string, AgentStartupPrompt>();
  private resolvedStartupPromptKindsByProcId = new Map<string, Set<AgentStartupPromptKind>>();
  private static readonly MAX_BUFFER_CHUNKS = 2000;
  private pendingResponses = new Map<string, PendingResponse>();
  /** Response handles remain targetable after display completion until the native turn ends. */
  private interruptibleResponses = new Map<string, PendingResponse>();
  private conversationStates = new Map<string, ConversationState>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private isRefreshing = false;
  private logDir: string;
  private cachedShellEnv: Record<string, string> | null = null;

  onAgentOutput?: OnAgentOutput;
  onAgentOutputComplete?: OnAgentOutputComplete;
  onConversationEntries?: OnConversationEntries;
  onProcessChange?: OnProcessChange;
  onPtyOutput?: OnPtyOutput;
  onPtyExit?: OnPtyExit;
  onWorkspaceTerminalOutput?: OnWorkspaceTerminalOutput;
  onWorkspaceTerminalExit?: OnWorkspaceTerminalExit;

  constructor() {
    this.logDir = path.join(os.homedir(), '.cli-bridge', 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.loadUserShellEnv();
    this.startRefreshTimer();
  }

  private agentKey(groupId: string, agentId: string): string {
    return `${groupId}\0${agentId}`;
  }

  private parseAgentKey(key: string): { groupId: string; agentId: string } {
    const idx = key.indexOf('\0');
    return { groupId: key.slice(0, idx), agentId: key.slice(idx + 1) };
  }

  private loadUserShellEnv() {
    const shell = process.env.SHELL || '/bin/zsh';
    const commands = [
      `${shell} -ilc 'env'`,
      `/bin/zsh -lc 'source ~/.zshrc 2>/dev/null; env'`,
      `/bin/zsh -lc env`,
    ];

    for (const cmd of commands) {
      try {
        const result = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
          input: '',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const env: Record<string, string> = {};
        for (const line of result.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            env[line.slice(0, idx)] = line.slice(idx + 1);
          }
        }
        if (Object.keys(env).length > 5) {
          this.cachedShellEnv = env;
          console.log(`[process-manager] loaded ${Object.keys(env).length} user shell env vars`);
          return;
        }
      } catch { /* try next command */ }
    }

    console.log('[process-manager] could not load user shell env, using process.env only');
    this.cachedShellEnv = null;
  }

  private appendToBuffer(procId: string, content: string) {
    const buf = this.outputBuffers.get(procId);
    if (!buf) return;
    buf.push(content);
    if (buf.length > ProcessManager.MAX_BUFFER_CHUNKS) {
      buf.splice(0, buf.length - ProcessManager.MAX_BUFFER_CHUNKS);
    }
  }

  private appendToLog(logFilePath: string | undefined, content: string | Buffer) {
    if (!logFilePath) return;
    try { fs.appendFileSync(logFilePath, content); } catch { /* ignore */ }
  }

  private buildLaunchCommand(command: string, args: string[]): string {
    return [command, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
  }

  private summarizeLog(logFilePath?: string): string | undefined {
    if (!logFilePath) return undefined;
    try {
      const lines = stripAnsi(fs.readFileSync(logFilePath, 'utf-8'))
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => {
          const trimmed = line.trim();
          return trimmed.length > 0
            && !trimmed.startsWith('{"type":"ready"')
            && !trimmed.startsWith('{"type":"exit"');
        });
      if (lines.length === 0) return undefined;
      return lines.slice(-8).join('\n');
    } catch {
      return undefined;
    }
  }

  private rememberAgentFailure(proc: ManagedProcess, exitCode: number | null) {
    if (!proc.agentId || !proc.groupId) return;
    const summary = this.summarizeLog(proc.logFilePath);
    const exitText = exitCode === null ? 'unknown' : String(exitCode);
    const message = summary
      ? `启动失败，启动日志如下：\n${summary}`
      : `启动失败，进程已退出（exit code ${exitText}）`;
    const key = this.agentKey(proc.groupId, proc.agentId);
    this.recentAgentFailures.set(key, {
      agentId: proc.agentId,
      procId: proc.id,
      exitCode,
      message,
      logFilePath: proc.logFilePath,
      failedAt: Date.now(),
    });
  }

  destroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const pending of this.pendingResponses.values()) {
      this.cancelPendingInputDispatch(pending);
    }
    for (const [, state] of this.conversationStates) {
      state.watcher.stop();
    }
    this.conversationStates.clear();
    for (const proc of this.processes) {
      if (proc.isRunning) {
        const child = this.ptyProcesses.get(proc.id);
        if (child) child.kill('SIGTERM');
      }
      if (proc.logFilePath) {
        try { fs.unlinkSync(proc.logFilePath); } catch { /* ignore */ }
      }
    }
    this.ptyProcesses.clear();
    this.interruptibleResponses.clear();
    this.outputBuffers.clear();
    this.exitedAgentBuffers.clear();
    this.workspaceTerminalSessions.clear();
    this.workspaceTerminalProcMap.clear();
    this.modelPickerSessions.clear();
    this.agentStartupPrompts.clear();
    this.resolvedStartupPromptKindsByProcId.clear();
    for (const tracker of this.codexTerminalActivities.values()) tracker.dispose();
    this.codexTerminalActivities.clear();
  }

  // MARK: - Agent launch/kill

  launchAgent(
    agent: { id: string; name: string; command: string; platform?: unknown },
    port: number,
    workingDirectory?: string,
    groupId?: string,
  ): string | undefined {
    if (groupId) {
      if (this.isAgentRunning(agent.id, groupId)) return undefined;
    } else {
      if (this.isAgentRunningAnywhere(agent.id)) return undefined;
    }

    const compositeKey = groupId ? this.agentKey(groupId, agent.id) : agent.id;
    const oldExitInfo = this.exitedAgentBuffers.get(compositeKey);
    if (oldExitInfo) {
      this.outputBuffers.delete(oldExitInfo.procId);
      this.exitedAgentBuffers.delete(compositeKey);
    }

    const safeName = agent.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const sessionName = `cb-${safeName}-${Math.random().toString(36).slice(2, 6)}`;

    const logFilePath = path.join(this.logDir, `${sessionName}.log`);
    fs.writeFileSync(logFilePath, '');

    const cwd = workingDirectory || process.cwd();
    const basePathValues = [this.cachedShellEnv?.PATH, process.env.PATH];
    const mergedEnv: Record<string, string> = {
      ...(this.cachedShellEnv ?? {}),
      ...(process.env as Record<string, string>),
    };
    const launchPath = augmentedPath(basePathValues, mergedEnv);
    const env: Record<string, string> = {
      ...mergedEnv,
      PATH: launchPath,
      CLI_BRIDGE_PORT: String(port),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLORFGBG: '15;0',
      CLICOLOR: '1',
      PTY_COLS: '200',
      PTY_ROWS: '50',
      PTY_CWD: cwd,
    };
    delete env.DYLD_INSERT_LIBRARIES;
    delete env.DYLD_LIBRARY_PATH;
    delete env.DYLD_FRAMEWORK_PATH;

    let child: IPty;
    let handledCursorTrustPrompt = false;
    try {
      const supported = isSupportedAgentPlatform(agent.platform)
        ? getSupportedAgent(agent.platform)
        : null;
      const launchEnv = supported?.env
        ? { ...env, ...supported.env }
        : env;
      const launchCommand = supported
        ? resolveBinary(supported.executable, [launchEnv.PATH], launchEnv)
        : 'sh';
      const launchArgs = supported
        ? [...supported.args]
        : ['-c', agent.command];
      this.recentAgentFailures.delete(compositeKey);
      fs.writeFileSync(
        logFilePath,
        [
          `[launch] agent=${agent.name}`,
          `[launch] cwd=${cwd}`,
          `[launch] command=${this.buildLaunchCommand(launchCommand, launchArgs)}`,
          '',
        ].join('\n'),
      );
      child = spawnPty(launchCommand, launchArgs, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        env: launchEnv,
        cwd,
      });
    } catch {
      return '无法启动 PTY 进程，请检查 node-pty 是否已正确安装';
    }

    const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.outputBuffers.set(id, []);
    const codexTerminalActivity = isCodexProcess({
      name: agent.name,
      command: agent.command,
      platform: typeof agent.platform === 'string' ? agent.platform : undefined,
    })
      ? new CodexTerminalActivityTracker(200, 50, {
        onChange: () => this.handleCodexTerminalActivityChange(id),
      })
      : undefined;

    child.onData((str: string) => {
      this.appendToLog(logFilePath, str);
      this.appendToBuffer(id, str);
      if (codexTerminalActivity) {
        void codexTerminalActivity.write(str).catch(() => { /* terminal activity is best-effort */ });
      }
      if (
        !handledCursorTrustPrompt
        && agent.platform === 'cursor-cli'
        && (str.includes('Workspace Trust Required') || str.includes('[a] Trust this workspace'))
      ) {
        handledCursorTrustPrompt = true;
        this.appendToLog(logFilePath, '\n[launch] auto-confirming Cursor workspace trust prompt\n');
        child.write('a');
      }
      this.captureAgentStartupPrompt(agent, groupId, cwd, id);
      if (agent.id && groupId) this.captureModelPickerOutput(agent.id, groupId, str);
      if (agent.id) this.onPtyOutput?.(agent.id, groupId ?? '', str);
    });
    child.onExit(({ exitCode }) => this.handleProcessExit(id, exitCode));

    const proc: ManagedProcess = {
      id, agentId: agent.id, groupId,
      name: agent.name, command: agent.command, sessionName,
      ...(typeof agent.platform === 'string' ? { platform: agent.platform } : {}),
      launchedAt: Date.now(), isRunning: true,
      logFilePath,
    };
    this.agentProcessMap.set(compositeKey, proc.id);
    this.ptyProcesses.set(proc.id, child);
    if (codexTerminalActivity) this.codexTerminalActivities.set(proc.id, codexTerminalActivity);
    this.processes.push(proc);

    this.attachConversationWatcher(proc, workingDirectory);

    this.onProcessChange?.();
    return undefined;
  }

  async waitForAgentStartup(agentId: string, timeoutMs = 1_500, groupId?: string): Promise<string | undefined> {
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (!procId) {
      return this.recentAgentFailures.get(key)?.message ?? '启动失败，未创建进程';
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const proc = this.processes.find(p => p.id === procId);
      if (!proc || !proc.isRunning) break;
      await new Promise(resolve => setTimeout(resolve, STARTUP_WAIT_INTERVAL_MS));
    }

    const proc = this.processes.find(p => p.id === procId);
    if (proc?.isRunning) return undefined;

    const failure = this.recentAgentFailures.get(key);
    if (failure && failure.procId === procId) {
      return failure.message;
    }
    return '启动失败，进程在启动后立即退出';
  }

  async waitForPtyReady(agentId: string, opts?: { waitForStable?: boolean, timeoutMs?: number, groupId?: string }): Promise<boolean> {
    const { waitForStable = false, timeoutMs = 30_000, groupId } = opts ?? {};
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (!procId) return false;
    const proc = this.processes.find(p => p.id === procId);
    if (!proc?.isRunning || !proc.logFilePath) return false;

    const PTY_READY_THRESHOLD = 500;
    const POLL_MS = 200;
    const STABLE_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    let thresholdReached = false;
    let lastSize = 0;
    let stableSince = 0;

    while (Date.now() < deadline) {
      if (!proc.isRunning) return false;
      if (groupId && this.hasAgentStartupPrompt(agentId, groupId)) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        continue;
      }
      const codexActivity = this.codexTerminalActivities.get(procId)?.snapshot();
      if (codexActivity?.busy) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (codexActivity?.ready) return true;
      const size = getFileSize(proc.logFilePath);

      if (!thresholdReached) {
        if (size >= PTY_READY_THRESHOLD) {
          if (!waitForStable) return true;
          thresholdReached = true;
          lastSize = size;
          stableSince = Date.now();
        }
      } else {
        if (size !== lastSize) {
          lastSize = size;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= STABLE_MS) {
          return true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return thresholdReached
      && !this.codexTerminalActivities.get(procId)?.snapshot().busy
      && !(groupId && this.hasAgentStartupPrompt(agentId, groupId));
  }

  private handleProcessExit(procId: string, exitCode: number | null = null) {
    const proc = this.processes.find(p => p.id === procId);
    if (!proc || !proc.isRunning) return;

    proc.isRunning = false;
    this.ptyProcesses.delete(procId);
    this.codexTerminalActivities.get(procId)?.dispose();
    this.codexTerminalActivities.delete(procId);
    if (proc.agentId) {
      const buf = this.outputBuffers.get(procId);
      if (buf) {
        buf.push(`\r\n\x1b[?1049l\x1b[?25h\r\n\x1b[90m[进程已退出，退出码: ${exitCode ?? 'unknown'}]\x1b[0m\r\n`);
      }

      const compositeKey = proc.groupId
        ? this.agentKey(proc.groupId, proc.agentId)
        : proc.agentId;
      this.exitedAgentBuffers.set(compositeKey, { procId, exitCode });
      this.agentStartupPrompts.delete(compositeKey);
      this.resolvedStartupPromptKindsByProcId.delete(procId);

      if (Date.now() - proc.launchedAt <= STARTUP_FAILURE_WINDOW_MS) {
        this.rememberAgentFailure(proc, exitCode);
      }
      this.onPtyExit?.(proc.agentId, proc.groupId ?? '', exitCode);
      this.agentProcessMap.delete(compositeKey);
    } else {
      const terminalId = this.workspaceTerminalProcMap.get(procId);
      if (terminalId) {
        this.onWorkspaceTerminalExit?.(terminalId, null);
        this.workspaceTerminalProcMap.delete(procId);
        this.workspaceTerminalSessions.delete(terminalId);
      }
      this.outputBuffers.delete(procId);
    }
    const pending = this.pendingResponses.get(procId);
    if (pending) this.cancelPendingInputDispatch(pending);
    this.pendingResponses.delete(procId);
    this.interruptibleResponses.delete(procId);
    this.outputs.delete(procId);
    const convState = this.conversationStates.get(procId);
    if (convState) {
      convState.watcher.stop();
      this.conversationStates.delete(procId);
    }
    this.onProcessChange?.();
  }

  private isProcessRunning(procId: string): boolean {
    const proc = this.processes.find(p => p.id === procId);
    return proc?.isRunning ?? false;
  }

  private attachConversationWatcher(proc: ManagedProcess, workingDirectory?: string) {
    const profileId = detectProfileId(proc.command);
    if (!profileId) {
      console.log(`[conversation] no profile detected for command: ${proc.command}`);
      return;
    }

    const cwd = workingDirectory || process.cwd();
    const watcher = new ConversationWatcher(profileId, cwd);
    const state: ConversationState = {
      watcher,
      allEntries: [],
      groupId: '',
      taskSessionId: undefined,
    };

    const handleEntries = (entries: ConversationEntry[]) => {
      this.upsertConversationEntries(state, entries);
      const hasUserBoundary = entries.some(entry => entry.role === 'user');
      let boundaryEntry: ConversationEntry | undefined;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.role === 'user' && entry.turnId) {
          boundaryEntry = entry;
          break;
        }
      }
      const boundaryTurnId = boundaryEntry?.turnId;
      const pending = this.pendingResponses.get(proc.id);
      let interruptedBoundary = false;
      if (boundaryEntry && boundaryTurnId) {
        if (state.interruptedTranscriptTurnIds?.has(boundaryTurnId)) {
          interruptedBoundary = true;
        } else if (state.awaitingTurnBoundaryAfterInterrupt) {
          const unresolvedPrompts = state.unresolvedInterruptedPrompts ?? [];
          const oldPromptIndex = unresolvedPrompts.findIndex(prompt => (
            this.transcriptPromptMatches(boundaryEntry.content, prompt)
          ));
          const pendingInputSubmitted = pending?.inputDispatch
            ? pending.inputDispatch.submitted
            : true;
          if (!pendingInputSubmitted) {
            // A transcript boundary observed before the new Enter key cannot
            // belong to the new response, even when both prompts are equal.
            this.rememberInterruptedTranscriptTurn(state, boundaryTurnId);
            if (oldPromptIndex >= 0) {
              unresolvedPrompts.splice(oldPromptIndex, 1);
            }
            interruptedBoundary = true;
          } else {
            const isCurrentPrompt = !!pending?.sentText
              && this.transcriptPromptMatches(boundaryEntry.content, pending.sentText);
            if (isCurrentPrompt) {
              unresolvedPrompts.length = 0;
              state.pendingTranscriptTurnId = undefined;
            } else if (oldPromptIndex >= 0) {
              this.rememberInterruptedTranscriptTurn(state, boundaryTurnId);
              unresolvedPrompts.splice(oldPromptIndex, 1);
              interruptedBoundary = true;
            }
          }
          if (pending && unresolvedPrompts.length === 0) {
            this.releaseDeferredPendingInput(proc, pending, state, false);
          }
        }
      }
      if (interruptedBoundary) return;
      if (!pending && boundaryTurnId) {
        this.retireInterruptibleResponseBeforeTurn(proc.id, boundaryTurnId);
      }
      if (hasUserBoundary) {
        state.lastEnvelopeId = undefined;
      }

      if (pending) {
        if (!state.awaitingTurnBoundaryAfterInterrupt && boundaryTurnId) {
          const identity = this.responseIdentity(pending);
          identity.transcriptTurnId ??= boundaryTurnId;
          state.activeTranscriptTurnId = boundaryTurnId;
        }
        if (state.awaitingTurnBoundaryAfterInterrupt) {
          if (!hasUserBoundary || !boundaryTurnId) return;
          if (state.interruptedTranscriptTurnIds?.has(boundaryTurnId)) return;
          const unresolvedPrompts = state.unresolvedInterruptedPrompts ?? [];
          if (unresolvedPrompts.length > 0) {
            // Unknown transcript formats stay conservative until a prompt can
            // be correlated instead of assigning an arbitrary turn.
            return;
          }
          let lastUserIndex = -1;
          for (let index = state.allEntries.length - 1; index >= 0; index--) {
            if (state.allEntries[index].role === 'user') {
              lastUserIndex = index;
              break;
            }
          }
          const identity = this.responseIdentity(pending);
          identity.transcriptTurnId = boundaryTurnId;
          state.activeTranscriptTurnId = boundaryTurnId;
          pending.entryStartIndex = lastUserIndex + 1;
          state.awaitingTurnBoundaryAfterInterrupt = false;
          state.suppressUnclaimedUntil = undefined;
        }
        const responseEntries = this.responseEntriesForPending(state, pending);
        if (responseEntries.length > 0) {
          pending.hasStructuredEntries = true;
          pending.lastStructuredAt = Date.now();
          pending.rawCompletedAt = undefined;
          const identity = this.responseIdentity(pending);
          identity.envelopeId = this.onConversationEntries?.(
            proc.name, pending.groupId, pending.taskSessionId, responseEntries, identity.envelopeId,
          );
          if (responseEntries.some(entry => entry.source === 'codex_jsonl_task_complete')) {
            this.completePendingFromEntries(proc, pending, state);
            this.retireInterruptibleResponse(proc.id, pending);
          }
        }
      } else {
        this.emitUnclaimedConversationEntries(proc, state, entries);
      }
    };

    watcher.on('entries', (entries: ConversationEntry[]) => {
      for (const turnEntries of this.splitConversationEntriesByTurn(entries)) {
        handleEntries(turnEntries);
      }
    });

    watcher.on('turn-started', (turnId: string) => {
      state.activeTranscriptTurnId = turnId;
      if (state.interruptedTranscriptTurnIds?.has(turnId)) return;
      const pending = this.pendingResponses.get(proc.id);
      if ((state.unresolvedInterruptedPrompts?.length ?? 0) > 0) {
        state.pendingTranscriptTurnId = turnId;
        return;
      }
      if (!pending) {
        this.retireInterruptibleResponseBeforeTurn(proc.id, turnId);
        return;
      }
      if (
        state.awaitingTurnBoundaryAfterInterrupt
        && pending.inputDispatch
        && !pending.inputDispatch.submitted
      ) {
        this.rememberInterruptedTranscriptTurn(state, turnId);
        return;
      }
      const identity = this.responseIdentity(pending);
      if (identity.transcriptTurnId && identity.transcriptTurnId !== turnId) return;
      identity.transcriptTurnId ??= turnId;
      if (state.awaitingTurnBoundaryAfterInterrupt) {
        pending.entryStartIndex = state.allEntries.length;
        state.awaitingTurnBoundaryAfterInterrupt = false;
        state.suppressUnclaimedUntil = undefined;
      }
    });

    watcher.on('turn-completed', (turnId: string) => {
      let resolvedInterruptedBoundary = false;
      if (
        state.pendingTranscriptTurnId === turnId
        && (state.unresolvedInterruptedPrompts?.length ?? 0) > 0
      ) {
        this.rememberInterruptedTranscriptTurn(state, turnId);
        state.unresolvedInterruptedPrompts!.shift();
        state.pendingTranscriptTurnId = undefined;
        resolvedInterruptedBoundary = true;
      }
      if (state.activeTranscriptTurnId === turnId) {
        state.activeTranscriptTurnId = undefined;
      }
      this.retireInterruptibleResponseForTurn(proc.id, turnId);
      const pending = this.pendingResponses.get(proc.id);
      if (resolvedInterruptedBoundary && pending) {
        this.releaseDeferredPendingInput(proc, pending, state, false);
      }
    });

    watcher.on('reset', (event?: ConversationWatcherResetEvent) => {
      state.allEntries = [];
      const pending = this.pendingResponses.get(proc.id);
      if (pending) {
        pending.entryStartIndex = 0;
        pending.minEntryTimestampMs = Date.now() - 1000;
        pending.hasStructuredEntries = false;
        if (event?.reason === 'session_switch') {
          this.responseIdentity(pending).envelopeId = undefined;
        }
      }
      if (!pending || event?.reason === 'session_switch') {
        state.lastEnvelopeId = undefined;
      }
      if (event?.reason === 'session_switch') {
        state.activeTranscriptTurnId = undefined;
        state.interruptedTranscriptTurnIds?.clear();
        state.unresolvedInterruptedPrompts = [];
        state.pendingTranscriptTurnId = undefined;
        state.awaitingTurnBoundaryAfterInterrupt = false;
        if (!pending) this.interruptibleResponses.delete(proc.id);
        if (pending) this.releaseDeferredPendingInput(proc, pending, state, false);
      }
    });

    this.conversationStates.set(proc.id, state);
  }

  private splitConversationEntriesByTurn(entries: ConversationEntry[]): ConversationEntry[][] {
    const groups: ConversationEntry[][] = [];
    let current: ConversationEntry[] = [];
    let currentTurnId: string | undefined;

    const flush = () => {
      if (current.length > 0) groups.push(current);
      current = [];
      currentTurnId = undefined;
    };

    for (const entry of entries) {
      const changesNativeTurn = !!entry.turnId
        && !!currentTurnId
        && entry.turnId !== currentTurnId;
      const startsNewUserBoundary = entry.role === 'user'
        && current.length > 0
        && (!entry.turnId || entry.turnId !== currentTurnId);
      if (changesNativeTurn || startsNewUserBoundary) flush();

      current.push(entry);
      currentTurnId ??= entry.turnId;
    }
    flush();
    return groups;
  }

  private hasConversationWatcher(procId: string): boolean {
    return this.conversationStates.has(procId);
  }

  private upsertConversationEntries(state: ConversationState, entries: ConversationEntry[]) {
    if (entries.some(entry => entry.role === 'assistant' && !isStreamingConversationEntry(entry))) {
      state.allEntries = state.allEntries.filter(entry => (
        entry.role !== 'assistant' || !isStreamingConversationEntry(entry)
      ));
    }

    for (const entry of entries) {
      const key = conversationEntryKey(entry);
      const index = state.allEntries.findIndex(existing => conversationEntryKey(existing) === key);
      if (index >= 0) {
        const previous = state.allEntries[index];
        const previousHumanInput = previous.humanInput;
        const incomingHumanInput = entry.humanInput;
        state.allEntries[index] = {
          ...previous,
          ...entry,
          humanInput: incomingHumanInput
            ? {
                ...previousHumanInput,
                ...incomingHumanInput,
                questions: incomingHumanInput.questions.length > 0
                  ? incomingHumanInput.questions
                  : previousHumanInput?.questions ?? [],
              }
            : previousHumanInput,
        };
      } else {
        state.allEntries.push(entry);
      }
    }
  }

  private responseEntriesForPending(state: ConversationState, pending: PendingResponse): ConversationEntry[] {
    if (state.awaitingTurnBoundaryAfterInterrupt) return [];
    const minEntryTimestampMs = pending.minEntryTimestampMs;
    const interruptedTurnIds = state.interruptedTranscriptTurnIds;
    const candidates = state.allEntries
      .slice(pending.entryStartIndex)
      .filter(entry => (
        entry.role !== 'user'
        && (minEntryTimestampMs === undefined || entry.timestamp * 1000 >= minEntryTimestampMs)
        && (!entry.turnId || !interruptedTurnIds?.has(entry.turnId))
      ));
    const identity = this.responseIdentity(pending);
    if (!identity.transcriptTurnId) {
      identity.transcriptTurnId = candidates.find(entry => entry.turnId)?.turnId;
    }
    return identity.transcriptTurnId
      ? candidates.filter(entry => !entry.turnId || entry.turnId === identity.transcriptTurnId)
      : candidates;
  }

  private responseIdentity(pending: PendingResponse): PendingResponseIdentity {
    // Keep hand-built test fixtures and restored runtime state forward compatible.
    return pending.identity ??= {};
  }

  private retireInterruptibleResponse(procId: string, expected?: PendingResponse) {
    const active = this.interruptibleResponses.get(procId);
    if (!active || (expected && active !== expected)) return;
    this.interruptibleResponses.delete(procId);
  }

  private retireInterruptibleResponseForTurn(procId: string, turnId: string) {
    const active = this.interruptibleResponses.get(procId);
    if (!active) return;
    if (this.responseIdentity(active).transcriptTurnId !== turnId) return;
    this.interruptibleResponses.delete(procId);
  }

  private retireInterruptibleResponseBeforeTurn(procId: string, turnId: string) {
    const active = this.interruptibleResponses.get(procId);
    if (!active) return;
    const activeTurnId = this.responseIdentity(active).transcriptTurnId;
    if (!activeTurnId || activeTurnId === turnId) return;
    this.interruptibleResponses.delete(procId);
  }

  private rememberInterruptedTranscriptTurn(state: ConversationState, turnId: string) {
    const interruptedTurnIds = state.interruptedTranscriptTurnIds ??= new Set<string>();
    interruptedTurnIds.add(turnId);
    if (state.activeTranscriptTurnId === turnId) {
      state.activeTranscriptTurnId = undefined;
    }
    if (state.pendingTranscriptTurnId === turnId) {
      state.pendingTranscriptTurnId = undefined;
    }
  }

  private transcriptPromptMatches(transcriptText: string, sentText: string): boolean {
    const normalize = (value: string) => value.replace(/\r\n/g, '\n').trim();
    return normalize(transcriptText) === normalize(sentText);
  }

  private emitUnclaimedConversationEntries(
    proc: ManagedProcess,
    state: ConversationState,
    entries: ConversationEntry[],
  ) {
    const eligibleEntries = entries.filter(entry => (
      !entry.turnId || !state.interruptedTranscriptTurnIds?.has(entry.turnId)
    ));
    if (eligibleEntries.length === 0) return;
    if (state.suppressUnclaimedUntil !== undefined) {
      const nextUserTurnStarted = eligibleEntries.some(entry => entry.role === 'user');
      if (!nextUserTurnStarted && Date.now() < state.suppressUnclaimedUntil) return;
      state.suppressUnclaimedUntil = undefined;
    }
    if (!state.groupId) return;
    if (eligibleEntries.some(entry => entry.role === 'user')) {
      state.lastEnvelopeId = undefined;
    }

    const agentEntries = eligibleEntries.filter(entry => entry.role !== 'user');
    if (agentEntries.length === 0) return;

    const status = agentEntries.some(entry => entry.role === 'assistant') ? 'complete' : 'streaming';
    state.lastEnvelopeId = this.onConversationEntries?.(
      proc.name,
      state.groupId,
      state.taskSessionId,
      agentEntries,
      state.lastEnvelopeId,
      status,
    );
  }

  private assistantTextFromEntries(entries: ConversationEntry[]): string {
    const assistantEntries = entries.filter(e => e.role === 'assistant');
    const finalAnswerEntries = assistantEntries.filter(e => e.phase === 'final_answer');
    return (finalAnswerEntries.length > 0 ? finalAnswerEntries : assistantEntries)
      .map(e => e.content)
      .join('\n');
  }

  private isWatcherActive(procId: string): boolean {
    const state = this.conversationStates.get(procId);
    return state?.watcher.isActive ?? false;
  }

  isAgentRunning(agentId: string, groupId?: string): boolean {
    if (groupId) {
      const key = this.agentKey(groupId, agentId);
      const procId = this.agentProcessMap.get(key);
      if (!procId) return false;
      const proc = this.processes.find(p => p.id === procId);
      return proc?.isRunning ?? false;
    }
    return this.isAgentRunningAnywhere(agentId);
  }

  private isAgentRunningAnywhere(agentId: string): boolean {
    for (const [key, procId] of this.agentProcessMap) {
      const { agentId: aid } = this.parseAgentKey(key);
      if (aid === agentId) {
        const proc = this.processes.find(p => p.id === procId);
        if (proc?.isRunning) return true;
      }
    }
    return false;
  }

  getRecentAgentErrors(): Record<string, string> {
    const flat = this.getRunningAgentIds();
    const running = new Set(flat);
    return Object.fromEntries(
      Array.from(this.recentAgentFailures.entries())
        .filter(([, failure]) => !running.has(failure.agentId) && !!failure.message)
        .map(([, failure]) => [failure.agentId, failure.message]),
    );
  }

  getRecentAgentErrorsByGroup(): Record<string, Record<string, string>> {
    const runningByGroup = this.getRunningAgentIdsByGroup();
    const result: Record<string, Record<string, string>> = {};
    for (const [key, failure] of this.recentAgentFailures) {
      const { groupId, agentId } = this.parseAgentKey(key);
      const groupRunning = runningByGroup[groupId] ?? [];
      if (groupRunning.includes(agentId) || !failure.message) continue;
      if (!result[groupId]) result[groupId] = {};
      result[groupId][agentId] = failure.message;
    }
    return result;
  }

  killAgent(agentId: string, groupId?: string) {
    if (groupId) {
      const key = this.agentKey(groupId, agentId);
      const procId = this.agentProcessMap.get(key);
      if (!procId) return;
      const proc = this.processes.find(p => p.id === procId);
      if (proc) this.kill(proc);
      this.agentProcessMap.delete(key);
    } else {
      const keysToDelete: string[] = [];
      for (const [key, procId] of this.agentProcessMap) {
        const { agentId: aid } = this.parseAgentKey(key);
        if (aid === agentId) {
          const proc = this.processes.find(p => p.id === procId);
          if (proc) this.kill(proc);
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) this.agentProcessMap.delete(key);
    }
  }

  private writeTextWithEnter(proc: ManagedProcess, text: string, pending?: PendingResponse) {
    const child = this.ptyProcesses.get(proc.id);
    if (!child) return;

    const dispatch: PendingInputDispatch = pending?.inputDispatch ?? {
      started: false,
      payloadWritten: false,
      submitted: false,
    };
    if (dispatch.started) return;
    if (dispatch.deferredTimer) clearTimeout(dispatch.deferredTimer);
    dispatch.deferredTimer = undefined;
    dispatch.started = true;
    if (pending) {
      pending.inputDispatch = dispatch;
      const snapshotOffset = proc.logFilePath ? getFileSize(proc.logFilePath) : 0;
      pending.snapshotOffset = snapshotOffset;
      pending.lastFileSize = snapshotOffset;
      pending.stableCount = 0;
      pending.createdAt = Date.now();
      const state = this.conversationStates.get(proc.id);
      if (state) pending.entryStartIndex = state.allEntries.length;
    }

    // Codex CLI: 150ms delay bypasses 120ms paste-burst Enter suppression.
    // Other agents (Copilot v1.0.12+, Gemini, etc.): the TUI must finish
    // rendering the text before Enter is recognised as "submit"; 500ms
    // gives the React/Ink event loop enough time to flush.
    const isCodex = isCodexProcess(proc);
    const isGemini = usesGeminiInputMode(proc);
    const enterDelay = isCodex ? 150 : 500;
    const payload = text.includes('\n') && usesBracketedPasteForMultilineInput(proc)
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    const writePayload = () => {
      dispatch.payloadTimer = undefined;
      if (
        this.ptyProcesses.get(proc.id) !== child
        || (pending && this.pendingResponses.get(proc.id) !== pending)
      ) return;
      dispatch.payloadWritten = true;
      child.write(payload);
      dispatch.enterTimer = setTimeout(() => {
        dispatch.enterTimer = undefined;
        if (
          this.ptyProcesses.get(proc.id) !== child
          || (pending && this.pendingResponses.get(proc.id) !== pending)
        ) return;
        dispatch.submitted = true;
        child.write('\r');
      }, enterDelay);
    };

    // Gemini CLI v0.35.2 started echoing the synthetic focus event as
    // literal `1;2c` input, which prevents the real prompt text from
    // reaching the editor. Send plain text for Gemini and keep the focus
    // nudge for the other TUIs that still benefit from it.
    if (isGemini) {
      writePayload();
    } else {
      child.write('\x1b[I');
      dispatch.payloadTimer = setTimeout(writePayload, 50);
    }
  }

  private cancelPendingInputDispatch(pending: PendingResponse): {
    payloadWritten: boolean;
    submitted: boolean;
  } {
    const dispatch = pending.inputDispatch;
    if (!dispatch) return { payloadWritten: false, submitted: false };
    if (dispatch.deferredTimer) clearTimeout(dispatch.deferredTimer);
    if (dispatch.payloadTimer) clearTimeout(dispatch.payloadTimer);
    if (dispatch.enterTimer) clearTimeout(dispatch.enterTimer);
    dispatch.deferredTimer = undefined;
    dispatch.payloadTimer = undefined;
    dispatch.enterTimer = undefined;
    return { payloadWritten: dispatch.payloadWritten, submitted: dispatch.submitted };
  }

  private releaseDeferredPendingInput(
    proc: ManagedProcess,
    pending: PendingResponse,
    state: ConversationState | undefined,
    boundaryWaitExpired: boolean,
  ) {
    if (this.pendingResponses.get(proc.id) !== pending) return;
    const dispatch = pending.inputDispatch;
    if (!dispatch || dispatch.started) return;

    if (boundaryWaitExpired && state) {
      if (state.pendingTranscriptTurnId) {
        this.rememberInterruptedTranscriptTurn(state, state.pendingTranscriptTurnId);
        state.unresolvedInterruptedPrompts?.shift();
      }
      // With no observed boundary, keep the interrupted prompt as a tentative
      // identity. The next turn is classified by its user entry rather than
      // being claimed by a late turn-started event alone.
      state.pendingTranscriptTurnId = undefined;
    } else if ((state?.unresolvedInterruptedPrompts?.length ?? 0) > 0) {
      return;
    }

    const codexActivity = this.codexTerminalActivities.get(proc.id)?.snapshot();
    if (codexActivity && !codexActivity.ready) return;
    this.writeTextWithEnter(proc, pending.sentText ?? '', pending);
  }

  private handleCodexTerminalActivityChange(procId: string) {
    const tracker = this.codexTerminalActivities.get(procId);
    if (tracker?.snapshot().ready) {
      const proc = this.processes.find(candidate => candidate.id === procId && candidate.isRunning);
      const pending = this.pendingResponses.get(procId);
      if (proc && pending) {
        this.releaseDeferredPendingInput(
          proc,
          pending,
          this.conversationStates.get(procId),
          false,
        );
      }
    }
    this.onProcessChange?.();
  }

  sendKeys(
    agentId: string,
    text: string,
    groupId: string,
    taskSessionId?: string,
    responseId?: string,
  ) {
    const key = this.agentKey(groupId, agentId);
    const procId = this.agentProcessMap.get(key);
    if (!procId) return;
    const proc = this.processes.find(p => p.id === procId);
    if (!proc?.isRunning) return;

    // A newly dispatched response supersedes any retained interrupt handle,
    // so a delayed stop request can never target work submitted afterwards.
    this.interruptibleResponses.delete(proc.id);
    const previousPending = this.pendingResponses.get(proc.id);
    if (previousPending) {
      this.cancelPendingInputDispatch(previousPending);
      const previousState = this.conversationStates.get(proc.id);
      if (previousState) {
        if (!this.completePendingFromEntries(proc, previousPending, previousState, false)) {
          this.completePendingResponse(proc, previousPending, '', false);
        }
      } else {
        this.completePendingResponse(proc, previousPending, '', false);
      }
      this.pendingResponses.delete(proc.id);
    }

    const snapshotOffset = proc.logFilePath ? getFileSize(proc.logFilePath) : 0;
    const convState = this.conversationStates.get(proc.id);
    const entryStartIndex = convState ? convState.allEntries.length : 0;

    if (convState) {
      convState.groupId = groupId;
      convState.taskSessionId = taskSessionId;
      convState.watcher.noteExpectedCodexPrompt?.(text);
    }

    const pending: PendingResponse = {
      identity: { responseId },
      groupId, taskSessionId, snapshotOffset, lastFileSize: snapshotOffset,
      stableCount: 0, entryStartIndex, sentText: text,
      createdAt: Date.now(),
      inputDispatch: {
        started: false,
        payloadWritten: false,
        submitted: false,
      },
    };
    this.pendingResponses.set(proc.id, pending);
    this.interruptibleResponses.set(proc.id, pending);
    this.onProcessChange?.();

    if (convState && (convState.unresolvedInterruptedPrompts?.length ?? 0) > 0) {
      pending.inputDispatch!.deferredTimer = setTimeout(() => {
        this.releaseDeferredPendingInput(proc, pending, convState, true);
      }, INTERRUPT_BOUNDARY_WAIT_MS);
    } else {
      this.releaseDeferredPendingInput(proc, pending, convState, false);
    }
  }

  /**
   * Interrupt the response currently running for one agent without terminating
   * its long-lived CLI process. Task-session and response identity checks keep
   * a delayed mobile request from interrupting a newer conversation turn.
   */
  interruptAgent(
    agentId: string,
    groupId: string,
    taskSessionId: string,
    responseId: string,
  ): boolean {
    const proc = this.runningAgentProcess(agentId, groupId);
    if (!proc) return false;

    const pending = this.pendingResponses.get(proc.id);
    const response = pending ?? this.interruptibleResponses.get(proc.id);
    if (
      !response
      || response.groupId !== groupId
      || response.taskSessionId !== taskSessionId
      || (
        this.responseIdentity(response).envelopeId !== responseId
        && this.responseIdentity(response).responseId !== responseId
      )
    ) return false;

    const child = this.ptyProcesses.get(proc.id);
    if (!child) return false;

    const inputDispatch = this.cancelPendingInputDispatch(response);
    child.write(responseInterruptKey(proc));
    if (inputDispatch.payloadWritten && !inputDispatch.submitted && !usesGeminiInputMode(proc)) {
      child.write('\x15');
    }

    const convState = this.conversationStates.get(proc.id);
    if (convState) {
      const identity = this.responseIdentity(response);
      const responseEntries = this.responseEntriesForPending(convState, response);
      const knownTurnIds = [
        identity.transcriptTurnId,
        convState.activeTranscriptTurnId,
        ...responseEntries.map(entry => entry.turnId),
      ].filter((turnId): turnId is string => !!turnId);
      for (const turnId of knownTurnIds) {
        this.rememberInterruptedTranscriptTurn(convState, turnId);
      }
      if (knownTurnIds.length === 0 && inputDispatch.submitted && response.sentText) {
        const unresolvedPrompts = convState.unresolvedInterruptedPrompts ??= [];
        unresolvedPrompts.push(response.sentText);
      }
      const responseCouldHaveTranscriptTail = knownTurnIds.length > 0
        || inputDispatch.submitted
        || !!identity.envelopeId;
      convState.awaitingTurnBoundaryAfterInterrupt = responseCouldHaveTranscriptTail;
      // Transcript watchers can flush one final cancellation record after the
      // control key. Keep unclaimed tail entries from opening a second bubble;
      // pending responses additionally wait for an explicit next-turn boundary.
      convState.suppressUnclaimedUntil = responseCouldHaveTranscriptTail
        ? Date.now() + INTERRUPT_TAIL_SUPPRESSION_MS
        : undefined;
    }

    if (pending === response) {
      this.completePendingResponse(proc, response, '');
    }
    this.retireInterruptibleResponse(proc.id, response);
    return true;
  }

  private captureAgentStartupPrompt(
    agent: { id: string; name: string; platform?: unknown },
    groupId: string | undefined,
    workingDirectory: string,
    procId: string,
  ) {
    if (!agent.id || !groupId || typeof agent.platform !== 'string') return;
    if (!AGENT_STARTUP_PROMPT_PLATFORMS.has(agent.platform)) return;

    const raw = (this.outputBuffers.get(procId) ?? []).join('').slice(-AGENT_STARTUP_PROMPT_MAX_RAW_CHARS);
    const parsed = parseAgentStartupPromptOutput(raw);
    if (!parsed) return;
    if (this.resolvedStartupPromptKindsByProcId.get(procId)?.has(parsed.kind)) return;

    const key = this.agentKey(groupId, agent.id);
    const now = Date.now();
    const existing = this.agentStartupPrompts.get(key);
    this.agentStartupPrompts.set(key, {
      kind: parsed.kind,
      agentId: agent.id,
      agentName: agent.name,
      groupId,
      directory: parsed.directory || workingDirectory,
      rawPreview: parsed.rawPreview,
      detectedAt: existing?.detectedAt ?? now,
      updatedAt: now,
    });
  }

  private hasAgentStartupPrompt(agentId: string, groupId: string): boolean {
    const key = this.agentKey(groupId, agentId);
    const prompt = this.agentStartupPrompts.get(key);
    if (!prompt) return false;
    const proc = this.runningAgentProcess(agentId, groupId);
    if (!proc || this.resolvedStartupPromptKindsByProcId.get(proc.id)?.has(prompt.kind)) {
      this.agentStartupPrompts.delete(key);
      return false;
    }
    return true;
  }

  getAgentStartupPrompts(groupId?: string): AgentStartupPrompt[] {
    const prompts: AgentStartupPrompt[] = [];
    for (const [key, prompt] of this.agentStartupPrompts) {
      if (groupId && prompt.groupId !== groupId) continue;
      if (!this.hasAgentStartupPrompt(prompt.agentId, prompt.groupId)) {
        this.agentStartupPrompts.delete(key);
        continue;
      }
      prompts.push(prompt);
    }
    return prompts.sort((a, b) => a.detectedAt - b.detectedAt);
  }

  resolveAgentStartupPrompts(
    groupId: string,
    action: AgentStartupPromptAction,
    agentIds?: string[],
  ): { resolved: number; prompts: AgentStartupPrompt[] } {
    const requestedAgentIds = agentIds ? new Set(agentIds) : null;
    let resolved = 0;
    for (const prompt of this.getAgentStartupPrompts(groupId)) {
      if (requestedAgentIds && !requestedAgentIds.has(prompt.agentId)) continue;
      const payload = agentStartupPromptActionPayload(prompt, action);
      this.writeInput(prompt.agentId, payload, groupId);
      resolved++;
    }
    return { resolved, prompts: this.getAgentStartupPrompts(groupId) };
  }

  getWorkspaceTrustPrompts(groupId: string): AgentStartupPrompt[] {
    return this.getAgentStartupPrompts(groupId).filter(prompt => prompt.kind === 'workspace-trust');
  }

  confirmWorkspaceTrustPrompts(groupId: string, agentIds?: string[]): { confirmed: number; prompts: AgentStartupPrompt[] } {
    const requestedAgentIds = agentIds ? new Set(agentIds) : null;
    let confirmed = 0;
    for (const prompt of this.getWorkspaceTrustPrompts(groupId)) {
      if (requestedAgentIds && !requestedAgentIds.has(prompt.agentId)) continue;
      this.writeInput(prompt.agentId, agentStartupPromptActionPayload(prompt, 'accept'), groupId);
      confirmed++;
    }
    return {
      confirmed,
      prompts: this.getWorkspaceTrustPrompts(groupId),
    };
  }

  private runningAgentProcess(agentId: string, groupId: string): ManagedProcess | undefined {
    const procId = this.agentProcessMap.get(this.agentKey(groupId, agentId));
    if (!procId) return undefined;
    const proc = this.processes.find(p => p.id === procId);
    return proc?.isRunning ? proc : undefined;
  }

  private modelPickerKey(agentId: string, groupId: string): string {
    return this.agentKey(groupId, agentId);
  }

  private captureModelPickerOutput(agentId: string, groupId: string, data: string) {
    const key = this.modelPickerKey(agentId, groupId);
    const session = this.modelPickerSessions.get(key);
    if (!session) return;
    const now = Date.now();
    if (session.status === 'chosen' || session.status === 'cancelled' || session.status === 'expired') return;
    if (now - session.startedAt > MODEL_PICKER_SESSION_TTL_MS) {
      session.status = 'expired';
      session.updatedAt = now;
      return;
    }
    session.raw = `${session.raw}${data}`.slice(-MODEL_PICKER_MAX_RAW_CHARS);
    session.updatedAt = now;
    this.maybeAutoOpenCodexEffortPicker(session);
  }

  private maybeAutoOpenCodexEffortPicker(session: ModelPickerSession) {
    if (session.mode !== 'effort' || session.autoOpenedEffort) return;
    const parsed = parseModelPickerTerminalOutput(session.raw);
    if (parsed.kind !== 'codex-model' || parsed.selectedIndex === null) return;
    this.writeInput(session.agentId, '\r', session.groupId);
    const now = Date.now();
    session.raw = '';
    session.startedAt = now;
    session.updatedAt = now;
    session.status = 'starting';
    session.error = undefined;
    session.autoOpenedEffort = true;
  }

  private snapshotModelPickerSession(session: ModelPickerSession): ModelPickerSnapshot {
    const now = Date.now();
    if (
      session.status !== 'chosen'
      && session.status !== 'cancelled'
      && now - session.startedAt > MODEL_PICKER_SESSION_TTL_MS
    ) {
      session.status = 'expired';
      session.updatedAt = now;
    }

    const parsed = parseModelPickerTerminalOutput(session.raw);
    const mode: ModelPickerMode = parsed.kind === 'codex-effort' || parsed.kind === 'claude-effort'
      ? 'effort'
      : session.mode;
    let status = session.status;
    if (status !== 'chosen' && status !== 'cancelled' && status !== 'expired') {
      status = parsed.options.length > 0
        ? 'selecting'
        : (now - session.startedAt >= MODEL_PICKER_FALLBACK_AFTER_MS ? 'fallback' : 'starting');
      session.status = status;
    }

    return {
      agentId: session.agentId,
      groupId: session.groupId,
      mode,
      status,
      options: parsed.options,
      selectedIndex: parsed.selectedIndex,
      rawPreview: parsed.rawPreview,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...(session.error ? { error: session.error } : {}),
    };
  }

  startModelPicker(
    agentId: string,
    groupId: string,
    mode: ModelPickerMode = 'model',
  ): ModelPickerSnapshot | undefined {
    const proc = this.runningAgentProcess(agentId, groupId);
    if (!proc) return undefined;

    const now = Date.now();
    const key = this.modelPickerKey(agentId, groupId);
    const existing = this.modelPickerSessions.get(key);
    const shouldCloseExisting = !!existing
      && existing.status !== 'chosen'
      && existing.status !== 'cancelled'
      && existing.status !== 'expired';
    if (shouldCloseExisting) {
      this.writeInput(agentId, '\x1b', groupId);
    }
    const session: ModelPickerSession = {
      agentId,
      groupId,
      mode,
      raw: '',
      startedAt: now,
      updatedAt: now,
      status: 'starting',
    };
    this.modelPickerSessions.set(key, session);
    const pickerCommand = mode === 'effort' && isClaudeModelPickerProcess(proc) ? '/effort' : '/model';
    const openPicker = () => this.writeTextWithEnter(proc, pickerCommand);
    if (shouldCloseExisting) {
      setTimeout(openPicker, MODEL_PICKER_RESTART_DELAY_MS);
    } else {
      openPicker();
    }
    return this.snapshotModelPickerSession(session);
  }

  getModelPicker(agentId: string, groupId: string): ModelPickerSnapshot | undefined {
    const session = this.modelPickerSessions.get(this.modelPickerKey(agentId, groupId));
    return session ? this.snapshotModelPickerSession(session) : undefined;
  }

  chooseModelPickerOption(agentId: string, groupId: string, optionIndex: number): ModelPickerSnapshot | undefined {
    const session = this.modelPickerSessions.get(this.modelPickerKey(agentId, groupId));
    if (!session) return undefined;
    const snapshot = this.snapshotModelPickerSession(session);
    const parsed = parseModelPickerTerminalOutput(session.raw);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= snapshot.options.length) {
      session.error = 'invalid option index';
      return this.snapshotModelPickerSession(session);
    }
    if (snapshot.selectedIndex === null) {
      session.status = 'fallback';
      session.error = 'selected index unavailable';
      return this.snapshotModelPickerSession(session);
    }

    const delta = optionIndex - snapshot.selectedIndex;
    const direction = parsed.kind === 'claude-effort'
      ? (delta > 0 ? '\x1b[C' : '\x1b[D')
      : (delta > 0 ? '\x1b[B' : '\x1b[A');
    const payload = direction.repeat(Math.abs(delta)) + '\r';
    this.writeInput(agentId, payload, groupId);
    const now = Date.now();
    if (parsed.kind === 'codex-model') {
      session.raw = '';
      session.startedAt = now;
      session.mode = 'effort';
      session.status = 'starting';
      session.updatedAt = now;
      session.error = undefined;
      return this.snapshotModelPickerSession(session);
    }
    session.status = 'chosen';
    session.updatedAt = now;
    session.error = undefined;
    return this.snapshotModelPickerSession(session);
  }

  sendModelPickerInput(agentId: string, groupId: string, action: ModelPickerInputAction): ModelPickerSnapshot | undefined {
    const session = this.modelPickerSessions.get(this.modelPickerKey(agentId, groupId));
    if (!session) return undefined;
    const parsed = parseModelPickerTerminalOutput(session.raw);
    const payloadByAction: Record<ModelPickerInputAction, string> = parsed.kind === 'claude-effort'
      ? {
        up: '\x1b[D',
        down: '\x1b[C',
        enter: '\r',
        escape: '\x1b',
      }
      : {
        up: '\x1b[A',
        down: '\x1b[B',
        enter: '\r',
        escape: '\x1b',
      };
    this.writeInput(agentId, payloadByAction[action], groupId);
    const now = Date.now();
    if (action === 'enter' && parsed.kind === 'codex-model') {
      session.raw = '';
      session.startedAt = now;
      session.mode = 'effort';
      session.status = 'starting';
      session.error = undefined;
    } else {
      if (action === 'enter') session.status = 'chosen';
      if (action === 'escape') session.status = 'cancelled';
    }
    session.updatedAt = now;
    return this.snapshotModelPickerSession(session);
  }

  writeInput(agentId: string, data: string, groupId?: string) {
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (!procId) return;
    const child = this.ptyProcesses.get(procId);
    if (child) {
      this.conversationStates.get(procId)?.watcher.noteCodexTerminalInput?.(data);
      child.write(data);
      if (groupId && this.agentStartupPrompts.has(key) && (data.includes('\r') || data.includes('\n'))) {
        const prompt = this.agentStartupPrompts.get(key);
        this.agentStartupPrompts.delete(key);
        if (prompt) {
          const resolvedKinds = this.resolvedStartupPromptKindsByProcId.get(procId) ?? new Set<AgentStartupPromptKind>();
          resolvedKinds.add(prompt.kind);
          this.resolvedStartupPromptKindsByProcId.set(procId, resolvedKinds);
        }
      }
    }
  }

  resizePty(agentId: string, cols: number, rows: number, groupId?: string) {
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (!procId) return;
    const child = this.ptyProcesses.get(procId);
    if (child) child.resize(cols, rows);
    this.codexTerminalActivities.get(procId)?.resize(cols, rows);
  }

  getOutputBuffer(agentId: string, groupId?: string): string[] {
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (procId) return this.outputBuffers.get(procId) ?? [];

    const exitInfo = this.exitedAgentBuffers.get(key);
    if (exitInfo) return this.outputBuffers.get(exitInfo.procId) ?? [];

    return [];
  }

  hasAgentExited(agentId: string, groupId?: string): { exited: boolean; exitCode: number | null } {
    if (this.isAgentRunning(agentId, groupId)) return { exited: false, exitCode: null };
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const exitInfo = this.exitedAgentBuffers.get(key);
    if (exitInfo) return { exited: true, exitCode: exitInfo.exitCode };
    return { exited: false, exitCode: null };
  }

  ensureWorkspaceTerminal(
    terminalId: string,
    terminalName: string,
    workingDirectory: string,
  ): { terminalId: string; error?: string } {
    const existing = this.workspaceTerminalSessions.get(terminalId);
    if (existing && this.isProcessRunning(existing.procId)) {
      return { terminalId };
    }

    const shellPath = process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/zsh';
    const shellArgs = process.platform === 'win32' ? [] : ['-il'];
    const basePathValues = [this.cachedShellEnv?.PATH, process.env.PATH];
    const mergedEnv: Record<string, string> = {
      ...(this.cachedShellEnv ?? {}),
      ...(process.env as Record<string, string>),
    };
    const env: Record<string, string> = {
      ...mergedEnv,
      PATH: augmentedPath(basePathValues, mergedEnv),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLORFGBG: '15;0',
      CLICOLOR: '1',
      PTY_COLS: '200',
      PTY_ROWS: '50',
      PTY_CWD: workingDirectory,
    };
    delete env.DYLD_INSERT_LIBRARIES;
    delete env.DYLD_LIBRARY_PATH;
    delete env.DYLD_FRAMEWORK_PATH;

    let child: IPty;
    try {
      child = spawnPty(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        env,
        cwd: workingDirectory,
      });
    } catch {
      return { terminalId, error: '无法启动工作空间终端，请检查 node-pty 是否已正确安装' };
    }

    const procId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.outputBuffers.set(procId, []);

    child.onData((str: string) => {
      const buf = this.outputBuffers.get(procId);
      if (buf) {
        buf.push(str);
        if (buf.length > ProcessManager.MAX_BUFFER_CHUNKS) {
          buf.splice(0, buf.length - ProcessManager.MAX_BUFFER_CHUNKS);
        }
      }
      this.onWorkspaceTerminalOutput?.(terminalId, str);
    });
    child.onExit(({ exitCode }) => this.handleProcessExit(procId, exitCode));

    const proc: ManagedProcess = {
      id: procId,
      name: terminalName,
      command: shellPath,
      sessionName: terminalId,
      launchedAt: Date.now(),
      isRunning: true,
    };
    this.ptyProcesses.set(procId, child);
    this.processes.push(proc);
    this.workspaceTerminalProcMap.set(procId, terminalId);
    this.workspaceTerminalSessions.set(terminalId, {
      terminalId,
      terminalName,
      procId,
      workingDirectory,
    });
    this.onProcessChange?.();
    return { terminalId };
  }

  writeWorkspaceTerminalInput(terminalId: string, data: string) {
    const session = this.workspaceTerminalSessions.get(terminalId);
    if (!session) return;
    const child = this.ptyProcesses.get(session.procId);
    if (child) child.write(data);
  }

  resizeWorkspaceTerminal(terminalId: string, cols: number, rows: number) {
    const session = this.workspaceTerminalSessions.get(terminalId);
    if (!session) return;
    const child = this.ptyProcesses.get(session.procId);
    if (child) child.resize(cols, rows);
  }

  getWorkspaceTerminalBuffer(terminalId: string): string[] {
    const session = this.workspaceTerminalSessions.get(terminalId);
    if (!session) return [];
    return this.outputBuffers.get(session.procId) ?? [];
  }

  attachTerminal(agentId: string, groupId?: string) {
    const key = groupId ? this.agentKey(groupId, agentId) : agentId;
    const procId = this.agentProcessMap.get(key);
    if (!procId) return;
    const proc = this.processes.find(p => p.id === procId);
    if (!proc?.logFilePath) return;
    try {
      execSync(
        `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "tail -f \\"${proc.logFilePath}\\""'`,
      );
    } catch { /* ignore */ }
  }

  kill(proc: ManagedProcess) {
    const child = this.ptyProcesses.get(proc.id);
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      this.ptyProcesses.delete(proc.id);
    }
    const idx = this.processes.findIndex(p => p.id === proc.id);
    if (idx >= 0) this.processes[idx].isRunning = false;
    this.outputs.delete(proc.id);
    this.outputBuffers.delete(proc.id);
    if (proc.agentId) {
      const compositeKey = proc.groupId
        ? this.agentKey(proc.groupId, proc.agentId)
        : proc.agentId;
      this.agentProcessMap.delete(compositeKey);
      this.agentStartupPrompts.delete(compositeKey);
      this.resolvedStartupPromptKindsByProcId.delete(proc.id);
    } else {
      const terminalId = this.workspaceTerminalProcMap.get(proc.id);
      if (terminalId) {
        this.workspaceTerminalProcMap.delete(proc.id);
        this.workspaceTerminalSessions.delete(terminalId);
      }
    }
    const pending = this.pendingResponses.get(proc.id);
    if (pending) this.cancelPendingInputDispatch(pending);
    this.pendingResponses.delete(proc.id);
    this.interruptibleResponses.delete(proc.id);

    const convState = this.conversationStates.get(proc.id);
    if (convState) {
      convState.watcher.stop();
      this.conversationStates.delete(proc.id);
    }

    this.onProcessChange?.();
  }

  getRunningAgentIds(): string[] {
    const seen = new Set<string>();
    for (const [key, procId] of this.agentProcessMap) {
      const proc = this.processes.find(p => p.id === procId);
      if (!(proc?.isRunning)) continue;
      const { agentId } = this.parseAgentKey(key);
      seen.add(agentId);
    }
    return [...seen];
  }

  getRunningAgentIdsByGroup(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, procId] of this.agentProcessMap) {
      const proc = this.processes.find(p => p.id === procId);
      if (!(proc?.isRunning)) continue;
      const { groupId, agentId } = this.parseAgentKey(key);
      if (!result[groupId]) result[groupId] = [];
      result[groupId].push(agentId);
    }
    return result;
  }

  getBusyAgentIdsByGroup(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, procId] of this.agentProcessMap) {
      const proc = this.processes.find(candidate => candidate.id === procId);
      if (!proc?.isRunning) continue;
      const terminalBusy = this.codexTerminalActivities.get(procId)?.snapshot().busy ?? false;
      const responseBusy = this.pendingResponses.has(procId);
      if (!terminalBusy && !responseBusy) continue;
      const { groupId, agentId } = this.parseAgentKey(key);
      if (!result[groupId]) result[groupId] = [];
      result[groupId].push(agentId);
    }
    return result;
  }

  hasPendingAgentResponse(agentId: string, groupId: string): boolean {
    const procId = this.agentProcessMap.get(this.agentKey(groupId, agentId));
    return procId ? this.pendingResponses.has(procId) : false;
  }

  private emitRawPendingOutput(proc: ManagedProcess, pending: PendingResponse): boolean {
    const cleaned = this.readCleanPendingOutput(proc, pending);
    if (!cleaned) return false;

    const identity = this.responseIdentity(pending);
    identity.envelopeId = this.onAgentOutput?.(
      proc.name, pending.groupId, pending.taskSessionId, cleaned, identity.envelopeId,
    );
    return !!identity.envelopeId;
  }

  private readCleanPendingOutput(proc: ManagedProcess, pending: PendingResponse): string {
    if (!proc.logFilePath) return '';
    const rawContent = readLogFromOffset(proc.logFilePath, pending.snapshotOffset);
    return this.cleanLogOutput(rawContent, pending.sentText);
  }

  private shouldStreamRawWithActiveWatcher(proc: ManagedProcess): boolean {
    return isCodexProcess(proc);
  }

  private shouldSuppressRawPendingFallback(proc: ManagedProcess, hasWatcher: boolean): boolean {
    return hasWatcher && (isCodexProcess(proc) || isClaudeFamilyProcess(proc));
  }

  private completePendingResponse(
    proc: ManagedProcess,
    pending: PendingResponse,
    content: string,
    removePending = true,
  ) {
    const identity = this.responseIdentity(pending);
    if (proc.agentId && (content || identity.envelopeId)) {
      this.onAgentOutputComplete?.(proc.name, pending.groupId, pending.taskSessionId, content);
      const convState = this.conversationStates.get(proc.id);
      if (convState && identity.envelopeId) {
        convState.lastEnvelopeId = identity.envelopeId;
      }
    }
    const convState = this.conversationStates.get(proc.id);
    if (
      convState
      && identity.transcriptTurnId
      && convState.activeTranscriptTurnId === identity.transcriptTurnId
    ) {
      convState.activeTranscriptTurnId = undefined;
    }
    if (removePending) {
      this.cancelPendingInputDispatch(pending);
      this.pendingResponses.delete(proc.id);
    }
  }

  private completePendingFromEntries(
    proc: ManagedProcess,
    pending: PendingResponse,
    convState: ConversationState,
    removePending = true,
  ): boolean {
    const responseEntries = this.responseEntriesForPending(convState, pending);
    const assistantText = this.assistantTextFromEntries(responseEntries);
    if (responseEntries.length === 0 && !this.responseIdentity(pending).envelopeId) return false;
    this.completePendingResponse(proc, pending, assistantText, removePending);
    return true;
  }

  private shouldCompleteStructuredPending(
    proc: ManagedProcess,
    pending: PendingResponse,
    watcherActive: boolean,
  ): boolean {
    if (!watcherActive || isCodexProcess(proc)) return false;
    if (!pending.hasStructuredEntries || pending.lastStructuredAt === undefined) return false;
    return Date.now() - pending.lastStructuredAt >= STRUCTURED_ENTRY_QUIET_MS;
  }

  // MARK: - Refresh timer (output stability detection)

  private startRefreshTimer() {
    this.refreshTimer = setInterval(() => this.refreshAll(), RESPONSE_REFRESH_INTERVAL_MS);
  }

  private refreshAll() {
    if (this.isRefreshing) return;
    const running = this.processes.filter(p => p.isRunning);
    if (running.length === 0) return;

    this.isRefreshing = true;
    try {
      for (const proc of running) {
        const pending = this.pendingResponses.get(proc.id);
        if (!pending) continue;
        if (pending.inputDispatch && !pending.inputDispatch.submitted) continue;

        const currentFileSize = proc.logFilePath ? getFileSize(proc.logFilePath) : 0;
        const watcherActive = this.isWatcherActive(proc.id);
        const hasWatcher = this.hasConversationWatcher(proc.id);
        const suppressRawFallback = this.shouldSuppressRawPendingFallback(proc, hasWatcher);

        if (proc.agentId && this.shouldCompleteStructuredPending(proc, pending, watcherActive)) {
          const convState = this.conversationStates.get(proc.id);
          if (convState && this.completePendingFromEntries(proc, pending, convState)) {
            this.pendingResponses.delete(proc.id);
            continue;
          }
        }

        const elapsed = Date.now() - pending.createdAt;
        const maxWaitMs = hasWatcher ? 120_000 : 60_000;
        const timedOut = elapsed > maxWaitMs;

        if (timedOut) {
          if (proc.agentId) {
            if (watcherActive) {
              const convState = this.conversationStates.get(proc.id)!;
              if (!this.completePendingFromEntries(proc, pending, convState, false)) {
                if (!suppressRawFallback && this.shouldStreamRawWithActiveWatcher(proc)) {
                  this.emitRawPendingOutput(proc, pending);
                  this.completePendingResponse(proc, pending, this.readCleanPendingOutput(proc, pending), false);
                } else {
                  this.completePendingResponse(proc, pending, '', false);
                }
              }
            } else {
              if (!suppressRawFallback) {
                this.emitRawPendingOutput(proc, pending);
              }
              this.completePendingResponse(proc, pending, '', false);
            }
          }
          this.pendingResponses.delete(proc.id);
          continue;
        }

        const stableThreshold = hasWatcher && !watcherActive ? 10 : 2;

        if (currentFileSize <= pending.snapshotOffset) {
          // No new output yet
        } else if (currentFileSize === pending.lastFileSize) {
          pending.stableCount++;
          if (pending.stableCount >= stableThreshold) {
            if (proc.agentId) {
              if (watcherActive) {
                const convState = this.conversationStates.get(proc.id)!;
                const responseEntries = this.responseEntriesForPending(convState, pending);
                if (responseEntries.length > 0 || pending.hasStructuredEntries) {
                  this.completePendingFromEntries(proc, pending, convState);
                  this.pendingResponses.delete(proc.id);
                } else if (suppressRawFallback) {
                  continue;
                } else if (this.shouldStreamRawWithActiveWatcher(proc)) {
                  const emitted = this.emitRawPendingOutput(proc, pending);
                  if (emitted && !pending.rawCompletedAt) {
                    pending.rawCompletedAt = Date.now();
                  }
                  if (
                    pending.rawCompletedAt
                    && Date.now() - pending.rawCompletedAt > STRUCTURED_WATCHER_RAW_LINGER_MS
                  ) {
                    this.completePendingResponse(proc, pending, this.readCleanPendingOutput(proc, pending));
                  }
                  continue;
                } else {
                  this.completePendingFromEntries(proc, pending, convState);
                  this.pendingResponses.delete(proc.id);
                }
              } else if (hasWatcher) {
                if (suppressRawFallback) {
                  continue;
                }
                if (this.responseIdentity(pending).envelopeId && !pending.rawCompletedAt) {
                  this.completePendingResponse(proc, pending, '', false);
                  pending.rawCompletedAt = Date.now();
                }
                if (pending.rawCompletedAt && Date.now() - pending.rawCompletedAt > 30_000) {
                  this.pendingResponses.delete(proc.id);
                }
                continue;
              } else {
                this.emitRawPendingOutput(proc, pending);
                this.completePendingResponse(proc, pending, '');
              }
            }
            this.pendingResponses.delete(proc.id);
          }
        } else {
          pending.stableCount = 0;
          pending.lastFileSize = currentFileSize;
          pending.rawCompletedAt = undefined;

          if (
            !pending.hasStructuredEntries
            && proc.agentId
            && !suppressRawFallback
            && (!watcherActive || this.shouldStreamRawWithActiveWatcher(proc))
          ) {
            this.emitRawPendingOutput(proc, pending);
          }
        }
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  private cleanLogOutput(raw: string, sentText?: string): string {
    let cleaned = stripAnsi(normalizeOutput(raw)).trim();
    if (!cleaned) return '';

    const lines = cleaned.split('\n');
    const filtered: string[] = [];

    const sentNormalized = sentText
      ? sentText.replace(/\s+/g, '').toLowerCase()
      : '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^[─━═┌┐└┘├┤┬┴┼╭╮╰╯│┃╌╍╎╏║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬\s]+$/.test(trimmed)) continue;
      if (/^[│|╎]\s.*\s[│|╎]$/.test(trimmed)) continue;
      if (/^[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●◉◎○◯⦿⊙⊚]/.test(trimmed)) continue;
      if (/^[❯>$#%]\s*$/.test(trimmed)) continue;
      if (/^[█▘▝▔▕▀▄▌▍▎▏▐░▒▓╭─╮╰─╯\s]+$/.test(trimmed)) continue;
      if (/^\?\s*for\s*shortcuts?$/i.test(trimmed)) continue;
      if (/\b(ctrl|alt|shift)\+\w/i.test(trimmed)) continue;
      if (/^IDE extension/i.test(trimmed)) continue;
      if (/^Remaining reqs/i.test(trimmed)) continue;
      if (/^(Loading|Loaded)\s+environment/i.test(trimmed)) continue;
      if (/^Environment loaded/i.test(trimmed)) continue;
      if (/^Tip:/i.test(trimmed)) continue;
      if (/uses AI.*check for mistakes/i.test(trimmed)) continue;
      if (/No copilot instructions found/i.test(trimmed)) continue;
      if (/Describe a task to get started/i.test(trimmed)) continue;
      if (/^~\/\S+\s*$/.test(trimmed)) continue;
      if (/^\S+\s+\(\d+x?\)\s*$/.test(trimmed)) continue;
      if (/^Type @ to mention/i.test(trimmed)) continue;
      if (/switch mode/i.test(trimmed) && /run command/i.test(trimmed)) continue;

      if (sentNormalized) {
        const lineNormalized = trimmed.replace(/\s+/g, '').toLowerCase();
        if (lineNormalized.length > 3 && sentNormalized.includes(lineNormalized)) continue;
      }

      filtered.push(line);
    }
    return filtered.join('\n').trim();
  }
}
