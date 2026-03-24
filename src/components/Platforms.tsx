import { useScrollReveal } from '../hooks/useScrollReveal'

const PLATFORMS = [
  {
    name: 'Claude Code',
    cli: 'claude',
    gradient: 'from-[#d97757] to-[#c4603f]',
    letter: 'C',
  },
  {
    name: 'OpenCode',
    cli: 'opencode',
    gradient: 'from-[#6366f1] to-[#4f46e5]',
    letter: 'O',
  },
  {
    name: 'GitHub Copilot',
    cli: 'copilot',
    gradient: 'from-[#6e7681] to-[#484f58]',
    letter: 'G',
  },
  {
    name: 'Gemini CLI',
    cli: 'gemini',
    gradient: 'from-[#4285f4] to-[#1a73e8]',
    letter: 'G',
  },
  {
    name: 'Codex CLI',
    cli: 'codex',
    gradient: 'from-[#10a37f] to-[#0d8c6d]',
    letter: 'X',
  },
  {
    name: 'Cursor CLI',
    cli: 'agent',
    gradient: 'from-[#a855f7] to-[#7c3aed]',
    letter: 'A',
  },
]

export function Platforms() {
  const { ref, isVisible } = useScrollReveal<HTMLElement>()

  return (
    <section id="platforms" ref={ref} className="relative py-32">
      {/* Background accent */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />
      </div>

      <div className="mx-auto max-w-6xl px-6">
        {/* Section header */}
        <div className={`text-center mb-16 transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          <p className="font-display text-xs font-bold uppercase tracking-[0.25em] text-mint mb-3">Platforms</p>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-content">
            兼容主流 AI 平台
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-content-muted text-lg">
            所有平台均已适配会话采集，无缝接入你的 AI 工具链
          </p>
        </div>

        {/* Platform grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6">
          {PLATFORMS.map((platform, i) => (
            <div
              key={platform.name}
              className={`group relative flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface-elevated/40 px-6 py-8 backdrop-blur-sm transition-all duration-700 hover:border-border-strong hover:bg-surface-elevated/80 hover:-translate-y-1 ${
                isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'
              }`}
              style={{ transitionDelay: `${i * 80 + 200}ms` }}
            >
              {/* Avatar */}
              <div className={`flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br ${platform.gradient} text-white text-xl font-bold shadow-lg transition-transform group-hover:scale-110`}>
                {platform.letter}
              </div>

              {/* Name */}
              <div className="text-center">
                <h3 className="font-display font-semibold text-content text-sm sm:text-base">
                  {platform.name}
                </h3>
                <p className="mt-1 font-mono text-xs text-content-subtle">
                  {platform.cli}
                </p>
              </div>

              {/* Status badge */}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-mint-dim px-3 py-1 text-xs font-medium text-mint">
                <span className="h-1.5 w-1.5 rounded-full bg-mint" />
                已适配
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
