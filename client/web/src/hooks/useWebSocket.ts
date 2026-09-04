import { createContext, useCallback, useContext, useEffect, useRef, type Dispatch } from 'react';
import type { Envelope, AppState, ConversationEntry } from '../types';

type Action =
  | { type: 'SET_STATE'; payload: AppState }
  | { type: 'ADD_MESSAGE'; payload: Envelope }
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; body: string; entries?: ConversationEntry[]; status?: Envelope['status'] } }
  | { type: 'SET_RUNNING_AGENTS'; payload: { runningAgentIdsByGroup: Record<string, string[]>; busyAgentIdsByGroup?: Record<string, string[]>; agentErrorsByGroup?: Record<string, Record<string, string>> } };

type RawMessageHandler = (event: string, data: unknown) => void;

export interface WsApi {
  sendMessage: (event: string, data: unknown) => void;
  addHandler: (handler: RawMessageHandler) => () => void;
}

const noop: WsApi = {
  sendMessage: () => {},
  addHandler: () => () => {},
};

export const WsContext = createContext<WsApi>(noop);
export function useWs() { return useContext(WsContext); }

export function useWebSocket(dispatch: Dispatch<Action>): WsApi {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<RawMessageHandler>>(new Set());

  const sendMessage = useCallback((event: string, data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event, data }));
    }
  }, []);

  const addHandler = useCallback((handler: RawMessageHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    function connect() {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isDev = import.meta.env.DEV;
      const wsHost = isDev
        ? `${window.location.hostname}:${__CLI_BRIDGE_PORT__}`
        : window.location.host;
      const ws = new WebSocket(`${protocol}//${wsHost}/ws`);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          const { event, data } = JSON.parse(e.data);

          switch (event) {
            case 'state:update':
              dispatch({ type: 'SET_STATE', payload: data as AppState });
              break;
            case 'messages:new':
              dispatch({ type: 'ADD_MESSAGE', payload: data as Envelope });
              break;
            case 'messages:update':
              dispatch({ type: 'UPDATE_MESSAGE', payload: data as { id: string; body: string; entries?: ConversationEntry[]; status?: Envelope['status'] } });
              break;
            case 'process:status':
              dispatch({ type: 'SET_RUNNING_AGENTS', payload: data as { runningAgentIdsByGroup: Record<string, string[]>; busyAgentIdsByGroup?: Record<string, string[]>; agentErrorsByGroup?: Record<string, Record<string, string>> } });
              break;
          }

          for (const handler of handlersRef.current) {
            handler(event, data);
          }
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [dispatch]);

  return { sendMessage, addHandler };
}
