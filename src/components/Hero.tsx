export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Background decorations */}
      <div className="absolute inset-0 bg-mesh pointer-events-none" />
      <div className="absolute inset-0 bg-grid-subtle pointer-events-none" />

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/6 h-72 w-72 rounded-full bg-accent/8 blur-[100px] animate-pulse-soft pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/6 h-64 w-64 rounded-full bg-mint/8 blur-[100px] animate-pulse-soft pointer-events-none" style={{ animationDelay: '1.5s' }} />

      <div className="relative mx-auto max-w-5xl px-6 py-24 text-center">
        {/* Badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-elevated/80 px-4 py-1.5 backdrop-blur-sm animate-fade-in">
          <span className="h-2 w-2 rounded-full bg-mint shadow-[0_0_8px_#4fd1c5]" />
          <span className="text-xs font-medium text-content-muted">macOS native app</span>
        </div>

        {/* Main headline */}
        <h1
          className="font-display text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.08] animate-slide-up"
        >
          <span className="text-content">让 AI 团队协作</span>
          <br />
          <span className="text-gradient-accent">像人一样</span>
        </h1>

        {/* Subtitle */}
        <p
          className="mx-auto mt-6 max-w-2xl text-lg sm:text-xl text-content-muted leading-relaxed animate-slide-up"
          style={{ animationDelay: '0.15s' }}
        >
          Octrix 统一协调 Mac 上安装的各种编程 AI，
          <br className="hidden sm:block" />
          将它们虚拟化为团队成员，通过群组协作完成复杂任务
        </p>

        {/* CTAs */}
        <div
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up"
          style={{ animationDelay: '0.3s' }}
        >
          <a
            href="#download"
            className="group inline-flex items-center gap-2.5 rounded-2xl bg-accent px-8 py-4 text-base font-semibold text-white shadow-glow transition-all hover:bg-accent-hover hover:shadow-[0_0_64px_-8px_rgba(255,95,61,0.5)] hover:scale-[1.02] active:scale-[0.98]"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
            </svg>
            Download for macOS
          </a>
          <a
            href="#features"
            className="inline-flex items-center gap-2 rounded-2xl border border-border-strong px-8 py-4 text-base font-medium text-content-muted transition-all hover:bg-surface-hover hover:text-content hover:border-content-subtle"
          >
            了解更多
            <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </a>
        </div>

        {/* App preview mockup */}
        <div
          className="mt-20 animate-slide-up"
          style={{ animationDelay: '0.5s' }}
        >
          <div className="relative mx-auto max-w-3xl">
            {/* Glow behind */}
            <div className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-accent/20 via-transparent to-mint/15 blur-2xl opacity-60" />

            {/* Window frame */}
            <div className="relative rounded-2xl border border-border-strong bg-surface-elevated/90 shadow-panel backdrop-blur-sm overflow-hidden">
              {/* Title bar */}
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <div className="flex gap-1.5">
                  <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                  <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                  <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                </div>
                <span className="ml-3 text-xs text-content-subtle font-mono">Octrix — 协调台</span>
              </div>

              {/* Simulated app content */}
              <div className="flex h-64 sm:h-80">
                {/* Sidebar */}
                <div className="w-56 border-r border-border bg-surface-elevated p-3 hidden sm:block">
                  <div className="mb-3">
                    <div className="font-display text-[10px] font-bold uppercase tracking-[0.2em] text-content-subtle">Octrix</div>
                    <div className="font-display text-sm font-bold text-content">协调台</div>
                  </div>
                  <div className="space-y-1">
                    {['重构支付模块', '性能优化计划', 'API 文档生成'].map((name, i) => (
                      <div
                        key={name}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${
                          i === 0
                            ? 'bg-accent-muted border-l-2 border-accent text-content'
                            : 'text-content-muted'
                        }`}
                      >
                        <div className={`h-6 w-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold ${
                          i === 0 ? 'bg-gradient-to-br from-accent to-orange-600' : 'bg-surface-hover'
                        }`}>
                          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{name}</div>
                          <div className="text-[10px] text-content-subtle">{3 - i} 位成员</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Chat area */}
                <div className="flex-1 flex flex-col p-4 overflow-hidden">
                  <div className="flex-1 space-y-3 overflow-hidden">
                    <MockMessage
                      sender="群主"
                      content="@Claude 请分析现有的支付模块代码，找出性能瓶颈"
                      isUser
                    />
                    <MockMessage
                      sender="Claude Code"
                      role="架构师"
                      content="分析完成。发现 3 个关键瓶颈：1) N+1 查询问题 2) 缺少缓存层..."
                      color="accent"
                    />
                    <MockMessage
                      sender="Gemini CLI"
                      role="高级工程师"
                      content="我来负责实现缓存层优化，使用 Redis 作为中间件..."
                      color="mint"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function MockMessage({
  sender,
  content,
  role,
  isUser,
  color,
}: {
  sender: string
  content: string
  role?: string
  isUser?: boolean
  color?: 'accent' | 'mint'
}) {
  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className={`h-6 w-6 flex-shrink-0 rounded-md flex items-center justify-center text-[10px] font-bold text-white ${
          color === 'mint' ? 'bg-mint' : 'bg-accent'
        }`}>
          {sender[0]}
        </div>
      )}
      <div className={`max-w-[80%] rounded-xl px-3 py-2 ${
        isUser
          ? 'bg-accent/15 text-content'
          : 'bg-surface-muted text-content'
      }`}>
        {!isUser && (
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[10px] font-semibold text-content-muted">{sender}</span>
            {role && <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
              color === 'mint' ? 'bg-mint-dim text-mint' : 'bg-accent-muted text-accent'
            }`}>{role}</span>}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-content-muted">{content}</p>
      </div>
    </div>
  )
}
