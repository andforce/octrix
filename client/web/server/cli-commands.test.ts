import { describe, expect, it } from 'vitest';
import { SUPPORTED_AGENTS } from '../src/agent-platforms';
import { listCliCommands } from './cli-commands';

describe('listCliCommands', () => {
  it('为 10 个已支持 CLI 平台都提供非空 slash 命令列表', () => {
    for (const agent of SUPPORTED_AGENTS) {
      const commands = listCliCommands(agent.platform);
      expect(commands.length, `${agent.platform} should expose slash commands`).toBeGreaterThan(0);
    }
  });

  it('每个平台的命令 id 唯一且 insertText 以 / 开头', () => {
    for (const agent of SUPPORTED_AGENTS) {
      const commands = listCliCommands(agent.platform);
      const ids = new Set(commands.map(command => command.id));
      expect(ids.size).toBe(commands.length);
      for (const command of commands) {
        expect(command.insertText.startsWith('/')).toBe(true);
      }
    }
  });

  it('OpenCode 预置命令包含原生命令与统一兼容入口', () => {
    const names = listCliCommands('opencode').map(command => command.insertText);
    expect(names).toEqual([
      '/agents',
      '/connect',
      '/editor',
      '/exit',
      '/help',
      '/init',
      '/mcps',
      '/models',
      '/new',
      '/review',
      '/sessions',
      '/skills',
      '/status',
      '/themes',
      '/clear',
      '/compact',
    ]);
  });

  it('Claude 预置命令包含官方 built-in commands 中的关键命令', () => {
    const names = listCliCommands('claude-code').map(command => command.insertText);
    expect(names).toEqual(expect.arrayContaining([
      '/add-dir',
      '/agents',
      '/clear',
      '/new',
      '/compact',
      '/config',
      '/context',
      '/cost',
      '/diff',
      '/doctor',
      '/help',
      '/ide',
      '/init',
      '/mcp',
      '/memory',
      '/model',
      '/permissions',
      '/plan',
      '/resume',
      '/security-review',
      '/skills',
      '/status',
      '/tasks',
      '/theme',
      '/usage',
    ]));
  });

  it('OpenClaude 复用 Claude Code 兼容命令并保持平台 id 独立', () => {
    const commands = listCliCommands('openclaude');
    const names = commands.map(command => command.insertText);

    expect(names).toEqual(expect.arrayContaining([
      '/add-dir',
      '/agents',
      '/clear',
      '/new',
      '/compact',
      '/doctor',
      '/init',
      '/mcp',
      '/model',
      '/permissions',
      '/status',
    ]));
    expect(commands.every(command => command.platform === 'openclaude')).toBe(true);
    expect(commands.every(command => command.id.startsWith('openclaude:'))).toBe(true);
  });

  it('GitHub Copilot CLI 预置命令包含官方 interactive slash commands 中的关键命令', () => {
    const names = listCliCommands('github-copilot-cli').map(command => command.insertText);
    expect(names).toEqual(expect.arrayContaining([
      '/add-dir',
      '/agent',
      '/allow-all',
      '/clear',
      '/new',
      '/compact',
      '/context',
      '/cwd',
      '/cd',
      '/delegate',
      '/diff',
      '/exit',
      '/experimental',
      '/feedback',
      '/fleet',
      '/help',
      '/ide',
      '/init',
      '/list-dirs',
      '/login',
      '/logout',
      '/lsp',
      '/lsp show',
      '/mcp',
      '/mcp add',
      '/model',
      '/models',
      '/plan',
      '/plugin',
      '/plugin install',
      '/rename',
      '/reset-allowed-tools',
      '/resume',
      '/review',
      '/session',
      '/session checkpoints',
      '/share',
      '/share gist',
      '/skills',
      '/skills reload',
      '/terminal-setup',
      '/theme',
      '/theme set',
      '/usage',
      '/user',
      '/user switch',
    ]));
    expect(names).not.toContain('/agents');
    expect(names.length).toBeGreaterThan(35);
  });

  it('Cursor CLI 预置命令包含原生命令与统一兼容入口', () => {
    const names = listCliCommands('cursor-cli').map(command => command.insertText);
    expect(names).toEqual([
      '/model',
      '/models',
      '/summarize',
      '/mcp enable',
      '/mcp disable',
      '/rules',
      '/commands',
      '/new',
      '/clear',
      '/compact',
    ]);
  });

  it('Codex CLI 预置命令与官方 built-in slash commands 一致', () => {
    const names = listCliCommands('openai-codex-cli').map(command => command.insertText);
    expect(names).toEqual([
      '/permissions',
      '/sandbox-add-read-dir',
      '/agent',
      '/apps',
      '/clear',
      '/compact',
      '/copy',
      '/diff',
      '/exit',
      '/experimental',
      '/feedback',
      '/init',
      '/logout',
      '/mcp',
      '/mention',
      '/model',
      '/fast',
      '/plan',
      '/personality',
      '/ps',
      '/fork',
      '/resume',
      '/new',
      '/quit',
      '/review',
      '/status',
      '/debug-config',
      '/statusline',
    ]);
    expect(names).not.toContain('/approvals');
  });

  it('Gemini CLI 预置命令包含官方 slash commands 文档中的关键命令与子命令', () => {
    const names = listCliCommands('gemini-cli').map(command => command.insertText);
    expect(names).toEqual(expect.arrayContaining([
      '/about',
      '/agents',
      '/agents list',
      '/agents reload',
      '/auth',
      '/bug',
      '/chat',
      '/chat save',
      '/chat resume',
      '/clear',
      '/new',
      '/commands',
      '/commands reload',
      '/compress',
      '/compact',
      '/copy',
      '/directory',
      '/directory add',
      '/docs',
      '/editor',
      '/extensions',
      '/extensions list',
      '/help',
      '/hooks',
      '/ide',
      '/init',
      '/mcp',
      '/mcp auth',
      '/mcp schema',
      '/memory',
      '/memory add',
      '/memory show',
      '/model',
      '/model set',
      '/permissions',
      '/plan',
      '/policies',
      '/privacy',
      '/quit',
      '/restore',
      '/rewind',
      '/resume',
      '/resume save',
      '/settings',
      '/shells',
      '/setup-github',
      '/skills',
      '/skills reload',
      '/stats',
      '/stats tools',
      '/terminal-setup',
      '/theme',
      '/tools',
      '/tools desc',
      '/upgrade',
      '/vim',
    ]));
    expect(names.length).toBeGreaterThan(50);
  });

  it('Kiro CLI 预置命令包含官方 slash commands 文档中的关键命令与子命令', () => {
    const names = listCliCommands('kiro-cli').map(command => command.insertText);
    expect(names).toEqual(expect.arrayContaining([
      '/help',
      '/quit',
      '/clear',
      '/new',
      '/context',
      '/context show',
      '/context add',
      '/model',
      '/model set-current-as-default',
      '/agent',
      '/agent list',
      '/agent create',
      '/agent edit',
      '/agent swap',
      '/chat',
      '/chat new',
      '/chat resume',
      '/chat save',
      '/chat load',
      '/save',
      '/load',
      '/editor',
      '/reply',
      '/checkpoint',
      '/checkpoint init',
      '/checkpoint restore',
      '/plan',
      '/knowledge',
      '/knowledge add',
      '/knowledge search',
      '/compact',
      '/paste',
      '/tools',
      '/tools trust',
      '/prompts',
      '/prompts list',
      '/hooks',
      '/usage',
      '/mcp',
      '/code',
      '/code init',
      '/code logs',
      '/experiment',
      '/tangent',
      '/todos',
      '/issue',
      '/logdump',
      '/changelog',
    ]));
    expect(names).not.toContain('/chat list');
    expect(names.length).toBeGreaterThan(40);
  });

  it('Qoder CLI 预置命令与官方 built-in commands 一致', () => {
    const names = listCliCommands('qoder-cli').map(command => command.insertText);
    expect(names).toEqual([
      '/agents',
      '/bashes',
      '/clear',
      '/commands',
      '/compact',
      '/config',
      '/export',
      '/feedback',
      '/help',
      '/init',
      '/login',
      '/logout',
      '/mcp',
      '/memory',
      '/model',
      '/quest',
      '/quit',
      '/release-notes',
      '/resume',
      '/review',
      '/setup-github',
      '/skills',
      '/status',
      '/upgrade',
      '/usage',
      '/vim',
      '/new',
    ]);
  });

  it('CodeBuddy 预置命令包含统一的 /new 入口', () => {
    const names = listCliCommands('codebuddy-cli').map(command => command.insertText);
    expect(names).toEqual(expect.arrayContaining([
      '/clear',
      '/new',
      '/compact',
    ]));
  });
});
