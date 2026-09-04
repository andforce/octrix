import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  static reset() {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(_data: string) { /* noop */ }

  close() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function TestComponent() {
  useWebSocket(vi.fn());
  return null;
}

describe('useWebSocket', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not reconnect after the hook is cleaned up', () => {
    const { unmount } = render(<TestComponent />);

    expect(FakeWebSocket.instances).toHaveLength(1);

    unmount();
    vi.advanceTimersByTime(2000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects when the socket closes unexpectedly', () => {
    render(<TestComponent />);

    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose?.({} as CloseEvent);
    vi.advanceTimersByTime(2000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('dispatches ADD_MESSAGE on messages:new event', () => {
    const dispatch = vi.fn();
    function Comp() { useWebSocket(dispatch); return null; }
    render(<Comp />);

    const ws = FakeWebSocket.instances[0];
    const envelope = { id: 'e1', from: 'ai', to: 'user', body: 'hello', ts: 1, groupId: 'g1' };
    ws.onmessage?.({ data: JSON.stringify({ event: 'messages:new', data: envelope }) } as MessageEvent);

    expect(dispatch).toHaveBeenCalledWith({ type: 'ADD_MESSAGE', payload: envelope });
  });

  it('dispatches UPDATE_MESSAGE on messages:update event', () => {
    const dispatch = vi.fn();
    function Comp() { useWebSocket(dispatch); return null; }
    render(<Comp />);

    const ws = FakeWebSocket.instances[0];
    const update = { id: 'e1', body: 'updated body' };
    ws.onmessage?.({ data: JSON.stringify({ event: 'messages:update', data: update }) } as MessageEvent);

    expect(dispatch).toHaveBeenCalledWith({ type: 'UPDATE_MESSAGE', payload: update });
  });

  it('dispatches message status and process errors from websocket payloads', () => {
    const dispatch = vi.fn();
    function Comp() { useWebSocket(dispatch); return null; }
    render(<Comp />);

    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({
      data: JSON.stringify({ event: 'messages:update', data: { id: 'e1', body: 'updated', status: 'streaming' } }),
    } as MessageEvent);
    ws.onmessage?.({
      data: JSON.stringify({
        event: 'process:status',
        data: {
          runningAgentIdsByGroup: { 'g1': ['agent-1'] },
          busyAgentIdsByGroup: { 'g1': ['agent-1'] },
          agentErrorsByGroup: { 'g1': { 'agent-2': '启动失败' } },
        },
      }),
    } as MessageEvent);

    expect(dispatch).toHaveBeenCalledWith({
      type: 'UPDATE_MESSAGE',
      payload: { id: 'e1', body: 'updated', status: 'streaming' },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_RUNNING_AGENTS',
      payload: {
        runningAgentIdsByGroup: { 'g1': ['agent-1'] },
        busyAgentIdsByGroup: { 'g1': ['agent-1'] },
        agentErrorsByGroup: { 'g1': { 'agent-2': '启动失败' } },
      },
    });
  });

  it('dispatches SET_STATE on state:update event', () => {
    const dispatch = vi.fn();
    function Comp() { useWebSocket(dispatch); return null; }
    render(<Comp />);

    const ws = FakeWebSocket.instances[0];
    const state = {
      agents: [],
      groups: [],
      roles: [],
      taskSessions: [],
      messages: [],
      runningAgentIdsByGroup: {},
      agentErrorsByGroup: {},
      port: 9800,
      isRunning: true,
    };
    ws.onmessage?.({ data: JSON.stringify({ event: 'state:update', data: state }) } as MessageEvent);

    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STATE', payload: state });
  });
});
