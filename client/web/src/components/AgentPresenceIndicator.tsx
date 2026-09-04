import type { AgentPresenceState } from '../types';
import { getPresenceIndicatorClasses, getPresenceTitle } from '../lib/agentStatus';

interface AgentPresenceIndicatorProps {
  state: AgentPresenceState;
  detail?: string;
  className?: string;
  count?: number;
}

export function AgentPresenceIndicator({
  state,
  detail,
  className = '',
  count,
}: AgentPresenceIndicatorProps) {
  const title = getPresenceTitle(state, detail);

  const busyMotion =
    state === 'busy'
      ? 'animate-presence-busy motion-reduce:animate-none motion-reduce:opacity-100'
      : '';
  const dotBox = state === 'busy' ? 'inline-block' : '';

  if (typeof count === 'number' && count > 0) {
    return (
      <span
        title={title}
        className={`flex items-center justify-center rounded-full text-[9px] font-bold ${getPresenceIndicatorClasses(state, 'badge')} ${busyMotion} ${className}`.trim()}
      >
        {count}
      </span>
    );
  }

  return (
    <span
      title={title}
      className={`${dotBox} rounded-full ${getPresenceIndicatorClasses(state, 'dot')} ${busyMotion} ${className}`.trim()}
    />
  );
}
