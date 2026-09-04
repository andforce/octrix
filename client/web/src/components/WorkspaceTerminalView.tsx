import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useWs } from '../hooks/useWebSocket';

interface WorkspaceTerminalViewProps {
  groupId: string;
  terminalId: string;
  terminalName: string;
}

export function WorkspaceTerminalView({ groupId, terminalId, terminalName }: WorkspaceTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ws = useWs();

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
      theme: {
        background: '#07090d',
        foreground: '#ebe8e4',
        cursor: '#ff5f3d',
        selectionBackground: 'rgba(255, 95, 61, 0.22)',
        black: '#07090d',
        red: '#ff7b72',
        green: '#4fd1c5',
        yellow: '#e3b341',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#56d4dd',
        white: '#ebe8e4',
        brightBlack: '#3d4450',
        brightRed: '#ffa198',
        brightGreen: '#6ee7d8',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#e9d5ff',
        brightCyan: '#a5f3fc',
        brightWhite: '#f8fafc',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    let inputReady = false;
    let enableInputTimer: number | null = null;

    const scheduleInputReady = (delayMs: number) => {
      if (enableInputTimer !== null) {
        window.clearTimeout(enableInputTimer);
      }
      enableInputTimer = window.setTimeout(() => {
        inputReady = true;
        term.focus();
      }, delayMs);
    };

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
      ws.sendMessage('workspace-terminal:attach', { groupId, terminalId, terminalName });
      ws.sendMessage('workspace-terminal:resize', {
        terminalId,
        cols: term.cols,
        rows: term.rows,
      });
      scheduleInputReady(300);
    });

    term.onData((data) => {
      if (!inputReady) return;
      ws.sendMessage('workspace-terminal:input', { terminalId, data });
    });

    term.onResize(({ cols, rows }) => {
      ws.sendMessage('workspace-terminal:resize', { terminalId, cols, rows });
    });

    const removeHandler = ws.addHandler((event, data) => {
      const payload = data as Record<string, unknown>;
      if (payload.terminalId !== terminalId) return;
      if (event === 'workspace-terminal:output') {
        term.write(payload.data as string, () => {
          if (!inputReady) scheduleInputReady(80);
        });
      }
      if (event === 'workspace-terminal:exit') {
        term.write(`\r\n\x1b[90m[工作空间终端已退出，退出码: ${payload.exitCode ?? 'unknown'}]\x1b[0m\r\n`);
      }
    });

    const onResize = () => fitAddon.fit();
    window.addEventListener('resize', onResize);

    const container = containerRef.current;
    const resizeObserver = typeof ResizeObserver !== 'undefined' && container
      ? new ResizeObserver(() => {
          requestAnimationFrame(() => fitAddon.fit());
        })
      : null;
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      if (enableInputTimer !== null) {
        window.clearTimeout(enableInputTimer);
      }
      removeHandler();
      ws.sendMessage('workspace-terminal:detach', { terminalId });
      term.dispose();
    };
  }, [groupId, terminalId, terminalName, ws]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, padding: '8px', boxSizing: 'border-box' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', minHeight: 0 }}
      />
    </div>
  );
}
