import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { WsApi } from '../hooks/useWebSocket';

interface TerminalViewProps {
  agentId: string;
  groupId: string;
  ws: WsApi;
}

export function TerminalView({ agentId, groupId, ws }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
      ws.sendMessage('terminal:resize', {
        agentId,
        groupId,
        cols: term.cols,
        rows: term.rows,
      });
      setTimeout(() => {
        ws.sendMessage('terminal:attach', { agentId, groupId });
        scheduleInputReady(300);
      }, 100);
    });

    term.onData((data) => {
      if (!inputReady) return;
      ws.sendMessage('terminal:input', { agentId, groupId, data });
    });

    term.onResize(({ cols, rows }) => {
      ws.sendMessage('terminal:resize', { agentId, groupId, cols, rows });
    });

    const removeHandler = ws.addHandler((event, data) => {
      const d = data as Record<string, unknown>;
      if (d.agentId !== agentId || d.groupId !== groupId) return;
      if (event === 'terminal:output') {
        const payload = d.data as string;
        term.write(payload, () => {
          if (!inputReady) scheduleInputReady(80);
        });
      }
      if (event === 'terminal:exit') {
        term.write(`\r\n\x1b[90m[进程已退出，退出码: ${d.exitCode ?? 'unknown'}]\x1b[0m\r\n`);
      }
    });

    const onResize = () => fitAddon.fit();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (enableInputTimer !== null) {
        window.clearTimeout(enableInputTimer);
      }
      removeHandler();
      ws.sendMessage('terminal:detach', { agentId, groupId });
      term.dispose();
    };
  }, [agentId, groupId, ws]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, padding: '8px', boxSizing: 'border-box' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', minHeight: 0 }}
      />
    </div>
  );
}
