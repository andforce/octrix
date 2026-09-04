export type AgentPlatform =
  | 'claude-code'
  | 'openclaude'
  | 'opencode'
  | 'github-copilot-cli'
  | 'gemini-cli'
  | 'openai-codex-cli'
  | 'cursor-cli'
  | 'kiro-cli'
  | 'qoder-cli'
  | 'codebuddy-cli';

export interface SupportedAgentDefinition {
  platform: AgentPlatform;
  name: string;
  command: string;
  cliLabel: string;
  description: string;
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /** Public URL under `client/web/public/logos/` (.svg / .png / .jpg); shown in ContactsModal instead of the initial letter */
  logoUrl?: string;
}

function agentLogoUrl(platform: AgentPlatform): string {
  // Vite injects import.meta.env in the browser; Node (e.g. server importing this file) does not.
  const base = import.meta.env?.BASE_URL ?? '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (platform === 'openai-codex-cli') {
    return `${prefix}logos/openai-codex-cli.jpg`;
  }
  if (platform === 'claude-code' || platform === 'openclaude') {
    return `${prefix}logos/claude-code.png`;
  }
  if (platform === 'gemini-cli') {
    return `${prefix}logos/gemini-cli.png`;
  }
  if (platform === 'cursor-cli') {
    return `${prefix}logos/cursor-cli.png`;
  }
  if (platform === 'qoder-cli') {
    return `${prefix}logos/qoder-cli.png`;
  }
  return `${prefix}logos/${platform}.svg`;
}

const mk = (def: Omit<SupportedAgentDefinition, 'logoUrl'>): SupportedAgentDefinition => ({
  ...def,
  logoUrl: agentLogoUrl(def.platform),
});

export const SUPPORTED_AGENTS: SupportedAgentDefinition[] = [
  mk({
    platform: 'claude-code',
    name: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    cliLabel: 'claude',
    description: '已适配会话采集',
    executable: 'claude',
    args: ['--permission-mode', 'bypassPermissions'],
  }),
  mk({
    platform: 'openclaude',
    name: 'OpenClaude',
    command: 'openclaude --permission-mode bypassPermissions',
    cliLabel: 'openclaude',
    description: 'Claude Code 兼容 CLI',
    executable: 'openclaude',
    args: ['--permission-mode', 'bypassPermissions'],
  }),
  mk({
    platform: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    cliLabel: 'opencode',
    description: '已适配会话采集',
    executable: 'opencode',
    args: [],
  }),
  mk({
    platform: 'github-copilot-cli',
    name: 'GitHub Copilot CLI',
    command: 'copilot --yolo',
    cliLabel: 'copilot',
    description: '已适配会话采集',
    executable: 'copilot',
    args: ['--yolo'],
  }),
  mk({
    platform: 'gemini-cli',
    name: 'Gemini CLI',
    command: 'gemini --yolo',
    cliLabel: 'gemini',
    description: '已适配会话采集',
    executable: 'gemini',
    args: ['--yolo'],
  }),
  mk({
    platform: 'openai-codex-cli',
    name: 'Codex CLI',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    cliLabel: 'codex',
    description: '已适配会话采集',
    executable: 'codex',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
  }),
  mk({
    platform: 'cursor-cli',
    name: 'Cursor CLI',
    command: 'agent --yolo',
    cliLabel: 'agent',
    description: '已适配会话采集',
    executable: 'agent',
    args: ['--yolo'],
  }),
  mk({
    platform: 'kiro-cli',
    name: 'Kiro CLI',
    command: 'kiro-cli chat --trust-all-tools',
    cliLabel: 'kiro-cli',
    description: '已适配会话采集',
    executable: 'kiro-cli',
    args: ['chat', '--trust-all-tools'],
  }),
  mk({
    platform: 'qoder-cli',
    name: 'Qoder CLI',
    command: 'qodercli --dangerously-skip-permissions',
    cliLabel: 'qodercli',
    description: '已适配会话采集',
    executable: 'qodercli',
    args: ['--dangerously-skip-permissions'],
  }),
  mk({
    platform: 'codebuddy-cli',
    name: 'CodeBuddy',
    command: 'codebuddy --permission-mode bypassPermissions',
    cliLabel: 'codebuddy',
    description: '已适配会话采集',
    executable: 'codebuddy',
    args: ['--permission-mode', 'bypassPermissions'],
  }),
];

export const ENABLED_AGENT_PLATFORMS = [
  'openai-codex-cli',
  'openclaude',
  'claude-code',
  'opencode',
  'github-copilot-cli',
  'gemini-cli',
  'cursor-cli',
  'kiro-cli',
  'qoder-cli',
  'codebuddy-cli',
] as const satisfies readonly AgentPlatform[];

const ENABLED_AGENT_PLATFORM_SET = new Set<AgentPlatform>(ENABLED_AGENT_PLATFORMS);

export const ENABLED_AGENTS: SupportedAgentDefinition[] = ENABLED_AGENT_PLATFORMS.map((platform) => {
  const agent = SUPPORTED_AGENTS.find(candidate => candidate.platform === platform);
  if (!agent) throw new Error(`Enabled agent platform is not supported: ${platform}`);
  return agent;
});

export const SUPPORTED_AGENT_MAP: Record<AgentPlatform, SupportedAgentDefinition> = SUPPORTED_AGENTS.reduce(
  (acc, agent) => {
    acc[agent.platform] = agent;
    return acc;
  },
  {} as Record<AgentPlatform, SupportedAgentDefinition>,
);

export function isSupportedAgentPlatform(value: unknown): value is AgentPlatform {
  return typeof value === 'string' && value in SUPPORTED_AGENT_MAP;
}

export function isEnabledAgentPlatform(value: unknown): value is AgentPlatform {
  return typeof value === 'string' && ENABLED_AGENT_PLATFORM_SET.has(value as AgentPlatform);
}

export function getSupportedAgent(platform: AgentPlatform): SupportedAgentDefinition {
  return SUPPORTED_AGENT_MAP[platform];
}

const FULL_BLEED_AGENT_LOGO_PLATFORMS = new Set<AgentPlatform>([
  'claude-code',
  'openclaude',
  'cursor-cli',
  'kiro-cli',
  'qoder-cli',
  'codebuddy-cli',
  'openai-codex-cli',
]);

/** Logos that should fill the circular frame (cover, no padding) vs letterboxed contain. */
export function isFullBleedAgentLogo(platform: AgentPlatform): boolean {
  return FULL_BLEED_AGENT_LOGO_PLATFORMS.has(platform);
}

/** Tailwind classes for `<img>` inside a circular agent logo frame (modals, member rows). */
export function agentLogoImageClassName(platform: AgentPlatform): string {
  return isFullBleedAgentLogo(platform)
    ? 'h-full w-full object-cover object-center'
    : 'box-border h-full w-full p-1 object-contain object-center';
}
