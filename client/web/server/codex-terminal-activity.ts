import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export type CodexTerminalActivityPhase = 'unknown' | 'initializing' | 'working' | 'idle';

export interface CodexTerminalActivitySnapshot {
  phase: CodexTerminalActivityPhase;
  busy: boolean;
  ready: boolean;
}

interface CodexTerminalActivityTrackerOptions {
  startupSettleMs?: number;
  onChange?: (snapshot: CodexTerminalActivitySnapshot) => void;
}

const DEFAULT_STARTUP_SETTLE_MS = 1_500;

export class CodexTerminalActivityTracker {
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly startupSettleMs: number;
  private readonly onChange?: (snapshot: CodexTerminalActivitySnapshot) => void;
  private startupComplete = false;
  private startupSettleTimer?: ReturnType<typeof setTimeout>;
  private observed: CodexTerminalActivitySnapshot = {
    phase: 'unknown',
    busy: false,
    ready: false,
  };
  private current: CodexTerminalActivitySnapshot = {
    phase: 'initializing',
    busy: true,
    ready: false,
  };

  constructor(cols = 200, rows = 50, options: CodexTerminalActivityTrackerOptions = {}) {
    this.startupSettleMs = options.startupSettleMs ?? DEFAULT_STARTUP_SETTLE_MS;
    this.onChange = options.onChange;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
  }

  async write(data: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.terminal.write(data, () => {
        try {
          this.applyObserved(classifyCodexTerminalScreen(this.screenText()));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  snapshot(): CodexTerminalActivitySnapshot {
    return { ...this.current };
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
    this.applyObserved(classifyCodexTerminalScreen(this.screenText()));
  }

  dispose() {
    if (this.startupSettleTimer) clearTimeout(this.startupSettleTimer);
    this.startupSettleTimer = undefined;
    this.terminal.dispose();
  }

  private applyObserved(observed: CodexTerminalActivitySnapshot) {
    this.observed = observed;
    if (this.startupComplete) {
      this.update(observed);
      return;
    }

    if (observed.phase !== 'idle') {
      if (this.startupSettleTimer) clearTimeout(this.startupSettleTimer);
      this.startupSettleTimer = undefined;
      this.update(observed.phase === 'unknown'
        ? { phase: 'initializing', busy: true, ready: false }
        : observed);
      return;
    }

    this.update({ phase: 'initializing', busy: true, ready: false });
    if (this.startupSettleTimer) clearTimeout(this.startupSettleTimer);
    if (this.startupSettleMs <= 0) {
      this.completeStartupIfIdle();
      return;
    }
    this.startupSettleTimer = setTimeout(() => {
      this.startupSettleTimer = undefined;
      this.completeStartupIfIdle();
    }, this.startupSettleMs);
  }

  private completeStartupIfIdle() {
    if (this.observed.phase !== 'idle') return;
    this.startupComplete = true;
    this.update(this.observed);
  }

  private update(next: CodexTerminalActivitySnapshot) {
    if (
      next.phase === this.current.phase
      && next.busy === this.current.busy
      && next.ready === this.current.ready
    ) return;
    this.current = next;
    this.onChange?.(this.snapshot());
  }

  private screenText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }
}

export function classifyCodexTerminalScreen(screen: string): CodexTerminalActivitySnapshot {
  if (/\bStarting MCP servers?\b(?:\s*\(\d+\/\d+\))?/i.test(screen)) {
    return { phase: 'initializing', busy: true, ready: false };
  }
  if (/\bWorking\s*\([^\n)]*esc to interrupt[^\n)]*\)/i.test(screen)) {
    return { phase: 'working', busy: true, ready: false };
  }

  const hasInputPrompt = /(?:^|\n)\s*[›❯]\s+\S/m.test(screen);
  if (hasInputPrompt) {
    return { phase: 'idle', busy: false, ready: true };
  }
  return { phase: 'unknown', busy: false, ready: false };
}
