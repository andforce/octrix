import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle,
  Circle,
  CloudCheck,
  CopySimple,
  LockKey,
  PaperPlaneRight,
  Plus,
  ShieldCheck,
  TerminalWindow,
  LinkSimple,
} from '@phosphor-icons/react';
import { createRoot } from 'react-dom/client';
import { ApiError, api, formatDeviceCode, jsonBody, normalizeDeviceCode, safeNext } from './api';
import './styles.css';

interface AuthMethods {
  apple: boolean;
  apple_native?: boolean;
  google: boolean;
  sms: boolean;
  public_url: string;
  sms_config: { resend_seconds: number };
}

interface Identity {
  id: string;
  provider: 'apple' | 'google' | 'sms';
  label: string;
}

interface User {
  id: string;
  name: string | null;
  picture_url: string | null;
  primary_label: string;
  identities: Identity[];
}

interface Device {
  id: string;
  kind: 'mac' | 'ios';
  external_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  online?: boolean;
}

interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  current?: boolean;
}

interface AccountPayload {
  user: User;
  devices: Device[];
  sessions: Session[];
  events: Array<{ id: string; event_type: string; created_at: string }>;
  auth_methods: { apple: boolean; google: boolean; sms: boolean };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hostInstallCommand(publicUrl: string): string {
  const normalized = publicUrl.replace(/\/+$/, '');
  return `curl -fsSL ${shellQuote(`${normalized}/install-host.sh`)} | OCTRIX_CLOUD_URL=${shellQuote(normalized)} bash`;
}

function Logo() {
  return <a className="brand" href="/" aria-label="Octrix 首页"><span className="brand-mark">O</span><span>Octrix</span></a>;
}

function Shell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <div className={compact ? 'shell shell-compact' : 'shell'}>
    <header className="nav">
      <Logo />
      <nav className="nav-links" aria-label="主导航">
        <a href="/#product">产品</a>
        <a href="/start">安装指南</a>
        <a href="/#security">安全</a>
        <a className="nav-account" href="/dashboard">授权中心</a>
      </nav>
    </header>
    {children}
    <footer>
      <Logo />
      <p>让 Mac 上的 AI 工作，从 iPhone 继续。</p>
      <div><a href="/start">安装指南</a><a href="/dashboard">授权中心</a><a href="/privacy">隐私政策</a><span>Octrix Cloud</span></div>
    </footer>
  </div>;
}

const SUPPORTED_CLIS = [
  { name: 'Codex CLI', command: 'codex', description: 'OpenAI 的命令行编码 Agent' },
  { name: 'OpenClaude', command: 'openclaude', description: 'Claude Code 兼容 CLI' },
  { name: 'Claude Code', command: 'claude', description: 'Anthropic 官方命令行编码 Agent' },
  { name: 'OpenCode', command: 'opencode', description: '开放式终端编码 Agent' },
  { name: 'GitHub Copilot CLI', command: 'copilot', description: 'GitHub Copilot 的命令行 Agent' },
  { name: 'Gemini CLI', command: 'gemini', description: 'Gemini 的命令行 Agent' },
  { name: 'Cursor CLI', command: 'agent', description: 'Cursor 的命令行编码 Agent' },
  { name: 'Kiro CLI', command: 'kiro-cli', description: 'Kiro 的命令行编码 Agent' },
  { name: 'Qoder CLI', command: 'qodercli', description: 'Qoder 的命令行编码 Agent' },
  { name: 'CodeBuddy', command: 'codebuddy', description: 'CodeBuddy 的命令行编码 Agent' },
] as const;

export function Landing() {
  return <Shell>
    <main className="landing">
      <section className="hero">
        <div className="hero-intro">
          <div className="hero-content">
            <div className="context-label"><span className="live-dot" /> Mac 在线，工作就在线</div>
            <h1>离开 Mac，<span>工作不用停。</span></h1>
            <p>Octrix 把 iPhone 变成 Mac 上 AI Agent 的安全入口。离开电脑后，继续发消息、看进度、接收结果。</p>
          </div>
          <div className="hero-conversion">
            <p>在任何地方，通过 iPhone 与 Mac 上的 Agent 无缝对话。通信经 Octrix Cloud 加密中继，安全、私密、可控。</p>
            <div className="hero-actions">
              <a className="button primary" href="/start">3 分钟开始使用 <ArrowRight size={17} weight="bold" /></a>
              <a className="button secondary" href="/login">登录并授权</a>
            </div>
          </div>
        </div>

        <ProductConnectionPreview />
      </section>

      <section className="quick-start" id="product">
        <div className="quick-start-heading">
          <p className="context-label">首次连接</p>
          <h2>3 分钟，让第一台 Mac 上线。</h2>
          <p>无需复杂网络配置。安装 Host、登录同一账号，iPhone 即可发现并连接你的 Mac。</p>
        </div>
        <ol className="quick-start-steps" aria-label="Octrix 使用流程">
          <li><strong>01</strong><div><h3>安装 Host</h3><p>在 Mac 安装 Octrix Host。</p></div></li>
          <li><strong>02</strong><div><h3>登录同一账号</h3><p>Mac 与 iPhone 使用同一账号。</p></div></li>
          <li><strong>03</strong><div><h3>iPhone 授权连接</h3><p>发现你的 Mac，授权后继续对话。</p></div></li>
        </ol>
        <a className="button primary quick-start-action" href="/start">开始安装 <ArrowRight size={17} weight="bold" /></a>
      </section>

      <section className="agent-focus" aria-labelledby="agent-focus-title">
        <div className="agent-focus-heading">
          <p className="context-label">全部适配平台</p>
          <h2 id="agent-focus-title">{SUPPORTED_CLIS.length} 种 Agent CLI<br />现在全部开放。</h2>
          <p>Octrix 已在本地 Web TUI、Host API 与 iOS 统一开放全部适配平台，并覆盖启动、终端交互、流式回复、群聊信息流、断线重连与模型选择。</p>
        </div>
        <div className="agent-table-wrap">
          <table className="agent-table">
            <caption>Octrix 当前支持的 Agent CLI</caption>
            <thead>
              <tr><th scope="col">Agent CLI</th><th scope="col">本地命令</th><th scope="col">状态</th></tr>
            </thead>
            <tbody>
              {SUPPORTED_CLIS.map((cli, index) => (
                <tr key={cli.name}>
                  <th scope="row">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span><strong>{cli.name}</strong><small>{cli.description}</small></span>
                  </th>
                  <td><code>{cli.command}</code></td>
                  <td><span className="availability"><CheckCircle size={15} weight="fill" />已开放</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="work-anywhere">
        <div className="work-copy">
          <p className="context-label">为离开电脑后的关键时刻设计</p>
          <h2>通勤途中确认结果，会议间隙补一句指令。</h2>
          <p>Octrix 不把整个桌面塞进小屏幕。它只保留真正需要随身携带的东西：会话、Agent 状态、任务进度和下一次输入。</p>
        </div>
        <div className="conversation-sample" aria-label="Octrix iPhone 对话示例">
          <div className="sample-bar"><span>Studio Mac</span><small><i className="online-dot" /> 在线</small></div>
          <div className="sample-message user">检查刚才的改动，跑完测试后告诉我结果。</div>
          <div className="sample-message agent"><b>Codex CLI</b><p>测试全部通过。我还发现授权空状态缺少下一步入口，已经一起补上。</p></div>
          <div className="sample-input">继续优化首次使用流程 <PaperPlaneRight size={17} weight="fill" /></div>
        </div>
      </section>

      <section className="security-story" id="security">
        <div><p className="context-label">安全不是额外配置</p><h2>默认只看见<br />属于你的 Mac。</h2></div>
        <div className="security-points">
          <article><h3>账号隔离</h3><p>设备发现与实时连接都经过同一账号边界，无法跨账号访问。</p></article>
          <article><h3>每台设备独立授权</h3><p>Mac 和 iPhone 使用独立凭证；撤销一台设备，不影响其他设备。</p></article>
          <article><h3>Mac 只建立出站连接</h3><p>不要求公网 IP，也不需要在路由器开放任何入站端口。</p></article>
        </div>
      </section>

      <section className="cta"><p>约 3 分钟完成首次连接</p><h2>先让一台 Mac 上线。</h2><div><a className="button light" href="/start">开始安装 <ArrowRight size={17} weight="bold" /></a><a className="button dark-button" href="/dashboard">管理我的设备</a></div></section>
    </main>
  </Shell>;
}

function ProductConnectionPreview() {
  return <div className="connection-preview" aria-label="Mac 通过 Octrix Cloud 与 iPhone 同步会话">
    <ol className="connection-steps" aria-label="跨设备连接流程">
      <li><span>1</span><div><strong>Mac Host 在线</strong><small>你的 Agent 正在运行</small></div><ArrowRight aria-hidden size={20} weight="bold" /></li>
      <li><span>2</span><div><strong>Octrix Cloud 中继</strong><small>端到端加密传输</small></div><ArrowRight aria-hidden size={20} weight="bold" /></li>
      <li><span>3</span><div><strong>iPhone 继续对话</strong><small>离开电脑也不中断</small></div></li>
    </ol>

    <div className="connection-stage">
      <div className="mac-window">
        <div className="window-bar">
          <span className="window-dots" aria-hidden><Circle size={9} weight="fill" /><Circle size={9} weight="fill" /><Circle size={9} weight="fill" /></span>
          <b>Octrix · Studio Mac</b>
        </div>
        <div className="mac-body">
          <aside><strong>会话</strong><span className="selected">发布前检查</span><span>重构设置页</span><span>用户反馈</span><span>数据分析</span></aside>
          <div className="mac-chat">
            <div className="mac-chat-title"><div><h3>发布前检查</h3><small><Circle size={8} weight="fill" /> Agent 在线</small></div><span>正在检查风险点与回归影响…</span></div>
            <div className="progress-row"><span /><b>68%</b></div>
            <div className="activity-log"><strong>最新日志</strong><p><time>10:21</time> 扫描变更文件 23/23</p><p><time>10:21</time> 分析影响范围</p><p><time>10:22</time> 生成检查报告</p></div>
            <a href="/#product" className="report-link">查看检查报告（3 项）<ArrowRight size={14} weight="bold" /></a>
          </div>
        </div>
        <div className="mac-status"><span><Plus size={15} weight="bold" /> 新建会话</span><small><Circle size={8} weight="fill" /> Host 已连接</small></div>
      </div>

      <div className="relay-column">
        <div className="relay-lock"><LockKey size={28} weight="regular" /></div>
        <h3>Octrix Cloud 中继服务</h3>
        <p>端到端加密 · 私有协议 · 不存储内容</p>
        <ul>
          <li><LinkSimple size={17} /><span><strong>建立连接</strong><small>设备认证通过</small></span></li>
          <li><ShieldCheck size={17} /><span><strong>加密通道</strong><small>TLS + 私有协议</small></span></li>
          <li><CloudCheck size={17} /><span><strong>消息中继</strong><small>实时转发</small></span></li>
        </ul>
      </div>

      <div className="phone-window">
        <div className="phone-status"><time>9:41</time><span>•••</span></div>
        <div className="phone-nav"><span>‹</span><small>Studio Mac · 在线</small><b>•••</b></div>
        <div className="phone-content">
          <h3>发布前检查</h3>
          <div className="connection-note"><span><Circle size={8} weight="fill" /> 已连接</span><small>会话已同步，随时可在 iPhone 继续。</small></div>
          <div className="phone-message user"><b>你 <time>10:21</time></b><p>帮我检查一下这次发布的风险点</p></div>
          <div className="phone-message agent"><b><Circle size={8} weight="fill" /> Codex CLI <time>10:22</time></b><p>已完成依赖与配置检查，发现 3 个潜在问题。</p><a href="/#product">查看检查报告（3 项）<ArrowRight size={13} weight="bold" /></a></div>
          <div className="phone-composer"><Plus size={15} /><span>继续与 Codex CLI 对话…</span><PaperPlaneRight size={15} weight="fill" /></div>
        </div>
      </div>
    </div>

    <ul className="connection-proof" aria-label="Octrix 连接特性">
      <li><ShieldCheck size={22} /><span><strong>无需公网 IP</strong><small>设备主动出连，不暴露服务</small></span></li>
      <li><LinkSimple size={22} /><span><strong>同账号设备发现</strong><small>自动发现，可控可撤销</small></span></li>
      <li><LockKey size={22} /><span><strong>端到端加密中继</strong><small>不存储内容，全程加密传输</small></span></li>
      <li><TerminalWindow size={22} /><span><strong>支持 {SUPPORTED_CLIS.length} 种 Agent CLI</strong><small>灵活接入你的工具链</small></span></li>
    </ul>
  </div>;
}

export function GettingStarted() {
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [publicUrlError, setPublicUrlError] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const installCommand = publicUrl ? hostInstallCommand(publicUrl) : null;

  useEffect(() => {
    void api<AuthMethods>('/api/v1/auth/methods')
      .then(methods => setPublicUrl(methods.public_url))
      .catch(() => setPublicUrlError(true));
  }, []);

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function copyInstallCommand() {
    if (!installCommand) return;
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return <Shell>
    <main className="guide">
      <header className="guide-hero">
        <div className="context-label"><span className="live-dot" /> 约 3 分钟</div>
        <h1>从安装 Host，到第一条回复。</h1>
        <p>先让 Octrix Host 在 Mac 后台运行并登录，再让 iPhone 登录同一个账号。设备会自动出现，不需要填写服务器地址或手工配对。</p>
      </header>

      <ol className="setup-flow">
        <li id="mac">
          <span className="step-number">1</span>
          <div className="step-copy"><p>准备 Mac</p><h2>安装 Octrix Host</h2><p>打开 Mac 的“终端”，粘贴下面一行。安装器会自动选择芯片版本，并把 Host 注册为登录后常驻服务。</p>
            <div className="host-install-command">
              <code>{installCommand ?? (publicUrlError ? '无法读取服务器配置，请稍后刷新页面。' : '正在读取服务器配置…')}</code>
              <button
                type="button"
                className="copy-install-command"
                data-state={copyState}
                disabled={!installCommand}
                aria-label={copyState === 'copied' ? '安装命令已复制' : copyState === 'error' ? '重新复制安装命令' : '复制安装命令'}
                onClick={() => void copyInstallCommand()}
              >
                {copyState === 'copied' ? <Check size={16} weight="bold" /> : <CopySimple size={16} weight="bold" />}
                <span aria-live="polite">{copyState === 'copied' ? '已复制' : copyState === 'error' ? '重试' : '复制'}</span>
              </button>
            </div>
            <p>首次安装会提示按回车申请“桌面、文稿和下载”访问权限；请在随后出现的 macOS 弹窗中逐项点“允许”，以后从 iPhone 远程选择工作目录就不需要守在 Mac 前。</p>
            <p>Host 包含 AI 进程管理、Octrix Cloud 连接和完整 Web 终端 TUI。安装完成后运行 <code>octrix webtui</code>，即可在浏览器打开 <code>http://127.0.0.1:39800/</code>，继续和 AI 交流。</p>
            <p>本地 Web TUI 只监听这台 Mac 的本机地址，浏览器关闭后 Host 与 AI 进程仍会继续运行。</p>
          </div>
          <div className="install-visual" aria-hidden="true"><span>Octrix Host</span><b>后台自动运行</b><i>同时提供</i><strong>Web 终端 TUI</strong></div>
        </li>

        <li id="authorize">
          <span className="step-number">2</span>
          <div className="step-copy"><p>授权 Mac</p><h2>授权这台 Mac</h2><p>安装完成后，终端会自动打开浏览器。登录 Octrix 账号并确认设备名称，这台 Mac 就会自动上线。</p>
            <ul className="check-list"><li>在浏览器登录 Octrix</li><li>确认“允许连接”</li><li>终端显示“连接：在线”</li></ul>
            <div className="cli-guide">
              <div><strong>Octrix 命令行工具</strong><span>管理后台 Host 与 Web TUI</span></div>
              <p>安装器会同时安装 <code>octrix</code>，无需打开桌面 App。</p>
              <dl>
                <div><dt><code>octrix status</code></dt><dd>检查账号和云端连接</dd></div>
                <div><dt><code>octrix auth</code></dt><dd>重新打开网页登录</dd></div>
                <div><dt><code>octrix webtui</code></dt><dd>打开 Mac 上的 Web 终端 TUI</dd></div>
                <div><dt><code>octrix restart</code></dt><dd>重启后台 Host</dd></div>
                <div><dt><code>octrix logout</code></dt><dd>退出账号并断开云端连接</dd></div>
              </dl>
            </div>
          </div>
          <div className="authorize-visual"><div><span>手机连接</span><small>账号与设备由 Octrix Cloud 管理</small></div><p><span>这台 Mac</span><b>Studio Mac</b></p><p><span>云端状态</span><b className="status-ready">等待登录</b></p><button type="button">使用浏览器登录</button></div>
        </li>

        <li id="iphone">
          <span className="step-number">3</span>
          <div className="step-copy"><p>连接 iPhone</p><h2>登录同一个 Octrix 账号</h2><p>回到 iPhone 上的 Octrix，点击“登录并连接”。登录完成后，账号下的全部 Mac 会自动出现。</p>
            <ul className="check-list"><li>Octrix Host 会在 Mac 后台自动运行</li><li>iPhone 使用与 Mac 相同的账号</li><li>在会话页点击“+”，发送第一条消息</li></ul>
            <div className="guide-actions"><a className="button primary" href="/login">登录 Octrix</a><a className="button secondary" href="/dashboard">打开授权中心</a></div>
          </div>
          <div className="success-visual"><span>✓</span><h3>Studio Mac 已连接</h3><p>会话和 Agent 状态正在同步</p></div>
        </li>
      </ol>

      <section className="guide-help"><div><p className="context-label">连接不上？</p><h2>先检查这三件事。</h2></div><div>
        <details><summary>iPhone 看不到 Mac</summary><p>确认两端登录同一个账号，并在 Mac 终端运行 <code>octrix status</code>；连接应显示为“在线”。</p></details>
        <details><summary>Mac 显示离线</summary><p>运行 <code>octrix restart</code> 后再检查 <code>octrix status</code>。如果账号已退出，运行 <code>octrix auth</code> 重新授权。</p></details>
        <details><summary>如何撤销一台设备</summary><p>进入授权中心，在设备列表中点击“撤销”。该设备的现有连接会立即断开。</p></details>
      </div></section>
    </main>
  </Shell>;
}

const privacySections = [
  ['scope', '适用范围'],
  ['collection', '我们处理的数据'],
  ['use', '我们如何使用数据'],
  ['sharing', '第三方与数据共享'],
  ['retention', '保留与删除'],
  ['choices', '你的选择与权利'],
  ['security', '安全措施'],
  ['children', '未成年人'],
  ['transfers', '跨境处理'],
  ['changes', '政策更新'],
  ['contact', '联系我们'],
] as const;

export function PrivacyPolicy() {
  useEffect(() => {
    const previousTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = description?.content;
    document.title = '隐私政策 — Octrix';
    if (description) description.content = '了解 Octrix 如何处理账号、设备、会话传输和可选语音功能中的数据，以及你可以如何管理或删除这些数据。';
    return () => {
      document.title = previousTitle;
      if (description && previousDescription !== undefined) description.content = previousDescription;
    };
  }, []);

  return <Shell>
    <main className="privacy">
      <header className="privacy-hero">
        <div>
          <p className="context-label">PRIVACY · 隐私</p>
          <h1>你的工作属于你。</h1>
          <p>这份政策说明 Octrix 在连接 iPhone 与你的 Mac 时会处理哪些数据、为什么需要这些数据，以及你如何管理或删除它们。</p>
          <small>生效日期：<time dateTime="2026-09-03">2026 年 9 月 3 日</time></small>
        </div>
        <aside className="privacy-boundary" aria-label="Octrix 的三项隐私边界">
          <span>核心边界</span>
          <ol>
            <li><b>账号与设备</b><p>云端只保存登录、授权和设备连接所需的信息。</p></li>
            <li><b>工作内容</b><p>会话由你的 Mac 持有；云端负责实时转发，不写入账号数据库。</p></li>
            <li><b>可选服务</b><p>语音和第三方登录只在你主动选择相应功能时使用。</p></li>
          </ol>
        </aside>
      </header>

      <div className="privacy-layout">
        <nav className="privacy-toc" aria-label="隐私政策目录">
          <span>目录</span>
          {privacySections.map(([id, label], index) => <a key={id} href={`#${id}`}><i>{String(index + 1).padStart(2, '0')}</i>{label}</a>)}
        </nav>

        <article className="privacy-content">
          <section id="scope">
            <p className="privacy-number">01</p>
            <h2>适用范围</h2>
            <p>本政策适用于由 Octrix 运营的 <a href="https://octrix.work">octrix.work</a>、Octrix iPhone 应用和连接该官方服务的 Octrix Host。Octrix 也可自行托管；第三方或你自行部署的实例由相应运营者负责，其数据处理不受本政策约束。</p>
          </section>

          <section id="collection">
            <p className="privacy-number">02</p>
            <h2>我们处理的数据</h2>
            <div className="privacy-data-grid">
              <div><h3>账号信息</h3><p>当你使用 Apple 或 Google 登录时，我们接收登录提供方返回的用户标识、经验证的邮箱，以及其提供的姓名和头像。使用短信登录时，我们处理你的中国大陆手机号。</p></div>
              <div><h3>设备与授权信息</h3><p>包括随机设备标识、设备名称与类型、授权和创建时间、最近连接时间、在线状态、登录会话，以及撤销设备或登录方式等安全事件。</p></div>
              <div><h3>网络与安全信息</h3><p>为建立连接、防止滥用和排查故障，我们可能处理 IP 地址、请求时间、请求路径、浏览器或系统提供的基础网络信息。短信验证记录还包含发送状态、重试时间和验证次数。</p></div>
              <div><h3>经中继传输的内容</h3><p>当你从 iPhone 操作 Mac 时，指令、AI 回复、任务状态以及你主动请求的文件或附件会经 Octrix Cloud 实时转发。当前服务不会把这些内容写入 Octrix Cloud 的账号数据库，但转发过程需要在内存中临时处理它们。</p></div>
              <div><h3>设备上的本地数据</h3><p>Mac 保存会话、工作区配置与运行日志；iPhone 保存会话缓存和设置。设备凭证及你自行提供的 DeepSeek API Key 保存在系统钥匙串中。这些本地数据不会因为使用云端账号而自动上传为云端备份。</p></div>
              <div><h3>麦克风与语音识别</h3><p>只有在你点击语音输入并授予系统权限后，应用才访问麦克风并调用 Apple 的语音识别服务。识别文本先作为可编辑草稿显示；你决定是否发送。</p></div>
            </div>
            <div className="privacy-note"><b>我们不做的事</b><p>Octrix 不包含广告 SDK，不出售个人信息，不使用跨应用行为跟踪，也不会在未选择文件或照片时读取你的资料库内容。</p></div>
          </section>

          <section id="use">
            <p className="privacy-number">03</p>
            <h2>我们如何使用数据</h2>
            <ul>
              <li>创建和维护 Octrix 账号，验证你的登录身份；</li>
              <li>把 Mac 与 iPhone 绑定到同一账号，并执行设备授权、发现、连接和撤销；</li>
              <li>在你已授权的设备之间转发请求、实时事件和回复；</li>
              <li>提供授权中心、登录会话管理与安全记录；</li>
              <li>限制短信滥用、发现异常连接、排查故障并保护服务；</li>
              <li>履行适用法律要求，以及处理你主动提出的支持或隐私请求。</li>
            </ul>
            <p>我们不会将收集的数据用于广告画像。Octrix 本身不会用你的 AI 对话内容训练模型；只有当你主动启用 DeepSeek 语音润色时，相应识别文本才会按下文说明直接发送给 DeepSeek，并受其自身政策约束。</p>
          </section>

          <section id="sharing">
            <p className="privacy-number">04</p>
            <h2>第三方与数据共享</h2>
            <p>我们只会在提供你选择的功能、保障服务安全或遵守法律所必需的范围内共享数据，不会出售数据。作为受我们委托的处理方，服务提供商应采取不低于本政策和适用法律要求的保护措施；当你直接使用第三方服务时，该第三方也会依据其自身政策处理数据。</p>
            <div className="provider-list">
              <div><span>Apple</span><p>提供 Sign in with Apple、iOS 钥匙串和系统语音识别。Apple 可能接收登录验证信息或语音数据，具体取决于你使用的功能与设备处理能力。</p><a href="https://www.apple.com/legal/privacy/szh/" target="_blank" rel="noreferrer">查看 Apple 隐私政策 ↗</a></div>
              <div><span>Google</span><p>在你选择 Google 登录时提供身份验证；官网还从 Google Fonts 加载字体，因此 Google 可能接收 IP 地址和浏览器请求信息。</p><a href="https://policies.google.com/privacy?hl=zh-CN" target="_blank" rel="noreferrer">查看 Google 隐私政策 ↗</a></div>
              <div><span>阿里云</span><p>在你选择手机号登录时发送并校验短信验证码，会接收手机号、验证码请求标识和验证信息。</p><a href="https://help.aliyun.com/zh/document_detail/2705225.html" target="_blank" rel="noreferrer">查看阿里云隐私政策 ↗</a></div>
              <div><span>DeepSeek（可选）</span><p>只有当你自行填写并验证 API Key 后，iPhone 才会把该 Key、模型请求和语音识别文本直接发送给 DeepSeek 进行文本整理；这些请求不经过 Octrix Cloud。</p><a href="https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html" target="_blank" rel="noreferrer">查看 DeepSeek 隐私政策 ↗</a></div>
            </div>
            <p>我们也可能在法律明确要求、保护用户和服务安全，或处理公司重组且接收方继续受本政策约束时披露必要信息。</p>
          </section>

          <section id="retention">
            <p className="privacy-number">05</p>
            <h2>保留与删除</h2>
            <p>账号身份、已授权设备和必要安全记录通常会保留到你请求删除账号，或我们不再需要它们来提供服务为止。网页登录会话默认最长有效 30 天；短信验证码默认 5 分钟失效，设备授权请求默认 10 分钟失效。失效并不一定意味着相应安全记录会立即从数据库中删除，记录可能在防滥用、审计或故障排查所需期间继续保留。</p>
            <p>Octrix Cloud 不持久化经中继转发的会话正文和文件内容。Mac 与 iPhone 上的本地数据会一直保留到你在相应设备上删除应用数据、工作区数据或相关文件。官方服务的数据库备份按轮换计划最多保留 14 天；删除请求完成后，残留副本会随备份轮换清除，但法律要求保留的内容除外。</p>
          </section>

          <section id="choices">
            <p className="privacy-number">06</p>
            <h2>你的选择与权利</h2>
            <ul>
              <li>在授权中心查看、重命名或撤销设备，并退出其他网页登录会话；</li>
              <li>在至少保留一种登录方式的前提下，解除不再使用的 Apple、Google 或手机号身份；</li>
              <li>在 iOS 系统设置中关闭麦克风或语音识别权限；</li>
              <li>在 Octrix 设置中清除 DeepSeek API Key，从而停止可选的语音润色；</li>
              <li>在 iPhone 的“设置 &gt; 账号 &gt; 删除账号”或网站授权中心永久删除账号及其云端数据；</li>
              <li>联系我们请求访问或更正账号数据，或对处理提出疑问。</li>
            </ul>
            <p>永久删除前需要使用当前登录凭证验证账号归属。删除会移除账号身份、设备、授权记录、访问凭证和网页登录会话，并立即断开所有关联设备；如果使用 Sign in with Apple，Octrix 会先向 Apple 撤销该授权。请另行删除 Mac 上希望移除的本地项目文件。</p>
          </section>

          <section id="security">
            <p className="privacy-number">07</p>
            <h2>安全措施</h2>
            <p>Octrix 使用 HTTPS 和加密 WebSocket 传输数据；Mac 只建立出站连接。账号、设备和访问令牌按用户隔离，Octrix 访问令牌及一次性授权值在服务端以带密钥的哈希形式保存。Sign in with Apple 的 refresh token 使用 AES-256-GCM 加密保存，只在账号删除时用于撤销 Apple 授权。设备可独立撤销，网页登录同时使用安全 Cookie 与跨站请求伪造防护。</p>
            <p>没有任何系统能保证绝对安全。请保护你的设备解锁凭证和第三方 API Key，只批准你本人正在操作且名称一致的设备。如发现异常，请立即撤销相关设备或会话并联系我们。</p>
          </section>

          <section id="children">
            <p className="privacy-number">08</p>
            <h2>未成年人</h2>
            <p>Octrix 面向能够管理开发工具、设备授权和第三方账号的用户，不以未满 13 周岁的儿童为目标。若当地法律规定了更高的最低年龄，应由监护人依法同意和监督使用。若你认为我们错误收集了未成年人的数据，请联系我们删除。</p>
          </section>

          <section id="transfers">
            <p className="privacy-number">09</p>
            <h2>跨境处理</h2>
            <p>你选择 Apple、Google 或 DeepSeek 等第三方服务时，数据可能按照相应服务商的基础设施和政策在你所在国家或地区之外处理。我们会把传输限制在实现相应功能所需的范围；请在启用功能前阅读上方链接的第三方政策。</p>
          </section>

          <section id="changes">
            <p className="privacy-number">10</p>
            <h2>政策更新</h2>
            <p>产品功能、数据处理方式或法律要求发生变化时，我们可能更新本政策，并在本页修改生效日期。若变化会实质影响你的权利或数据使用方式，我们会在合理可行的范围内通过产品界面或其他显著方式提醒你。</p>
          </section>

          <section id="contact">
            <p className="privacy-number">11</p>
            <h2>联系我们</h2>
            <p>如需提出隐私问题、访问或删除请求，请通过 Octrix 的 GitHub 项目与维护者联系。请仅说明你需要私下处理隐私请求，不要在公开 Issue 中填写邮箱、手机号、令牌、设备标识或会话内容；维护者会安排后续身份核验。</p>
            <a className="button primary" href="https://github.com/andforce/OctrixAI/issues/new" target="_blank" rel="noreferrer">发起隐私请求</a>
          </section>
        </article>
      </div>
    </main>
  </Shell>;
}

export function Login({ next }: { next: string }) {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { void api<AuthMethods>('/api/v1/auth/methods').then(setMethods).catch(error => setError(error.message)); }, []);

  async function submitPhone(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ challenge_id: string }>('/api/v1/auth/sms/challenges', { method: 'POST', body: jsonBody({ phone, next }) });
      setChallengeId(result.challenge_id);
    } catch (error) { setError(error instanceof Error ? error.message : '发送失败'); } finally { setBusy(false); }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ redirect_to: string }>(`/api/v1/auth/sms/challenges/${challengeId}/verify`, { method: 'POST', body: jsonBody({ code }) });
      window.location.assign(result.redirect_to || next);
    } catch (error) { setError(error instanceof Error ? error.message : '验证失败'); } finally { setBusy(false); }
  }

  return <Shell compact><main className="auth-layout">
    <section className="auth-intro"><span className="context-label">Octrix 账号</span><h1>一处登录，<br />连接所有设备。</h1><p>Mac 与 iPhone 使用同一个账号。登录后，你可以审批新设备、查看在线状态，并随时撤销访问。</p><ul><li>设备按账号严格隔离</li><li>每台设备使用独立凭证</li><li>授权与登录记录清晰可查</li></ul><a className="text-link light-link" href="/start">第一次使用？查看安装指南 →</a></section>
    <section className="auth-card"><div><span className="card-label">安全登录</span><h2>{challengeId ? '输入验证码' : '选择登录方式'}</h2></div>
      {error && <div className="error">{error}</div>}
      {!challengeId && methods && (methods.apple || methods.google) && <div className="social-logins">
        {methods.apple && <a className="button apple" href={`/auth/apple/start?next=${encodeURIComponent(next)}`}><span aria-hidden="true"></span> 使用 Apple 登录</a>}
        {methods.google && <a className="button google" href={`/auth/google/start?next=${encodeURIComponent(next)}`}><span aria-hidden="true">G</span> 使用 Google 登录</a>}
      </div>}
      {!challengeId && (methods?.apple || methods?.google) && methods.sms && <div className="divider"><span>或</span></div>}
      {!challengeId && methods?.sms && <form onSubmit={submitPhone}><label>中国大陆手机号</label><div className="phone-field"><span>+86</span><input autoComplete="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="138 0000 0000" required /></div><button className="button primary full" disabled={busy}>{busy ? '正在发送…' : '获取短信验证码'}</button></form>}
      {challengeId && <form onSubmit={submitCode}><label>6 位短信验证码</label><input className="code-field sms-code" autoFocus autoComplete="one-time-code" inputMode="numeric" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" required /><button className="button primary full" disabled={busy || code.length !== 6}>{busy ? '正在验证…' : '验证并登录'}</button><button type="button" className="text-button" onClick={() => { setChallengeId(''); setCode(''); }}>更换手机号</button></form>}
      {methods && !methods.apple && !methods.google && !methods.sms && <div className="empty">登录方式尚未配置，请联系管理员。</div>}
      <small className="legal">登录仅用于连接你自己的设备。使用前请阅读<a href="/privacy">《隐私政策》</a>。</small>
    </section>
  </main></Shell>;
}

export function Dashboard({ onLoggedOut = () => window.location.assign('/') }: { onLoggedOut?: () => void } = {}) {
  const [data, setData] = useState<AccountPayload | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'devices' | 'security'>('devices');
  const [loggingOut, setLoggingOut] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  async function load() {
    try { setData(await api<AccountPayload>('/api/v1/account')); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) window.location.assign('/login?next=/dashboard');
      else setError(error instanceof Error ? error.message : '加载失败');
    }
  }
  useEffect(() => { void load(); }, []);

  async function rename(device: Device) {
    const name = window.prompt('新的设备名称', device.name)?.trim();
    if (!name || name === device.name) return;
    await api(`/api/v1/account/devices/${device.id}`, { method: 'PATCH', body: jsonBody({ name }) });
    await load();
  }
  async function revoke(device: Device) {
    if (!window.confirm(`撤销“${device.name}”的访问？设备会立即断开。`)) return;
    await api(`/api/v1/account/devices/${device.id}`, { method: 'DELETE' });
    await load();
  }
  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await api('/api/v1/logout', { method: 'POST' });
      onLoggedOut();
    } catch (error) {
      setError(error instanceof Error ? error.message : '退出登录失败，请重试');
      setLoggingOut(false);
    }
  }
  async function deleteAccount() {
    if (!window.confirm('永久删除 Octrix 账号、登录方式、设备授权和会话？这项操作无法撤销。')) return;
    if (!window.confirm('最后确认：所有设备将立即断开，账号数据将被永久删除。')) return;
    setDeletingAccount(true);
    setError('');
    try {
      await api('/api/v1/account', { method: 'DELETE' });
      onLoggedOut();
    } catch (error) {
      setError(error instanceof Error ? error.message : '删除账号失败，请重试');
      setDeletingAccount(false);
    }
  }

  if (!data) return <Shell><main className="loading">{error || '正在载入授权中心…'}</main></Shell>;
  const macs = data.devices.filter(device => device.kind === 'mac');
  const phones = data.devices.filter(device => device.kind === 'ios');
  const activationTitle = macs.length === 0
    ? '下一步：让一台 Mac 上线'
    : phones.length === 0
      ? '下一步：在 iPhone 登录同一账号'
      : 'Mac 与 iPhone 已完成连接';
  const activationText = macs.length === 0
    ? '安装 Octrix Host，并在安装器打开的网页中登录；无需安装 Mac App。'
    : phones.length === 0
      ? '打开 iPhone 上的 Octrix 并登录，账号下的 Mac 会自动出现。'
      : '你的设备关系由账号统一管理，新增 Mac 也会自动同步到 iPhone。';
  return <Shell><main className="console">
    <div className="console-top"><div><span className="context-label">账号与设备</span><h1>你好，{data.user.name || data.user.primary_label}</h1><p>查看账号下的 Mac 与 iPhone，管理授权和登录安全。</p></div><div className="account-actions"><span className="avatar" aria-hidden="true">{data.user.picture_url ? <img src={data.user.picture_url} alt="" /> : data.user.primary_label.slice(0, 1).toUpperCase()}</span><button className="logout-button" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? '正在退出…' : '退出登录'}</button></div></div>
    {error && <div className="error console-error">{error}</div>}
    <nav className="tabs"><button className={tab === 'devices' ? 'active' : ''} onClick={() => setTab('devices')}>设备</button><button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>登录与安全</button></nav>
    {tab === 'devices' ? <div className="console-grid">
      <section className="panel span-two"><div className="panel-title"><div><span>Mac</span><h2>我的 Mac</h2></div><a href="/activate">使用设备码</a></div>{macs.length ? <div className="device-list">{macs.map(device => <DeviceRow key={device.id} device={device} onRename={() => void rename(device)} onRevoke={() => void revoke(device)} />)}</div> : <Empty title="还没有已授权的 Mac" text="先安装 Octrix Host，再在浏览器登录并授权这台 Mac。"><div className="empty-actions"><a className="button primary" href="/start">安装 Octrix Host</a></div></Empty>}</section>
      <section className="panel"><div className="panel-title"><div><span>iPhone</span><h2>移动设备</h2></div></div>{phones.length ? <div className="device-list">{phones.map(device => <DeviceRow key={device.id} device={device} onRename={() => void rename(device)} onRevoke={() => void revoke(device)} />)}</div> : <Empty title="还没有 iPhone" text="在 iPhone 打开 Octrix，并登录当前账号。"><a className="text-link" href="/start#iphone">查看 iPhone 登录步骤 →</a></Empty>}</section>
      <section className={`panel activation-panel ${macs.length > 0 && phones.length > 0 ? 'complete' : ''}`}><span>{macs.length > 0 && phones.length > 0 ? '连接完成' : '首次使用'}</span><h2>{activationTitle}</h2><p>{activationText}</p><a className="text-link" href="/start">打开完整指南 →</a></section>
    </div> : <Security data={data} reload={load} onDeleteAccount={deleteAccount} deletingAccount={deletingAccount} />}
  </main></Shell>;
}

function DeviceRow({ device, onRename, onRevoke }: { device: Device; onRename: () => void; onRevoke: () => void }) {
  const status = device.kind === 'mac' ? (device.online ? '在线' : '离线') : '已授权';
  return <div className="device-row"><span className="device-square">{device.kind === 'mac' ? '⌘' : '◉'}</span><div className="device-main"><b>{device.name}</b><small><i className={device.online ? 'online-dot' : 'muted-dot'} /> {status} · {device.last_seen_at ? `最近活动 ${relativeDate(device.last_seen_at)}` : '尚未连接'}</small></div><button onClick={onRename}>重命名</button><button className="danger-text" onClick={onRevoke}>撤销</button></div>;
}

function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state"><span>＋</span><b>{title}</b><p>{text}</p>{children}</div>;
}

export function Security({
  data,
  reload,
  onDeleteAccount = async () => {},
  deletingAccount = false,
}: {
  data: AccountPayload;
  reload: () => Promise<void>;
  onDeleteAccount?: () => Promise<void>;
  deletingAccount?: boolean;
}) {
  const [linkSms, setLinkSms] = useState(false);
  async function unlink(identity: Identity) {
    if (!window.confirm(`解除 ${identity.label}？其他登录会话将退出。`)) return;
    await api(`/api/v1/account/identities/${identity.id}`, { method: 'DELETE' }); await reload();
  }
  async function revokeSession(session: Session) {
    await api(`/api/v1/account/sessions/${session.id}`, { method: 'DELETE' }); await reload();
  }
  const hasGoogle = data.user.identities.some(item => item.provider === 'google');
  const hasApple = data.user.identities.some(item => item.provider === 'apple');
  const hasSms = data.user.identities.some(item => item.provider === 'sms');
  return <div className="console-grid"><section className="panel span-two"><div className="panel-title"><div><span>IDENTITIES</span><h2>登录方式</h2></div><div className="identity-actions">{data.auth_methods.apple && !hasApple && <a href="/auth/apple/start?mode=link&next=/dashboard">绑定 Apple</a>}{data.auth_methods.google && !hasGoogle && <a href="/auth/google/start?mode=link&next=/dashboard">绑定 Google</a>}{data.auth_methods.sms && !hasSms && <button className="text-button" onClick={() => setLinkSms(value => !value)}>绑定手机号</button>}</div></div><div className="identity-list">{data.user.identities.map(identity => <div key={identity.id}><span className="identity-icon">{identity.provider === 'apple' ? '' : identity.provider === 'google' ? 'G' : '86'}</span><div><b>{identity.provider === 'apple' ? 'Apple' : identity.provider === 'google' ? 'Google' : '短信验证'}</b><small>{identity.label}</small></div>{data.user.identities.length > 1 && <button className="danger-text" onClick={() => void unlink(identity)}>解除绑定</button>}</div>)}</div>{linkSms && <SmsLinkForm onDone={async () => { setLinkSms(false); await reload(); }} />}</section>
    <section className="panel"><div className="panel-title"><div><span>SESSIONS</span><h2>网页登录会话</h2></div></div><div className="session-list">{data.sessions.map(session => <div key={session.id}><div><b>{session.current ? '当前会话' : '浏览器会话'}</b><small>{relativeDate(session.created_at)} 登录</small></div>{!session.current && <button onClick={() => void revokeSession(session)}>退出</button>}</div>)}</div></section>
    <section className="panel"><div className="panel-title"><div><span>ACTIVITY</span><h2>最近授权记录</h2></div></div><div className="events">{data.events.slice(0, 8).map(event => <div key={event.id}><i /><span>{eventLabel(event.event_type)}</span><small>{relativeDate(event.created_at)}</small></div>)}</div></section>
    <section className="panel span-two danger-panel"><div><span>ACCOUNT DELETION</span><h2>永久删除账号</h2><p>删除 Octrix Cloud 中的账号、登录方式、设备授权、会话和访问凭证。不会删除 Mac 上的本地项目或第三方 AI 账号。</p></div><button className="danger-button" disabled={deletingAccount} onClick={() => void onDeleteAccount()}>{deletingAccount ? '正在删除…' : '删除账号'}</button></section>
  </div>;
}

export function SmsLinkForm({ onDone }: { onDone: () => Promise<void> }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!challengeId) {
        const result = await api<{ challenge_id: string }>('/api/v1/auth/sms/challenges', {
          method: 'POST', body: jsonBody({ phone, flow: 'link' }),
        });
        setChallengeId(result.challenge_id);
      } else {
        await api(`/api/v1/auth/sms/challenges/${challengeId}/verify`, {
          method: 'POST', body: jsonBody({ code }),
        });
        await onDone();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '绑定失败');
    } finally { setBusy(false); }
  }

  return <form className="sms-link-form" onSubmit={submit}>
    <label>{challengeId ? '输入 6 位短信验证码' : '绑定中国大陆手机号'}</label>
    {challengeId
      ? <input className="code-field sms-code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />
      : <div className="phone-field"><span>+86</span><input autoComplete="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="138 0000 0000" /></div>}
    {error && <div className="error">{error}</div>}
    <button className="button primary" disabled={busy || (challengeId ? code.length !== 6 : phone.length !== 11)}>{busy ? '正在处理…' : challengeId ? '验证并绑定' : '发送验证码'}</button>
  </form>;
}

function eventLabel(event: string): string {
  return ({ 'identity.used': '登录方式已使用', 'device.authorized': 'Mac 已授权', 'mobile.authorized': 'iPhone 已授权', 'device.revoked': '设备访问已撤销', 'device.renamed': '设备已重命名', 'identity.unlinked': '登录方式已解除' } as Record<string, string>)[event] ?? '账号活动';
}

function relativeDate(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function Activate() {
  const [code, setCode] = useState('');
  const [request, setRequest] = useState<{ device_name: string; expires_at: string } | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function find(event: FormEvent) {
    event.preventDefault(); setError('');
    try { setRequest(await api(`/api/v1/device-authorizations/resolve?code=${encodeURIComponent(code)}`)); }
    catch (error) { if (error instanceof ApiError && error.status === 401) window.location.assign(`/login?next=${encodeURIComponent(`/activate?code=${code}`)}`); else setError(error instanceof Error ? error.message : '查找失败'); }
  }
  async function decide(decision: 'approve' | 'deny') {
    try { await api('/api/v1/device-authorizations/decision', { method: 'POST', body: jsonBody({ code, decision }) }); setDone(true); setRequest(null); }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
  }
  return <ApprovalFrame eyebrow="输入设备码" title="授权一台 Mac" copy="输入终端中显示的 8 位代码。代码只可使用一次，并会在 10 分钟后失效。">
    {error && <div className="error">{error}</div>}{done ? <Success text="已完成处理，你可以关闭这个页面。" /> : request ? <DeviceApproval name={request.device_name} approve={() => void decide('approve')} deny={() => void decide('deny')} /> : <form onSubmit={find}><label>8 位设备码</label><input className="code-field" autoFocus value={formatDeviceCode(code)} onChange={event => setCode(normalizeDeviceCode(event.target.value))} placeholder="ABCD-EFGH" /><button className="button primary full" disabled={code.length !== 8}>继续</button></form>}
  </ApprovalFrame>;
}

function DeviceAuthorize() {
  const token = useMemo(() => new URLSearchParams(location.search).get('token') ?? '', []);
  return <TokenApproval kind="device" token={token} />;
}

function MobileAuthorize() {
  const token = useMemo(() => new URLSearchParams(location.search).get('token') ?? '', []);
  return <TokenApproval kind="mobile" token={token} />;
}

function TokenApproval({ kind, token }: { kind: 'device' | 'mobile'; token: string }) {
  const [request, setRequest] = useState<{ device_name: string } | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const endpoint = kind === 'device' ? '/api/v1/device-authorizations/resolve' : '/api/v1/mobile-authorizations/resolve';
    void api<{ device_name: string }>(`${endpoint}?token=${encodeURIComponent(token)}`).then(setRequest).catch(error => {
      if (error instanceof ApiError && error.status === 401) window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      else setError(error.message);
    });
  }, [kind, token]);
  async function decide(decision: 'approve' | 'deny') {
    const endpoint = kind === 'device' ? '/api/v1/device-authorizations/decision' : '/api/v1/mobile-authorizations/decision';
    try {
      const result = await api<{ callback_url?: string }>(endpoint, { method: 'POST', body: jsonBody({ token, decision }) });
      setDone(true); setRequest(null);
      if (result.callback_url) window.location.assign(result.callback_url);
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
  }
  return <ApprovalFrame eyebrow={kind === 'device' ? 'Mac 授权' : 'iPhone 授权'} title={kind === 'device' ? '允许这台 Mac 连接？' : '允许这台 iPhone 访问？'} copy="请只批准你正在使用且名称一致的设备。你可以稍后在授权中心撤销。">
    {error && <div className="error">{error}</div>}{done ? <Success text={kind === 'mobile' ? '正在返回 Octrix App…' : '授权已完成，请返回终端。'} /> : request ? <DeviceApproval name={request.device_name} approve={() => void decide('approve')} deny={() => void decide('deny')} /> : !error && <div className="loading-inline">正在读取授权请求…</div>}
  </ApprovalFrame>;
}

function ApprovalFrame({ eyebrow, title, copy, children }: { eyebrow: string; title: string; copy: string; children: ReactNode }) {
  return <Shell compact><main className="approval"><section><span className="context-label">{eyebrow}</span><h1>{title}</h1><p>{copy}</p><div className="approval-card">{children}</div><small>Octrix 不会通过邮件或短信向你索要设备码。</small></section></main></Shell>;
}

function DeviceApproval({ name, approve, deny }: { name: string; approve: () => void; deny: () => void }) {
  return <div className="device-approval"><span className="device-square large">⌘</span><div><small>申请连接的设备</small><h2>{name}</h2></div><button className="button primary full" onClick={approve}>允许连接</button><button className="button ghost full" onClick={deny}>拒绝</button></div>;
}

function Success({ text }: { text: string }) {
  return <div className="success"><span>✓</span><h2>处理完成</h2><p>{text}</p></div>;
}

function App() {
  const path = window.location.pathname;
  if (path === '/start') return <GettingStarted />;
  if (path === '/privacy') return <PrivacyPolicy />;
  if (path === '/login') return <Login next={safeNext(new URLSearchParams(location.search).get('next'))} />;
  if (path === '/dashboard' || path === '/account') return <Dashboard />;
  if (path === '/activate') return <Activate />;
  if (path === '/authorize/device') return <DeviceAuthorize />;
  if (path === '/authorize/mobile') return <MobileAuthorize />;
  return <Landing />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
