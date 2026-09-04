import { useAppStore, useAppDispatch } from '../../hooks/useStore';
import { useWs } from '../../hooks/useWebSocket';
import { TerminalView } from '../TerminalView';
import { DraggableTerminalDialog } from '../terminals/DraggableTerminalDialog';

export function TerminalModal() {
  const { terminalAgentId, terminalGroupId, agents } = useAppStore();
  const dispatch = useAppDispatch();
  const ws = useWs();

  if (!terminalAgentId || !terminalGroupId) return null;

  const agent = agents.find(a => a.id === terminalAgentId);
  const title = agent ? `${agent.name} · 模型终端` : '模型终端';
  const subtitle = agent ? `已绑定 ${agent.command} 进程输出` : '已绑定模型进程输出';

  return (
    <DraggableTerminalDialog
      title={title}
      subtitle={subtitle}
      badge="agent pty"
      onClose={() => dispatch({ type: 'CLOSE_TERMINAL' })}
      width="min(1180px, 90vw)"
      height="min(760px, 80vh)"
      maxWidth="90vw"
      maxHeight="84vh"
      zIndexClassName="z-[60]"
    >
      <div className="h-full bg-[radial-gradient(circle_at_top,rgba(79,209,197,0.08),transparent_42%),linear-gradient(180deg,rgba(12,15,21,0.98),rgba(7,9,13,1))]">
        <TerminalView agentId={terminalAgentId} groupId={terminalGroupId} ws={ws} />
      </div>
    </DraggableTerminalDialog>
  );
}
