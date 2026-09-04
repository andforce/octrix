import type { AgentPlatform } from '../src/agent-platforms.js';
import type { CliCommandItem } from '../src/types.js';

function command(
  platform: AgentPlatform,
  name: string,
  description: string,
  options?: {
    aliases?: string[];
    argumentHint?: string;
    insertText?: string;
  },
): CliCommandItem {
  return {
    id: `${platform}:${name}`,
    platform,
    name,
    description,
    insertText: options?.insertText ?? `/${name}`,
    aliases: options?.aliases,
    argumentHint: options?.argumentHint,
  };
}

function aliasCommand(
  platform: AgentPlatform,
  alias: 'clear' | 'compact' | 'new',
  description: string,
): CliCommandItem {
  return {
    id: `${platform}:compat:${alias}`,
    platform,
    name: alias,
    description,
    insertText: `/${alias}`,
  };
}

const EMPTY_COMMANDS: Record<AgentPlatform, CliCommandItem[]> = {
  'claude-code': [],
  openclaude: [],
  opencode: [],
  'github-copilot-cli': [],
  'gemini-cli': [],
  'openai-codex-cli': [],
  'cursor-cli': [],
  'kiro-cli': [],
  'qoder-cli': [],
  'codebuddy-cli': [],
};

const COMMANDS_BY_PLATFORM: Record<AgentPlatform, CliCommandItem[]> = {
  ...EMPTY_COMMANDS,
  'claude-code': [
    command('claude-code', 'add-dir', '为当前会话添加可访问工作目录', { argumentHint: '<path>' }),
    command('claude-code', 'agents', '管理 agent 配置'),
    command('claude-code', 'btw', '提出一个不打断主流程的侧边问题', { argumentHint: '<question>' }),
    command('claude-code', 'chrome', '配置 Claude in Chrome 设置'),
    command('claude-code', 'clear', '清空会话历史并释放上下文', { aliases: ['reset', 'new'] }),
    command('claude-code', 'color', '设置当前会话提示栏颜色', { argumentHint: '[color|default]' }),
    command('claude-code', 'compact', '压缩当前对话，可附带聚焦说明', { argumentHint: '[instructions]' }),
    command('claude-code', 'config', '打开设置界面', { aliases: ['settings'] }),
    command('claude-code', 'context', '可视化当前上下文使用情况'),
    command('claude-code', 'copy', '复制最近一次助手回复', { argumentHint: '[N]' }),
    command('claude-code', 'cost', '显示 token 使用统计'),
    command('claude-code', 'desktop', '在桌面应用中继续当前会话', { aliases: ['app'] }),
    command('claude-code', 'diff', '打开未提交改动与每轮改动的交互式 diff'),
    command('claude-code', 'doctor', '诊断并校验 Claude Code 安装与设置'),
    command('claude-code', 'effort', '设置模型 effort level', {
      argumentHint: '[low|medium|high|max|auto]',
    }),
    command('claude-code', 'exit', '退出 CLI', { aliases: ['quit'] }),
    command('claude-code', 'export', '导出当前对话为文本', { argumentHint: '[filename]' }),
    command('claude-code', 'extra-usage', '配置额外使用额度'),
    command('claude-code', 'fast', '切换 fast mode', { argumentHint: '[on|off]' }),
    command('claude-code', 'feedback', '提交 Claude Code 反馈', { argumentHint: '[report]', aliases: ['bug'] }),
    command('claude-code', 'branch', '从当前对话分支创建新会话', { argumentHint: '[name]', aliases: ['fork'] }),
    command('claude-code', 'help', '显示帮助与可用命令'),
    command('claude-code', 'hooks', '查看 hook 配置'),
    command('claude-code', 'ide', '管理 IDE 集成并查看状态'),
    command('claude-code', 'init', '初始化项目并生成 CLAUDE.md 指南'),
    command('claude-code', 'insights', '生成 Claude Code 使用分析报告'),
    command('claude-code', 'install-github-app', '配置 Claude GitHub Actions 应用'),
    command('claude-code', 'install-slack-app', '安装 Claude Slack 应用'),
    command('claude-code', 'keybindings', '打开或创建快捷键配置文件'),
    command('claude-code', 'login', '登录 Anthropic 账号'),
    command('claude-code', 'logout', '退出 Anthropic 账号'),
    command('claude-code', 'mcp', '管理 MCP 服务连接与 OAuth'),
    command('claude-code', 'memory', '编辑 CLAUDE.md memory 文件与 auto-memory'),
    command('claude-code', 'mobile', '显示下载 Claude 手机 App 的二维码', { aliases: ['ios', 'android'] }),
    command('claude-code', 'model', '选择或切换 AI 模型', { argumentHint: '[model]' }),
    command('claude-code', 'passes', '分享 Claude Code 免费体验周'),
    command('claude-code', 'permissions', '管理工具权限规则', { aliases: ['allowed-tools'] }),
    command('claude-code', 'plan', '直接进入 plan mode', { argumentHint: '[description]' }),
    command('claude-code', 'plugin', '管理 Claude Code 插件'),
    command('claude-code', 'powerup', '通过交互式课程了解 Claude Code 功能'),
    command('claude-code', 'privacy-settings', '查看并更新隐私设置'),
    command('claude-code', 'release-notes', '查看版本更新说明'),
    command('claude-code', 'reload-plugins', '重新加载活动插件'),
    command('claude-code', 'remote-control', '允许从 claude.ai 远程控制当前会话', { aliases: ['rc'] }),
    command('claude-code', 'remote-env', '配置 web remote 会话的默认环境'),
    command('claude-code', 'rename', '重命名当前会话', { argumentHint: '[name]' }),
    command('claude-code', 'resume', '按 ID 或名称恢复会话', { argumentHint: '[session]', aliases: ['continue'] }),
    command('claude-code', 'review', '已弃用，官方建议改用 code-review 插件'),
    command('claude-code', 'rewind', '回退对话与/或代码到之前节点', { aliases: ['checkpoint'] }),
    command('claude-code', 'sandbox', '切换 sandbox mode'),
    command('claude-code', 'schedule', '创建、更新、列出或运行 Cloud scheduled tasks', {
      argumentHint: '[description]',
    }),
    command('claude-code', 'security-review', '审查当前分支待提交改动中的安全问题'),
    command('claude-code', 'setup-bedrock', '配置 Amazon Bedrock 认证与模型设置'),
    command('claude-code', 'skills', '列出可用 skills'),
    command('claude-code', 'stats', '可视化每日使用、会话历史与模型偏好'),
    command('claude-code', 'status', '打开状态页查看版本、模型、账号与连接信息'),
    command('claude-code', 'statusline', '配置 Claude Code 状态栏', { argumentHint: '[description]' }),
    command('claude-code', 'stickers', '订购 Claude Code 贴纸'),
    command('claude-code', 'tasks', '列出并管理后台任务', { aliases: ['bashes'] }),
    command('claude-code', 'terminal-setup', '配置 Shift+Enter 等终端快捷键'),
    command('claude-code', 'theme', '切换颜色主题'),
    command('claude-code', 'ultraplan', '在 ultraplan 会话中起草计划', { argumentHint: '<prompt>' }),
    command('claude-code', 'upgrade', '打开升级页面切换更高套餐'),
    command('claude-code', 'usage', '查看套餐使用上限与速率限制状态'),
    command('claude-code', 'voice', '切换按住说话语音输入'),
  ],
  'github-copilot-cli': [
    command('github-copilot-cli', 'add-dir', '添加额外目录到允许访问范围', { argumentHint: '<path>' }),
    command('github-copilot-cli', 'agent', '浏览并选择可用 agents'),
    command('github-copilot-cli', 'allow-all', '启用全部权限', { aliases: ['yolo'] }),
    command('github-copilot-cli', 'clear', '开始一个新会话', { argumentHint: '[prompt]' }),
    command('github-copilot-cli', 'new', '开始一个新会话', { argumentHint: '[prompt]' }),
    command('github-copilot-cli', 'compact', '压缩并总结当前对话上下文'),
    command('github-copilot-cli', 'context', '查看上下文窗口 token 使用情况'),
    command('github-copilot-cli', 'cwd', '显示当前工作目录'),
    command('github-copilot-cli', 'cd', '切换工作目录', { argumentHint: '[path]' }),
    command('github-copilot-cli', 'diff', '查看当前目录改动'),
    command('github-copilot-cli', 'delegate', '委派任务并生成 PR', { argumentHint: '[prompt]' }),
    command('github-copilot-cli', 'exit', '退出 CLI', { aliases: ['quit'] }),
    command('github-copilot-cli', 'experimental', '切换或设置实验功能开关', {
      argumentHint: '[on|off]',
    }),
    command('github-copilot-cli', 'feedback', '提交关于 Copilot CLI 的反馈'),
    command('github-copilot-cli', 'fleet', '并行执行子任务', { argumentHint: '[prompt]' }),
    command('github-copilot-cli', 'help', '显示 GitHub Copilot CLI 交互命令帮助'),
    command('github-copilot-cli', 'ide', '连接到 IDE 工作区'),
    command('github-copilot-cli', 'init', '为当前仓库初始化 Copilot 自定义指令与 agent 能力'),
    command('github-copilot-cli', 'list-dirs', '显示所有已允许访问的目录'),
    command('github-copilot-cli', 'login', '登录 Copilot'),
    command('github-copilot-cli', 'logout', '退出 Copilot 登录'),
    command('github-copilot-cli', 'lsp', '管理语言服务器配置', {
      argumentHint: '[show|test|reload|help] [server-name]',
    }),
    command('github-copilot-cli', 'lsp show', '显示语言服务器配置', { insertText: '/lsp show' }),
    command('github-copilot-cli', 'lsp test', '测试语言服务器配置', {
      argumentHint: '[server-name]',
      insertText: '/lsp test',
    }),
    command('github-copilot-cli', 'lsp reload', '重新加载语言服务器配置', { insertText: '/lsp reload' }),
    command('github-copilot-cli', 'lsp help', '显示语言服务器帮助', { insertText: '/lsp help' }),
    command('github-copilot-cli', 'mcp', '管理 MCP 服务配置', {
      argumentHint: '[show|add|edit|delete|disable|enable] [server-name]',
    }),
    command('github-copilot-cli', 'mcp show', '显示 MCP 服务配置', { insertText: '/mcp show' }),
    command('github-copilot-cli', 'mcp add', '添加 MCP 服务配置', {
      argumentHint: '[server-name]',
      insertText: '/mcp add',
    }),
    command('github-copilot-cli', 'mcp edit', '编辑 MCP 服务配置', {
      argumentHint: '[server-name]',
      insertText: '/mcp edit',
    }),
    command('github-copilot-cli', 'mcp delete', '删除 MCP 服务配置', {
      argumentHint: '[server-name]',
      insertText: '/mcp delete',
    }),
    command('github-copilot-cli', 'mcp disable', '禁用 MCP 服务配置', {
      argumentHint: '[server-name]',
      insertText: '/mcp disable',
    }),
    command('github-copilot-cli', 'mcp enable', '启用 MCP 服务配置', {
      argumentHint: '[server-name]',
      insertText: '/mcp enable',
    }),
    command('github-copilot-cli', 'model', '选择当前 AI 模型'),
    command('github-copilot-cli', 'models', '列出并切换 AI 模型', { argumentHint: '[model]' }),
    command('github-copilot-cli', 'plan', '编码前先生成实现计划', { argumentHint: '[prompt]' }),
    command('github-copilot-cli', 'plugin', '管理插件与插件市场', {
      argumentHint: '[marketplace|install|uninstall|update|list] [args...]',
    }),
    command('github-copilot-cli', 'plugin marketplace', '管理插件市场', { insertText: '/plugin marketplace' }),
    command('github-copilot-cli', 'plugin install', '安装插件', {
      argumentHint: '[args...]',
      insertText: '/plugin install',
    }),
    command('github-copilot-cli', 'plugin uninstall', '卸载插件', {
      argumentHint: '[args...]',
      insertText: '/plugin uninstall',
    }),
    command('github-copilot-cli', 'plugin update', '更新插件', {
      argumentHint: '[args...]',
      insertText: '/plugin update',
    }),
    command('github-copilot-cli', 'plugin list', '列出已安装插件', { insertText: '/plugin list' }),
    command('github-copilot-cli', 'rename', '重命名当前会话', { argumentHint: '<name>' }),
    command('github-copilot-cli', 'reset-allowed-tools', '重置已允许工具列表'),
    command('github-copilot-cli', 'resume', '恢复或切换历史会话', { argumentHint: '[session-id]' }),
    command('github-copilot-cli', 'review', '运行 code review agent 分析改动', {
      argumentHint: '[prompt]',
    }),
    command('github-copilot-cli', 'session', '查看当前会话信息与工作区摘要'),
    command('github-copilot-cli', 'session checkpoints', '查看会话检查点信息', {
      argumentHint: '[n]',
      insertText: '/session checkpoints',
    }),
    command('github-copilot-cli', 'session files', '查看会话相关文件摘要', {
      insertText: '/session files',
    }),
    command('github-copilot-cli', 'session plan', '查看当前会话计划', {
      insertText: '/session plan',
    }),
    command('github-copilot-cli', 'session rename', '通过 session 子命令重命名会话', {
      argumentHint: '<name>',
      insertText: '/session rename',
    }),
    command('github-copilot-cli', 'share', '将会话分享到 Markdown 文件或 GitHub gist', {
      argumentHint: '[file|gist] [path]',
    }),
    command('github-copilot-cli', 'share file', '将会话导出到 Markdown 文件', {
      argumentHint: '[path]',
      insertText: '/share file',
    }),
    command('github-copilot-cli', 'share gist', '将会话分享到 GitHub gist', {
      argumentHint: '[path]',
      insertText: '/share gist',
    }),
    command('github-copilot-cli', 'skills', '管理 Skills 能力扩展', {
      argumentHint: '[list|info|add|remove|reload] [args...]',
    }),
    command('github-copilot-cli', 'skills list', '列出可用 Skills', { insertText: '/skills list' }),
    command('github-copilot-cli', 'skills info', '查看 Skill 详情', {
      argumentHint: '[args...]',
      insertText: '/skills info',
    }),
    command('github-copilot-cli', 'skills add', '添加 Skill', {
      argumentHint: '[args...]',
      insertText: '/skills add',
    }),
    command('github-copilot-cli', 'skills remove', '移除 Skill', {
      argumentHint: '[args...]',
      insertText: '/skills remove',
    }),
    command('github-copilot-cli', 'skills reload', '重新加载 Skills', { insertText: '/skills reload' }),
    command('github-copilot-cli', 'terminal-setup', '配置终端多行输入快捷键'),
    command('github-copilot-cli', 'theme', '查看或设置终端主题', {
      argumentHint: '[show|set|list] [auto|theme-id]',
    }),
    command('github-copilot-cli', 'theme show', '显示当前终端主题', { insertText: '/theme show' }),
    command('github-copilot-cli', 'theme set', '设置终端主题', {
      argumentHint: '[auto|theme-id]',
      insertText: '/theme set',
    }),
    command('github-copilot-cli', 'theme list', '列出可用终端主题', { insertText: '/theme list' }),
    command('github-copilot-cli', 'usage', '显示会话使用统计'),
    command('github-copilot-cli', 'user', '管理当前 GitHub 用户', {
      argumentHint: '[show|list|switch]',
    }),
    command('github-copilot-cli', 'user show', '显示当前 GitHub 用户', { insertText: '/user show' }),
    command('github-copilot-cli', 'user list', '列出可切换的 GitHub 用户', { insertText: '/user list' }),
    command('github-copilot-cli', 'user switch', '切换 GitHub 用户', {
      insertText: '/user switch',
    }),
  ],
  'gemini-cli': [
    command('gemini-cli', 'about', '查看版本与环境信息'),
    command('gemini-cli', 'agents', '管理本地与远程 subagents'),
    command('gemini-cli', 'agents list', '列出所有已发现的 agents', { insertText: '/agents list' }),
    command('gemini-cli', 'agents reload', '重新扫描并刷新 agent 注册表', {
      aliases: ['refresh'],
      insertText: '/agents reload',
    }),
    command('gemini-cli', 'agents enable', '启用指定 agent', {
      argumentHint: '<agent-name>',
      insertText: '/agents enable',
    }),
    command('gemini-cli', 'agents disable', '禁用指定 agent', {
      argumentHint: '<agent-name>',
      insertText: '/agents disable',
    }),
    command('gemini-cli', 'agents config', '配置指定 agent 的模型与执行限制', {
      argumentHint: '<agent-name>',
      insertText: '/agents config',
    }),
    command('gemini-cli', 'auth', '切换认证方式'),
    command('gemini-cli', 'bug', '提交 Gemini CLI 问题反馈', { argumentHint: '[title]' }),
    command('gemini-cli', 'chat', '浏览或恢复会话，也可管理手动检查点'),
    command('gemini-cli', 'chat list', '列出当前项目中的手动会话检查点', { insertText: '/chat list' }),
    command('gemini-cli', 'chat save', '保存当前会话检查点', { argumentHint: '<tag>', insertText: '/chat save' }),
    command('gemini-cli', 'chat resume', '恢复指定会话检查点', {
      argumentHint: '<tag>',
      insertText: '/chat resume',
    }),
    command('gemini-cli', 'chat delete', '删除指定会话检查点', {
      argumentHint: '<tag>',
      insertText: '/chat delete',
    }),
    command('gemini-cli', 'chat share', '导出当前会话到 Markdown 或 JSON', {
      argumentHint: '[filename]',
      insertText: '/chat share',
    }),
    command('gemini-cli', 'chat debug', '导出最近一次 API 请求的 JSON 负载', {
      insertText: '/chat debug',
    }),
    command('gemini-cli', 'clear', '清空终端可见历史'),
    command('gemini-cli', 'commands', '管理从 .toml 加载的自定义 slash 命令'),
    command('gemini-cli', 'commands reload', '重新加载所有自定义命令定义', {
      insertText: '/commands reload',
    }),
    command('gemini-cli', 'compress', '将完整上下文压缩为摘要以节省 token'),
    command('gemini-cli', 'copy', '复制最近一次 Gemini CLI 输出到剪贴板'),
    command('gemini-cli', 'directory', '管理多目录工作区', { aliases: ['dir'] }),
    command('gemini-cli', 'directory add', '向工作区添加目录', {
      argumentHint: '<path1>,<path2>',
      insertText: '/directory add',
    }),
    command('gemini-cli', 'directory show', '显示已加入工作区的目录', {
      insertText: '/directory show',
    }),
    command('gemini-cli', 'docs', '在浏览器中打开 Gemini CLI 文档'),
    command('gemini-cli', 'editor', '打开编辑器选择对话框'),
    command('gemini-cli', 'extensions', '管理扩展'),
    command('gemini-cli', 'extensions config', '配置扩展设置', { insertText: '/extensions config' }),
    command('gemini-cli', 'extensions disable', '禁用扩展', {
      argumentHint: '<name>',
      insertText: '/extensions disable',
    }),
    command('gemini-cli', 'extensions enable', '启用扩展', {
      argumentHint: '<name>',
      insertText: '/extensions enable',
    }),
    command('gemini-cli', 'extensions explore', '在浏览器中打开扩展页面', {
      insertText: '/extensions explore',
    }),
    command('gemini-cli', 'extensions install', '从 git 仓库或本地路径安装扩展', {
      argumentHint: '<repo-or-path>',
      insertText: '/extensions install',
    }),
    command('gemini-cli', 'extensions link', '从本地路径链接扩展', {
      argumentHint: '<path>',
      insertText: '/extensions link',
    }),
    command('gemini-cli', 'extensions list', '列出当前激活的扩展', { insertText: '/extensions list' }),
    command('gemini-cli', 'extensions restart', '重启所有扩展', { insertText: '/extensions restart' }),
    command('gemini-cli', 'extensions uninstall', '卸载扩展', {
      argumentHint: '<name>',
      insertText: '/extensions uninstall',
    }),
    command('gemini-cli', 'extensions update', '更新扩展', {
      argumentHint: '[--all]',
      insertText: '/extensions update',
    }),
    command('gemini-cli', 'help', '显示 Gemini CLI 帮助', { aliases: ['?'] }),
    command('gemini-cli', 'hooks', '管理生命周期 hooks'),
    command('gemini-cli', 'hooks list', '显示已注册 hooks 与状态', {
      aliases: ['show', 'panel'],
      insertText: '/hooks list',
    }),
    command('gemini-cli', 'hooks enable', '启用指定 hook', {
      argumentHint: '<hook-name>',
      insertText: '/hooks enable',
    }),
    command('gemini-cli', 'hooks disable', '禁用指定 hook', {
      argumentHint: '<hook-name>',
      insertText: '/hooks disable',
    }),
    command('gemini-cli', 'hooks enable-all', '启用全部已禁用 hooks', {
      insertText: '/hooks enable-all',
    }),
    command('gemini-cli', 'hooks disable-all', '禁用全部已启用 hooks', {
      insertText: '/hooks disable-all',
    }),
    command('gemini-cli', 'ide', '管理 IDE 集成'),
    command('gemini-cli', 'ide enable', '启用 IDE 集成', { insertText: '/ide enable' }),
    command('gemini-cli', 'ide disable', '禁用 IDE 集成', { insertText: '/ide disable' }),
    command('gemini-cli', 'ide install', '安装 IDE 伴随组件', { insertText: '/ide install' }),
    command('gemini-cli', 'ide status', '查看 IDE 集成状态', { insertText: '/ide status' }),
    command('gemini-cli', 'init', '分析当前目录并生成 GEMINI.md'),
    command('gemini-cli', 'mcp', '管理已配置的 MCP 服务'),
    command('gemini-cli', 'mcp auth', '对支持 OAuth 的 MCP 服务发起认证', {
      argumentHint: '[server-name]',
      insertText: '/mcp auth',
    }),
    command('gemini-cli', 'mcp list', '列出已配置的 MCP 服务与工具', {
      aliases: ['ls'],
      insertText: '/mcp list',
    }),
    command('gemini-cli', 'mcp desc', '列出 MCP 服务与工具说明', { insertText: '/mcp desc' }),
    command('gemini-cli', 'mcp enable', '启用已禁用的 MCP 服务', {
      argumentHint: '<server-name>',
      insertText: '/mcp enable',
    }),
    command('gemini-cli', 'mcp disable', '禁用 MCP 服务', {
      argumentHint: '<server-name>',
      insertText: '/mcp disable',
    }),
    command('gemini-cli', 'mcp reload', '重新加载全部 MCP 服务并重新发现工具', {
      insertText: '/mcp reload',
    }),
    command('gemini-cli', 'mcp schema', '列出 MCP 服务、工具与 schema', {
      insertText: '/mcp schema',
    }),
    command('gemini-cli', 'memory', '管理来自 GEMINI.md 的层级记忆'),
    command('gemini-cli', 'memory add', '向记忆中追加内容', { argumentHint: '<text>', insertText: '/memory add' }),
    command('gemini-cli', 'memory list', '列出当前生效的 GEMINI.md 路径', { insertText: '/memory list' }),
    command('gemini-cli', 'memory refresh', '重新加载所有 GEMINI.md 记忆内容', {
      insertText: '/memory refresh',
    }),
    command('gemini-cli', 'memory show', '显示当前加载的完整层级记忆', { insertText: '/memory show' }),
    command('gemini-cli', 'model', '管理模型配置'),
    command('gemini-cli', 'model manage', '打开模型配置对话框', { insertText: '/model manage' }),
    command('gemini-cli', 'model set', '设置要使用的模型', {
      argumentHint: '<model-name> [--persist]',
      insertText: '/model set',
    }),
    command('gemini-cli', 'permissions', '管理目录信任与其他权限'),
    command('gemini-cli', 'permissions trust', '管理目录信任设置', {
      argumentHint: '[directory-path]',
      insertText: '/permissions trust',
    }),
    command('gemini-cli', 'plan', '切换到 Plan Mode 并查看当前计划'),
    command('gemini-cli', 'plan copy', '复制已批准的计划到剪贴板', { insertText: '/plan copy' }),
    command('gemini-cli', 'policies', '管理 policies'),
    command('gemini-cli', 'policies list', '按模式列出当前激活的 policies', {
      insertText: '/policies list',
    }),
    command('gemini-cli', 'privacy', '查看并设置隐私数据收集选项'),
    command('gemini-cli', 'quit', '退出 Gemini CLI', { aliases: ['exit'] }),
    command('gemini-cli', 'restore', '恢复到某次工具调用前的项目文件状态', {
      argumentHint: '[tool_call_id]',
    }),
    command('gemini-cli', 'rewind', '回退历史并可选择回滚代码改动'),
    command('gemini-cli', 'resume', '浏览并恢复历史会话，也可管理手动检查点'),
    command('gemini-cli', 'resume list', '列出可用的手动会话检查点', { insertText: '/resume list' }),
    command('gemini-cli', 'resume save', '将当前会话保存为带标签的检查点', {
      argumentHint: '<tag>',
      insertText: '/resume save',
    }),
    command('gemini-cli', 'resume resume', '恢复带标签的会话检查点', {
      aliases: ['load'],
      argumentHint: '<tag>',
      insertText: '/resume resume',
    }),
    command('gemini-cli', 'resume delete', '删除带标签的会话检查点', {
      argumentHint: '<tag>',
      insertText: '/resume delete',
    }),
    command('gemini-cli', 'resume share', '导出当前会话到 Markdown 或 JSON', {
      argumentHint: '[filename]',
      insertText: '/resume share',
    }),
    command('gemini-cli', 'resume debug', '导出最近一次 API 请求的 JSON 负载', {
      insertText: '/resume debug',
    }),
    command('gemini-cli', 'settings', '打开设置编辑器'),
    command('gemini-cli', 'shells', '切换后台 shells 视图', { aliases: ['bashes'] }),
    command('gemini-cli', 'setup-github', '为 Gemini 配置 GitHub Actions 工作流'),
    command('gemini-cli', 'skills', '管理 Agent Skills'),
    command('gemini-cli', 'skills list', '列出所有已发现的 Skills 及状态', {
      insertText: '/skills list',
    }),
    command('gemini-cli', 'skills reload', '刷新所有层级的 Skill 列表', {
      insertText: '/skills reload',
    }),
    command('gemini-cli', 'skills enable', '启用指定 Skill', {
      argumentHint: '<name>',
      insertText: '/skills enable',
    }),
    command('gemini-cli', 'skills disable', '禁用指定 Skill', {
      argumentHint: '<name>',
      insertText: '/skills disable',
    }),
    command('gemini-cli', 'stats', '显示当前会话统计信息'),
    command('gemini-cli', 'stats session', '查看会话级统计', { insertText: '/stats session' }),
    command('gemini-cli', 'stats model', '查看模型级统计', { insertText: '/stats model' }),
    command('gemini-cli', 'stats tools', '查看工具级统计', { insertText: '/stats tools' }),
    command('gemini-cli', 'terminal-setup', '配置多行输入相关终端快捷键'),
    command('gemini-cli', 'theme', '打开主题切换对话框'),
    command('gemini-cli', 'tools', '显示当前可用工具列表', { argumentHint: '[desc]' }),
    command('gemini-cli', 'tools desc', '显示工具名称与详细说明', { insertText: '/tools desc' }),
    command('gemini-cli', 'tools nodesc', '仅显示工具名称并隐藏说明', { insertText: '/tools nodesc' }),
    command('gemini-cli', 'upgrade', '在浏览器中打开 Gemini Code Assist 升级页'),
    command('gemini-cli', 'vim', '切换 Vim 模式开关'),
  ],
  'openai-codex-cli': [
    command('openai-codex-cli', 'permissions', '设置 Codex 在无需确认时可执行的操作范围', {
      aliases: ['approvals'],
    }),
    command('openai-codex-cli', 'sandbox-add-read-dir', '为额外目录授予沙箱只读权限，仅原生 Windows 可用', {
      argumentHint: '<absolute-dir>',
    }),
    command('openai-codex-cli', 'agent', '切换当前激活的 agent 线程'),
    command('openai-codex-cli', 'apps', '浏览可用 apps/connectors 并插入到提示中'),
    command('openai-codex-cli', 'clear', '清空终端并启动全新对话'),
    command('openai-codex-cli', 'compact', '总结可见对话以释放上下文 token'),
    command('openai-codex-cli', 'copy', '复制最近一次已完成的 Codex 输出'),
    command('openai-codex-cli', 'diff', '查看当前工作区 diff，含未跟踪文件'),
    command('openai-codex-cli', 'exit', '退出 CLI', { aliases: ['quit'] }),
    command('openai-codex-cli', 'experimental', '切换实验性功能开关'),
    command('openai-codex-cli', 'feedback', '向 Codex 维护者发送反馈与日志'),
    command('openai-codex-cli', 'init', '在当前目录生成 AGENTS.md 脚手架'),
    command('openai-codex-cli', 'logout', '退出 Codex 登录'),
    command('openai-codex-cli', 'mcp', '列出当前会话已配置的 MCP 工具'),
    command('openai-codex-cli', 'mention', '将文件或目录附加到当前对话', {
      argumentHint: '<path>',
    }),
    command('openai-codex-cli', 'model', '选择当前激活模型与可用的 reasoning effort'),
    command('openai-codex-cli', 'fast', '切换 GPT-5.4 的 Fast mode', { argumentHint: '[on|off|status]' }),
    command('openai-codex-cli', 'plan', '切换到 plan mode，并可附带首条规划提示', {
      argumentHint: '[prompt]',
    }),
    command('openai-codex-cli', 'personality', '设置响应沟通风格'),
    command('openai-codex-cli', 'ps', '查看实验性后台终端及最近输出'),
    command('openai-codex-cli', 'fork', '将当前对话 fork 到新线程'),
    command('openai-codex-cli', 'resume', '从会话列表恢复历史对话'),
    command('openai-codex-cli', 'new', '在同一 CLI 会话中开启新对话'),
    command('openai-codex-cli', 'quit', '退出 CLI', { aliases: ['exit'] }),
    command('openai-codex-cli', 'review', '请求 Codex 审查当前 working tree'),
    command('openai-codex-cli', 'status', '显示会话配置与 token 使用情况'),
    command('openai-codex-cli', 'debug-config', '打印配置层级与 requirements 诊断信息'),
    command('openai-codex-cli', 'statusline', '交互式配置 TUI 底部状态栏字段'),
  ],
  'cursor-cli': [
    command('cursor-cli', 'model', '切换当前模型', { argumentHint: '[model]' }),
    command('cursor-cli', 'models', '列出可用模型并快速切换'),
    command('cursor-cli', 'summarize', '按需总结长对话，释放上下文窗口空间'),
    command('cursor-cli', 'mcp enable', '按需启用 MCP 服务', {
      argumentHint: '<server>',
      insertText: '/mcp enable',
    }),
    command('cursor-cli', 'mcp disable', '按需禁用 MCP 服务', {
      argumentHint: '<server>',
      insertText: '/mcp disable',
    }),
    command('cursor-cli', 'rules', '创建新规则或编辑现有规则'),
    command('cursor-cli', 'commands', '创建新命令或编辑现有命令'),
  ],
  'kiro-cli': [
    command('kiro-cli', 'help', '切换到 Help Agent、提问，或显示经典帮助'),
    command('kiro-cli', 'quit', '退出交互式会话', { aliases: ['exit', 'q'] }),
    command('kiro-cli', 'clear', '清空当前对话显示'),
    command('kiro-cli', 'context', '管理上下文规则并查看匹配文件'),
    command('kiro-cli', 'context show', '显示上下文规则配置与匹配文件', {
      insertText: '/context show',
    }),
    command('kiro-cli', 'context add', '添加上下文规则', {
      argumentHint: '<file-or-glob>',
      insertText: '/context add',
    }),
    command('kiro-cli', 'context remove', '移除指定上下文规则', {
      argumentHint: '<file-or-glob>',
      insertText: '/context remove',
    }),
    command('kiro-cli', 'context clear', '清空当前 agent 的上下文规则', {
      insertText: '/context clear',
    }),
    command('kiro-cli', 'model', '选择当前会话模型', { argumentHint: '[model]' }),
    command('kiro-cli', 'model set-current-as-default', '将当前模型保存为默认模型', {
      insertText: '/model set-current-as-default',
    }),
    command('kiro-cli', 'agent', '管理 agent 并在运行时切换 agent'),
    command('kiro-cli', 'agent list', '列出可用 agents 及描述', { insertText: '/agent list' }),
    command('kiro-cli', 'agent create', '创建新 agent', {
      argumentHint: '<name>',
      insertText: '/agent create',
    }),
    command('kiro-cli', 'agent generate', '使用 create 的别名创建新 agent', {
      argumentHint: '<name>',
      insertText: '/agent generate',
    }),
    command('kiro-cli', 'agent edit', '编辑现有 agent 配置', {
      argumentHint: '[name]',
      insertText: '/agent edit',
    }),
    command('kiro-cli', 'agent schema', '显示 agent 配置 schema', { insertText: '/agent schema' }),
    command('kiro-cli', 'agent set-default', '设置新会话默认 agent', {
      argumentHint: '[name]',
      insertText: '/agent set-default',
    }),
    command('kiro-cli', 'agent swap', '在当前会话中切换到其他 agent', {
      argumentHint: '[name]',
      insertText: '/agent swap',
    }),
    command('kiro-cli', 'chat', '管理聊天会话，包括新建、恢复、保存和加载'),
    command('kiro-cli', 'chat new', '开始新对话', { argumentHint: '[prompt]', insertText: '/chat new' }),
    command('kiro-cli', 'chat resume', '打开会话选择器恢复历史会话', {
      insertText: '/chat resume',
    }),
    command('kiro-cli', 'chat save', '保存当前会话到文件', { argumentHint: '<path>', insertText: '/chat save' }),
    command('kiro-cli', 'chat load', '从文件加载会话', { argumentHint: '<path>', insertText: '/chat load' }),
    command('kiro-cli', 'chat save-via-script', '通过自定义脚本保存会话', {
      argumentHint: '<script>',
      insertText: '/chat save-via-script',
    }),
    command('kiro-cli', 'chat load-via-script', '通过自定义脚本加载会话', {
      argumentHint: '<script>',
      insertText: '/chat load-via-script',
    }),
    command('kiro-cli', 'save', '将当前会话保存到文件'),
    command('kiro-cli', 'load', '从文件加载之前保存的会话'),
    command('kiro-cli', 'editor', '打开默认编辑器来编写长提示'),
    command('kiro-cli', 'reply', '在编辑器中引用最近一条助手消息进行回复'),
    command('kiro-cli', 'checkpoint', '管理工作区检查点并恢复文件状态'),
    command('kiro-cli', 'checkpoint init', '初始化新的工作区检查点', {
      insertText: '/checkpoint init',
    }),
    command('kiro-cli', 'checkpoint list', '列出所有检查点', { insertText: '/checkpoint list' }),
    command('kiro-cli', 'checkpoint restore', '恢复到指定检查点', {
      argumentHint: '[id]',
      insertText: '/checkpoint restore',
    }),
    command('kiro-cli', 'checkpoint expand', '查看检查点详情', {
      argumentHint: '<id>',
      insertText: '/checkpoint expand',
    }),
    command('kiro-cli', 'checkpoint diff', '比较两个检查点差异', {
      argumentHint: '<from> <to>',
      insertText: '/checkpoint diff',
    }),
    command('kiro-cli', 'checkpoint clean', '清理检查点 shadow repository', {
      insertText: '/checkpoint clean',
    }),
    command('kiro-cli', 'plan', '切换到 Plan agent 制定实现计划', { argumentHint: '[prompt]' }),
    command('kiro-cli', 'knowledge', '管理知识库并进行语义搜索'),
    command('kiro-cli', 'knowledge show', '列出所有知识库条目与状态', {
      insertText: '/knowledge show',
    }),
    command('kiro-cli', 'knowledge add', '向知识库添加文件或目录', {
      argumentHint: '--name <name> --path <path>',
      insertText: '/knowledge add',
    }),
    command('kiro-cli', 'knowledge search', '语义搜索知识库内容', {
      argumentHint: '<query>',
      insertText: '/knowledge search',
    }),
    command('kiro-cli', 'knowledge remove', '按路径移除知识库条目', {
      aliases: ['rm'],
      argumentHint: '<path>',
      insertText: '/knowledge remove',
    }),
    command('kiro-cli', 'knowledge update', '重新索引已有知识库条目', {
      argumentHint: '<path>',
      insertText: '/knowledge update',
    }),
    command('kiro-cli', 'knowledge clear', '清空整个知识库', { insertText: '/knowledge clear' }),
    command('kiro-cli', 'knowledge cancel', '取消后台索引任务', { insertText: '/knowledge cancel' }),
    command('kiro-cli', 'compact', '压缩当前对话以释放上下文空间'),
    command('kiro-cli', 'paste', '将剪贴板中的图片粘贴到会话'),
    command('kiro-cli', 'tools', '查看工具列表、权限与 token 开销'),
    command('kiro-cli', 'tools schema', '显示所有可用工具的输入 schema', {
      insertText: '/tools schema',
    }),
    command('kiro-cli', 'tools trust', '在当前会话中信任指定工具', {
      argumentHint: '<tool>',
      insertText: '/tools trust',
    }),
    command('kiro-cli', 'tools untrust', '取消当前会话中对指定工具的信任', {
      argumentHint: '<tool>',
      insertText: '/tools untrust',
    }),
    command('kiro-cli', 'tools trust-all', '信任全部工具', { insertText: '/tools trust-all' }),
    command('kiro-cli', 'tools reset', '将所有工具权限重置为默认值', { insertText: '/tools reset' }),
    command('kiro-cli', 'prompts', '查看、获取与管理 prompts'),
    command('kiro-cli', 'prompts list', '列出可用 prompts', { insertText: '/prompts list' }),
    command('kiro-cli', 'prompts details', '查看指定 prompt 详情', {
      argumentHint: '<name>',
      insertText: '/prompts details',
    }),
    command('kiro-cli', 'prompts get', '获取指定 prompt', {
      argumentHint: '<name> [arg]',
      insertText: '/prompts get',
    }),
    command('kiro-cli', 'prompts create', '创建本地 prompt', {
      argumentHint: '<name>',
      insertText: '/prompts create',
    }),
    command('kiro-cli', 'prompts edit', '编辑本地 prompt', {
      argumentHint: '<name>',
      insertText: '/prompts edit',
    }),
    command('kiro-cli', 'prompts remove', '移除本地 prompt', {
      argumentHint: '<name>',
      insertText: '/prompts remove',
    }),
    command('kiro-cli', 'hooks', '显示当前会话的 context hooks'),
    command('kiro-cli', 'usage', '显示账单与额度使用情况'),
    command('kiro-cli', 'mcp', '显示当前已加载的 MCP 服务'),
    command('kiro-cli', 'code', '管理代码智能配置并查看工作区状态'),
    command('kiro-cli', 'code init', '初始化当前目录的 LSP 代码智能', {
      argumentHint: '[-f]',
      insertText: '/code init',
    }),
    command('kiro-cli', 'code overview', '查看工作区整体概览', {
      argumentHint: '[--silent]',
      insertText: '/code overview',
    }),
    command('kiro-cli', 'code status', '查看工作区与 LSP 服务状态', {
      insertText: '/code status',
    }),
    command('kiro-cli', 'code logs', '查看或导出 LSP 日志', {
      argumentHint: '[-l LEVEL] [-n COUNT] [-p PATH]',
      insertText: '/code logs',
    }),
    command('kiro-cli', 'experiment', '切换实验功能开关'),
    command('kiro-cli', 'tangent', '进入或退出 tangent 模式以探索支线话题'),
    command('kiro-cli', 'todos', '查看、管理并恢复待办列表', { aliases: ['todo'] }),
    command('kiro-cli', 'todos add', '添加待办项', {
      argumentHint: '<text>',
      insertText: '/todos add',
    }),
    command('kiro-cli', 'todos complete', '完成指定待办项', {
      argumentHint: '<id>',
      insertText: '/todos complete',
    }),
    command('kiro-cli', 'issue', '提交 GitHub issue 或功能请求'),
    command('kiro-cli', 'logdump', '生成日志 zip 供排障与支持使用', { argumentHint: '[--mcp]' }),
    command('kiro-cli', 'changelog', '查看 Kiro CLI 更新日志'),
  ],
  opencode: [
    command('opencode', 'agents', '切换或管理 agent'),
    command('opencode', 'connect', '连接或配置 provider'),
    command('opencode', 'editor', '打开外部编辑器'),
    command('opencode', 'exit', '退出应用'),
    command('opencode', 'help', '显示帮助'),
    command('opencode', 'init', '创建或更新 AGENTS.md'),
    command('opencode', 'mcps', '切换 MCP 列表'),
    command('opencode', 'models', '切换模型'),
    command('opencode', 'new', '开始新会话'),
    command('opencode', 'review', '审查改动，支持 commit|branch|pr，默认未提交改动', {
      argumentHint: '[commit|branch|pr]',
    }),
    command('opencode', 'sessions', '切换会话'),
    command('opencode', 'skills', '查看或切换 Skills'),
    command('opencode', 'status', '查看状态'),
    command('opencode', 'themes', '切换主题'),
  ],
  'qoder-cli': [
    command('qoder-cli', 'agents', '管理 Subagent 配置'),
    command('qoder-cli', 'bashes', '列出并管理后台任务'),
    command('qoder-cli', 'clear', '清空当前会话上下文'),
    command('qoder-cli', 'commands', '管理当前工作区扩展命令'),
    command('qoder-cli', 'compact', '总结当前会话以压缩上下文', { argumentHint: '[instructions]' }),
    command('qoder-cli', 'config', '管理 Qoder CLI 配置'),
    command('qoder-cli', 'export', '导出当前会话到文件', { argumentHint: '[filename]' }),
    command('qoder-cli', 'feedback', '提交关于 Qoder CLI 的反馈', { argumentHint: '[content]' }),
    command('qoder-cli', 'help', '显示帮助与可用命令'),
    command('qoder-cli', 'init', '初始化 AGENTS.md'),
    command('qoder-cli', 'login', '登录 Qoder 账号'),
    command('qoder-cli', 'logout', '退出 Qoder 账号'),
    command('qoder-cli', 'mcp', '管理 MCP 服务'),
    command('qoder-cli', 'memory', '管理 memory 文件'),
    command('qoder-cli', 'model', '查看或切换模型等级'),
    command('qoder-cli', 'quest', '启动智能工作流编排', { argumentHint: '[instruction]' }),
    command('qoder-cli', 'quit', '退出程序', { aliases: ['exit'] }),
    command('qoder-cli', 'release-notes', '查看版本更新说明'),
    command('qoder-cli', 'resume', '恢复历史对话'),
    command('qoder-cli', 'review', '审查当前待提交改动', { argumentHint: '[instruction]' }),
    command('qoder-cli', 'setup-github', '设置 Qoder GitHub Actions'),
    command('qoder-cli', 'skills', '管理当前工作区 Skill'),
    command('qoder-cli', 'status', '查看 Qoder CLI 当前状态'),
    command('qoder-cli', 'upgrade', '在浏览器中打开套餐升级页面'),
    command('qoder-cli', 'usage', '查看套餐使用情况'),
    command('qoder-cli', 'vim', '打开外部编辑器输入'),
  ],
  'codebuddy-cli': [
    command('codebuddy-cli', 'help', '显示 CodeBuddy CLI 帮助'),
    command('codebuddy-cli', 'clear', '开始一个新的对话'),
    command('codebuddy-cli', 'resume', '恢复之前的会话', { argumentHint: '[list | session-id]' }),
    command('codebuddy-cli', 'doctor', '检查 CodeBuddy Code 运行环境'),
    command('codebuddy-cli', 'status', '查看当前仓库与会话状态'),
    command('codebuddy-cli', 'add-dir', '添加工作目录', { argumentHint: '<path>' }),
    command('codebuddy-cli', 'agents', '管理实验性 AI agents'),
    command('codebuddy-cli', 'compact', '压缩上下文'),
    command('codebuddy-cli', 'config', '查看或修改本地配置', { argumentHint: '[list | get | set]' }),
    command('codebuddy-cli', 'context', '查看上下文 token 分布'),
    command('codebuddy-cli', 'cost', '查看会话 token 与花费'),
    command('codebuddy-cli', 'init', '初始化 CodeBuddy 仓库'),
    command('codebuddy-cli', 'mcp', '管理 MCP 连接'),
    command('codebuddy-cli', 'memory', '管理长期记忆'),
    command('codebuddy-cli', 'model', '切换或查看当前模型', { argumentHint: '[list | model-name]' }),
    command('codebuddy-cli', 'permissions', '管理工具权限与目录访问'),
    command('codebuddy-cli', 'skills', '查看当前加载的 Skills'),
    command('codebuddy-cli', 'stats', '查看使用统计'),
    command('codebuddy-cli', 'theme', '切换主题'),
    command('codebuddy-cli', 'todos', '查看当前会话待办列表'),
  ],
};

COMMANDS_BY_PLATFORM.openclaude = COMMANDS_BY_PLATFORM['claude-code'].map(item => ({
  ...item,
  id: item.id.replace(/^claude-code:/, 'openclaude:'),
  platform: 'openclaude',
}));

const COMPAT_COMMANDS_BY_PLATFORM: Partial<Record<AgentPlatform, CliCommandItem[]>> = {
  'claude-code': [
    aliasCommand('claude-code', 'new', '统一新会话入口；发送时会转为 Claude 的 /clear'),
  ],
  openclaude: [
    aliasCommand('openclaude', 'new', '统一新会话入口；发送时会转为 OpenClaude 的 /clear'),
  ],
  'gemini-cli': [
    aliasCommand('gemini-cli', 'new', '统一新会话入口；发送时会转为 Gemini 的 /clear'),
    aliasCommand('gemini-cli', 'compact', '兼容 Claude 风格入口；发送时会转为 Gemini 的压缩命令'),
  ],
  'cursor-cli': [
    aliasCommand('cursor-cli', 'new', '统一新会话入口；发送时会转为 Cursor 的 /clear'),
    aliasCommand('cursor-cli', 'clear', '兼容 Claude 风格入口；发送时会转为 Cursor 的新会话命令'),
    aliasCommand('cursor-cli', 'compact', '兼容 Claude 风格入口；发送时会转为 Cursor 的压缩命令'),
  ],
  'kiro-cli': [
    aliasCommand('kiro-cli', 'new', '统一新会话入口；发送时会转为 Kiro 的 /chat new'),
  ],
  opencode: [
    aliasCommand('opencode', 'clear', '兼容 Claude 风格入口；发送时会转为 OpenCode 的 /new'),
    aliasCommand('opencode', 'compact', '兼容 Claude 风格入口；发送时会转为 OpenCode 的 /new'),
  ],
  'qoder-cli': [
    aliasCommand('qoder-cli', 'new', '统一新会话入口；发送时会转为 Qoder 的 /clear'),
  ],
  'codebuddy-cli': [
    aliasCommand('codebuddy-cli', 'new', '统一新会话入口；发送时会转为 CodeBuddy 的 /clear'),
  ],
};

const COMPAT_SLASH_REWRITE: Partial<Record<AgentPlatform, Partial<Record<'/clear' | '/compact' | '/new', string>>>> = {
  'claude-code': {
    '/new': '/clear',
  },
  openclaude: {
    '/new': '/clear',
  },
  'gemini-cli': {
    '/new': '/clear',
    '/compact': '/compress',
  },
  'cursor-cli': {
    '/clear': '/clear',
    '/compact': '/compress',
    '/new': '/clear',
  },
  'kiro-cli': {
    '/new': '/chat new',
  },
  opencode: {
    '/clear': '/new',
    '/compact': '/new',
  },
  'qoder-cli': {
    '/new': '/clear',
  },
  'codebuddy-cli': {
    '/new': '/clear',
  },
};

export function listCliCommands(platform: AgentPlatform): CliCommandItem[] {
  return [
    ...(COMMANDS_BY_PLATFORM[platform] ?? []),
    ...(COMPAT_COMMANDS_BY_PLATFORM[platform] ?? []),
  ];
}

export function normalizeCliInputForPlatform(platform: AgentPlatform, body: string): string {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('/')) return body;
  const command = trimmed.match(/^\/\S+/)?.[0].toLowerCase() as '/clear' | '/compact' | '/new' | undefined;
  if (!command) return body;
  const rewritten = COMPAT_SLASH_REWRITE[platform]?.[command];
  if (!rewritten) return body;
  const leadingWhitespace = body.slice(0, body.length - trimmed.length);
  return `${leadingWhitespace}${rewritten}`;
}
