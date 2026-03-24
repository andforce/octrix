import { useScrollReveal } from '../hooks/useScrollReveal'

const STEPS = [
  {
    number: '01',
    title: '安装 Octrix',
    description: '下载并安装 macOS 原生应用，启动后自动扫描已安装的 AI CLI 工具',
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
    ),
  },
  {
    number: '02',
    title: '添加 AI Agent',
    description: '从通讯录选择已安装的 AI 平台（Claude Code、Copilot、Gemini 等），一键添加到系统',
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
      </svg>
    ),
  },
  {
    number: '03',
    title: '组建团队',
    description: '创建群组，为每个 Agent 分配角色——让 Claude 当架构师，Gemini 做测试工程师，各尽其能',
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    number: '04',
    title: '下达任务',
    description: '在群聊中 @指定 Agent 或广播任务，AI 团队自动协作完成。实时查看终端输出，随时调整方向',
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
]

export function HowItWorks() {
  const { ref, isVisible } = useScrollReveal<HTMLElement>()

  return (
    <section id="how-it-works" ref={ref} className="relative py-32">
      <div className="mx-auto max-w-5xl px-6">
        {/* Section header */}
        <div className={`text-center mb-20 transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          <p className="font-display text-xs font-bold uppercase tracking-[0.25em] text-accent mb-3">How it works</p>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-content">
            四步开启 AI 协作
          </h2>
        </div>

        {/* Steps */}
        <div className="relative">
          {/* Connecting line */}
          <div className="absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-accent via-mint to-accent/20 hidden md:block" />

          <div className="space-y-12 md:space-y-16">
            {STEPS.map((step, i) => (
              <div
                key={step.number}
                className={`relative flex flex-col md:flex-row gap-6 md:gap-10 transition-all duration-700 ${
                  isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'
                }`}
                style={{ transitionDelay: `${i * 150 + 200}ms` }}
              >
                {/* Step number circle */}
                <div className="relative z-10 flex h-16 w-16 flex-shrink-0 items-center justify-center">
                  <div className={`absolute inset-0 rounded-2xl ${
                    i % 2 === 0 ? 'bg-accent-muted ring-1 ring-accent/30' : 'bg-mint-dim ring-1 ring-mint/30'
                  }`} />
                  <span className={`relative font-display text-lg font-bold ${
                    i % 2 === 0 ? 'text-accent' : 'text-mint'
                  }`}>
                    {step.number}
                  </span>
                </div>

                {/* Content card */}
                <div className="flex-1 rounded-2xl border border-border bg-surface-elevated/50 p-6 md:p-8 backdrop-blur-sm transition-colors hover:bg-surface-elevated/80 hover:border-border-strong">
                  <div className="flex items-start gap-4">
                    <div className={`hidden sm:flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${
                      i % 2 === 0 ? 'bg-accent-muted text-accent' : 'bg-mint-dim text-mint'
                    }`}>
                      {step.icon}
                    </div>
                    <div>
                      <h3 className="font-display text-xl font-bold text-content mb-2">
                        {step.title}
                      </h3>
                      <p className="text-content-muted leading-relaxed">
                        {step.description}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
