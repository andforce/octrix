import { ENABLED_AGENTS, isFullBleedAgentLogo } from '../../agent-platforms';
import { useAppStore } from '../../hooks/useStore';
import { COLOR_MAP } from '../../types';

interface Props {
  onClose: () => void;
}

export function ContactsModal({ onClose }: Props) {
  const { agents, platformInstallState } = useAppStore();
  const titleId = 'contacts-modal-title';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[80vh] w-[min(520px,92vw)] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-panel"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">Agents</p>
          <h3 id={titleId} className="font-display text-lg font-bold text-content">通讯录</h3>
        </div>

        {/* List */}
        <div className="scrollbar-thin grid flex-1 grid-cols-2 gap-2 overflow-y-auto p-3">
          {ENABLED_AGENTS.map(supported => {
            const agent = agents.find(a => a.platform === supported.platform);
            const cliInstalled = Boolean(platformInstallState?.[supported.platform]);
            const useLogo = Boolean(supported.logoUrl);
            const logoImgClass = isFullBleedAgentLogo(supported.platform)
              ? 'h-full w-full object-cover object-center'
              : 'box-border h-full w-full p-1.5 object-contain object-center';
            const avatarBg = !useLogo && cliInstalled && agent
              ? `linear-gradient(145deg, ${COLOR_MAP[agent.avatarColor] ?? '#6b7280'}, ${COLOR_MAP[agent.avatarColor] ?? '#6b7280'}bb)`
              : undefined;

            return (
              <div
                key={supported.platform}
                className={[
                  'flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
                  cliInstalled
                    ? 'border-border bg-surface-muted/80 shadow-sm hover:border-border-strong hover:bg-surface-hover'
                    : 'border-border/60 bg-surface/50 text-content-muted hover:bg-surface-muted/60',
                ].join(' ')}
              >
                <div
                  className={[
                    'flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold shadow-sm',
                    'bg-zinc-300 text-white ring-1 ring-black/10 dark:bg-zinc-600 dark:ring-white/10',
                    !cliInstalled ? 'opacity-75' : '',
                  ].join(' ')}
                  style={avatarBg ? { background: avatarBg } : undefined}
                >
                  {useLogo && supported.logoUrl ? (
                    <img
                      src={supported.logoUrl}
                      alt=""
                      className={logoImgClass}
                    />
                  ) : (
                    supported.name.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm font-semibold ${cliInstalled ? 'text-content' : ''}`}>{supported.name}</p>
                  <p className={`truncate font-mono text-xs ${cliInstalled ? 'text-content-muted' : 'text-content-subtle'}`}>{supported.cliLabel}</p>
                </div>
                <span
                  className={[
                    'flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                    cliInstalled
                      ? 'bg-mint-dim text-mint ring-1 ring-mint/30'
                      : 'bg-surface-hover text-content-subtle',
                  ].join(' ')}
                >
                  {cliInstalled ? '已安装' : '未安装'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="w-full rounded-xl py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-content"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
