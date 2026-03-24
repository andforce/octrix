import { useScrollReveal } from '../hooks/useScrollReveal'

const FEATURES = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
    title: 'AI 虚拟化',
    description: '将每个 AI Agent 赋予独特身份与角色——产品经理、架构师、高级工程师，让它们像真正的团队成员一样各司其职',
    color: 'accent' as const,
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    title: '群组协作',
    description: '创建群组、拉入 AI 成员、下发任务。支持 @提及 指定 Agent，或广播给所有在线成员，多 AI 协同作战',
    color: 'mint' as const,
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
    title: '终端集成',
    description: '内置 PTY 终端直连每个 Agent 的 CLI 进程，实时观察 AI 的思考过程和代码生成，随时介入调整',
    color: 'accent' as const,
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
      </svg>
    ),
    title: '工作流引擎',
    description: '使用 /wf 命令定义多步工作流，让不同 AI 按顺序接力完成复杂任务，实现流水线式自动化协作',
    color: 'mint' as const,
  },
]

export function Features() {
  const { ref, isVisible } = useScrollReveal<HTMLElement>()

  return (
    <section id="features" ref={ref} className="relative py-32">
      <div className="mx-auto max-w-6xl px-6">
        {/* Section header */}
        <div className={`text-center mb-16 transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          <p className="font-display text-xs font-bold uppercase tracking-[0.25em] text-accent mb-3">Features</p>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-content">
            重新定义 AI 协作
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-content-muted text-lg">
            不只是调用 API，而是让多个 AI 以团队的方式协同工作
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid gap-6 sm:grid-cols-2">
          {FEATURES.map((feature, i) => (
            <FeatureCard
              key={feature.title}
              feature={feature}
              index={i}
              isVisible={isVisible}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function FeatureCard({
  feature,
  index,
  isVisible,
}: {
  feature: typeof FEATURES[number]
  index: number
  isVisible: boolean
}) {
  const isAccent = feature.color === 'accent'

  return (
    <div
      className={`group relative rounded-2xl border border-border bg-surface-elevated/60 p-8 backdrop-blur-sm transition-all duration-700 hover:border-border-strong hover:bg-surface-elevated/90 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'
      }`}
      style={{ transitionDelay: `${index * 120 + 200}ms` }}
    >
      {/* Hover glow */}
      <div className={`absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-500 group-hover:opacity-100 ${
        isAccent
          ? 'bg-gradient-to-br from-accent/10 via-transparent to-transparent'
          : 'bg-gradient-to-br from-mint/10 via-transparent to-transparent'
      }`} />

      <div className="relative">
        {/* Icon */}
        <div className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl ring-1 transition-shadow group-hover:shadow-lg ${
          isAccent
            ? 'bg-accent-muted text-accent ring-accent/20 group-hover:shadow-accent/20'
            : 'bg-mint-dim text-mint ring-mint/20 group-hover:shadow-mint/20'
        }`}>
          {feature.icon}
        </div>

        <h3 className="font-display text-xl font-bold text-content mb-2">
          {feature.title}
        </h3>

        <p className="text-content-muted leading-relaxed">
          {feature.description}
        </p>
      </div>
    </div>
  )
}
