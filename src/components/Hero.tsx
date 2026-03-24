const DEMO_CONVERSATIONS = [
  {
    name: '支付链路重构',
    time: '21:35',
    preview: 'OpenCode: 已整理出一版更接近真实 ChatView 的落地页演示。',
    onlineCount: 2,
    selected: true,
    avatarBackground: 'linear-gradient(145deg, #fb7185, #dc2626)',
  },
  {
    name: 'Agent 平台落地',
    time: '20:11',
    preview: 'Claude Code: 建议把平台适配状态收敛到同一信息层级。',
    onlineCount: 1,
    avatarBackground: 'linear-gradient(145deg, #22d3ee, #0f766e)',
  },
  {
    name: '上下文丢失修复',
    time: '18:42',
    preview: 'Gemini CLI: validation 场景已经覆盖 handoff context loss。',
    onlineCount: 3,
    avatarBackground: 'linear-gradient(145deg, #818cf8, #4f46e5)',
  },
]

const DEMO_FILES = [
  'docs/specs/2026-03-24-handoff-context-loss-design.md',
  'web/src/components/ChatView.tsx',
  'docs/specs/validation-scenarios.md',
]

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-24 pb-16 sm:pb-20">
      {/* Background decorations */}
      <div className="absolute inset-0 bg-mesh pointer-events-none" />
      <div className="absolute inset-0 bg-grid-subtle pointer-events-none" />

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/6 h-72 w-72 rounded-full bg-accent/8 blur-[100px] animate-pulse-soft pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/6 h-64 w-64 rounded-full bg-mint/8 blur-[100px] animate-pulse-soft pointer-events-none" style={{ animationDelay: '1.5s' }} />

      <div className="relative mx-auto max-w-6xl px-6 py-10 sm:py-14 text-center">
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
          className="mt-16 animate-slide-up sm:mt-20"
          style={{ animationDelay: '0.5s' }}
        >
          <div className="relative mx-auto max-w-5xl">
            <div className="relative overflow-hidden rounded-[28px] border border-border-strong bg-surface shadow-panel backdrop-blur-sm text-left">
              <div className="pointer-events-none absolute inset-0 bg-mesh opacity-60" />
              <div className="pointer-events-none absolute inset-0 bg-grid-subtle opacity-[0.24]" />

              <div className="relative flex h-[560px]">
                <aside className="hidden w-72 flex-shrink-0 md:block">
                  <div className="relative flex h-full flex-col border-r border-border bg-surface-elevated/95 shadow-insetHighlight backdrop-blur-xl before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-gradient-to-b before:from-accent/80 before:via-mint/35 before:to-accent/20">
                    <div className="space-y-3 px-4 pb-3 pt-4">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">
                            CLI Bridge
                          </p>
                          <h3 className="font-display text-lg font-bold tracking-tight text-content">协调台</h3>
                        </div>
                        <div className="flex items-center gap-2 rounded-full border border-border bg-surface-muted/80 px-2.5 py-1">
                          <span className="h-2 w-2 rounded-full bg-mint text-mint shadow-[0_0_8px_currentColor]" />
                          <span className="font-mono text-[11px] text-content-muted">:5173</span>
                        </div>
                      </div>

                      <div className="relative">
                        <svg
                          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <div className="w-full rounded-xl border border-border bg-surface-muted/90 py-2 pl-9 pr-3 text-sm text-content-subtle">
                          搜索会话…
                        </div>
                      </div>
                    </div>

                    <div className="h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />

                    <div className="scrollbar-thin flex-1 overflow-y-auto">
                      {DEMO_CONVERSATIONS.map(conversation => (
                        <DemoConversationRow key={conversation.name} {...conversation} />
                      ))}
                    </div>

                    <div className="h-px bg-gradient-to-r from-transparent via-border-strong to-transparent" />

                    <div className="flex items-center justify-between px-4 py-3">
                      <button
                        type="button"
                        className="group flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium text-content-muted"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-muted text-accent">
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                          </svg>
                        </span>
                        建群
                      </button>
                      <button
                        type="button"
                        className="group flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium text-content-muted"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-muted text-mint">
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </span>
                        通讯录
                      </button>
                    </div>
                  </div>
                </aside>

                <div className="relative flex min-w-0 flex-1">
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-surface-elevated/70 shadow-insetHighlight backdrop-blur-sm md:border-l-0">
                    <div className="flex items-center justify-between border-b border-border px-5 py-4">
                      <div>
                        <h3 className="font-display text-lg font-bold tracking-tight text-content">支付链路重构</h3>
                        <p className="mt-0.5 text-xs text-content-muted">
                          4 位成员 · <span className="text-mint">3</span> 在线
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded-xl p-2.5 text-content-muted"
                        title="成员管理"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>
                    </div>

                    <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-4 pb-28">
                      <DemoMessageBubble
                        sender="Dy"
                        senderLabel="Dy"
                        body="@OpenCode 请把 `web/src/components/ChatView.tsx` 当前的真实布局，整理成适合放在落地页 Hero 的演示版本。"
                        avatarBackground="linear-gradient(145deg, #f59e0b, #d97706)"
                        isUser
                        time="21:34:08"
                      />

                      <DemoStructuredMessage />

                      <DemoMessageBubble
                        sender="Claude Code"
                        senderLabel="架构师(Claude Code)"
                        body="我已经把视觉语言收回到真实产品：左侧会话列表、主消息流、右下角终端入口都按 localhost:5173 的风格缩放展示。"
                        avatarBackground="linear-gradient(145deg, #d97757, #c4603f)"
                        time="21:35:21"
                      />
                    </div>

                    <div className="relative border-t border-border px-5 py-4">
                      <div className="mr-[88px] flex h-10 items-center rounded-xl border border-border bg-surface-muted/90 px-4 pr-24 text-sm text-content-subtle">
                        输入消息，使用 @ 提及 Agent…
                      </div>
                      <button
                        type="button"
                        className="absolute right-5 top-1/2 -translate-y-1/2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-glow"
                      >
                        发送
                      </button>
                    </div>
                  </div>

                  <aside className="hidden w-60 flex-shrink-0 xl:flex xl:flex-col border-l border-border bg-surface-elevated/50 backdrop-blur-sm">
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                        <svg className="h-4 w-4 flex-shrink-0 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <span className="text-xs font-semibold text-content-muted">工作空间</span>
                      </div>

                      <div className="px-3 py-2 border-b border-border/50">
                        <p className="truncate font-mono text-[10px] text-content-subtle" title="/Users/dywang/Code/github/AI-Agent-CLI-Bridge">
                          /Users/dywang/Code/github/AI-Agent-CLI-Bridge
                        </p>
                      </div>

                      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
                        {DEMO_FILES.map(file => (
                          <div key={file} className="flex items-center gap-1.5 rounded-lg py-1 pr-2 text-xs text-content-muted transition" style={{ paddingLeft: 8 }}>
                            <svg className="h-3.5 w-3.5 flex-shrink-0 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="truncate">{file}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </aside>

                  <button
                    type="button"
                    className="absolute bottom-0 right-0 z-20 hidden w-60 items-center gap-3 border border-b-0 border-r-0 border-border-strong bg-surface-elevated/96 px-4 py-3 text-left shadow-[0_-12px_24px_rgba(7,9,13,0.24)] backdrop-blur-xl md:flex"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-surface text-content-subtle">
                      <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-content">工作空间终端</span>
                      <span className="block truncate text-xs text-content-subtle">
                        关联 OpenCode，目录 /Users/dywang/Code/github/AI-Agent-CLI-Bridge
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function DemoConversationRow({
  name,
  time,
  preview,
  onlineCount,
  selected,
  avatarBackground,
}: {
  name: string
  time: string
  preview: string
  onlineCount: number
  selected?: boolean
  avatarBackground: string
}) {
  return (
    <div
      className={`group flex items-center gap-1 border-l-2 px-2 py-3 transition-colors ${
        selected
          ? 'border-accent bg-accent-muted shadow-[inset_0_0_24px_rgba(255,95,61,0.06)]'
          : 'border-transparent'
      }`}
    >
      <button
        type="button"
        aria-label="展开群成员"
        className="flex-shrink-0 rounded-md p-1 text-content-subtle"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="relative flex-shrink-0">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl shadow-glow"
            style={{ background: avatarBackground }}
          >
            <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <span className="absolute -bottom-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-mint px-1 text-[9px] font-bold text-surface shadow-md">
            {onlineCount}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-content">{name}</span>
            <span className="flex-shrink-0 text-[11px] tabular-nums text-content-subtle">{time}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-content-muted">{preview}</p>
        </div>
      </div>
    </div>
  )
}

function DemoMessageBubble({
  sender,
  senderLabel,
  body,
  avatarBackground,
  isUser,
  time,
}: {
  sender: string
  senderLabel?: string
  body: string
  avatarBackground: string
  isUser?: boolean
  time: string
}) {
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-md ring-2 ring-white/10"
        style={{ background: avatarBackground }}
      >
        {sender.charAt(0).toUpperCase()}
      </div>

      <div className={`flex min-w-0 max-w-[76%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`mb-1 flex items-center gap-1 text-[11px] text-content-muted ${isUser ? 'justify-end' : ''}`}>
          <span className="font-medium">{senderLabel ?? sender}</span>
        </div>

        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed ${
            isUser
              ? 'rounded-tr-md text-white shadow-glow'
              : 'border border-border bg-surface-muted/90 text-content shadow-sm rounded-tl-md'
          }`}
          style={isUser ? { background: avatarBackground } : undefined}
        >
          {body}
        </div>

        <span className={`mt-1 text-[10px] tabular-nums text-content-subtle ${isUser ? 'text-right' : ''}`}>
          {time}
        </span>
      </div>

      <div className="min-w-[48px] flex-1" />
    </div>
  )
}

function DemoStructuredMessage() {
  return (
    <div className="flex gap-3">
      <div
        className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-md ring-2 ring-white/10"
        style={{ background: 'linear-gradient(145deg, #6366f1, #4f46e5)' }}
      >
        O
      </div>

      <div className="flex min-w-0 max-w-[80%] flex-col">
        <div className="mb-1.5 flex items-center gap-1 text-[11px] text-content-muted">
          <span className="font-medium">研发(OpenCode)</span>
          <svg className="h-2.5 w-2.5 text-content-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span>所有人</span>
        </div>

        <div className="space-y-1.5">
          <div className="rounded-xl border border-accent/30 bg-accent-muted px-3 py-2 text-xs text-content">
            <span className="mr-1.5 font-semibold text-accent">user</span>
            目标是把当前 ChatView 的真实结构缩成一个 landing page demo，不要重新设计成另一套界面。
          </div>

          <div className="rounded-xl border border-mint/25 bg-mint-dim px-3 py-2">
            <div className="flex items-center gap-1.5 text-mint">
              <span>⚙</span>
              <span className="font-semibold">read_ui_structure</span>
            </div>
            <div className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-content-muted scrollbar-thin">
              Sidebar / ChatView / MessageBubble / Workspace button styles captured from localhost:5173
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface-muted/95 px-3 py-2 text-sm leading-relaxed text-content whitespace-pre-wrap break-words shadow-sm">
            已按真实产品样式压缩展示：保留左侧会话栏、群聊头部、消息气泡和底部工作空间终端入口。
            <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-content-subtle">
              <span>in: 2,184</span>
              <span>out: 418</span>
              <span>$0.0184</span>
            </div>
          </div>
        </div>

        <span className="mt-1 text-[10px] tabular-nums text-content-subtle">21:34:56</span>
      </div>

      <div className="min-w-[48px] flex-1" />
    </div>
  )
}
