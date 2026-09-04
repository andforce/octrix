import { describe, expect, it } from 'vitest';
import {
  ENABLED_AGENTS,
  ENABLED_AGENT_PLATFORMS,
  isEnabledAgentPlatform,
  SUPPORTED_AGENTS,
} from './agent-platforms';

describe('SUPPORTED_AGENTS launch metadata', () => {
  it('exposes every supported platform in the product catalog', () => {
    expect(ENABLED_AGENT_PLATFORMS).toEqual([
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
    ]);
    expect(ENABLED_AGENTS.map(agent => agent.name)).toEqual([
      'Codex CLI',
      'OpenClaude',
      'Claude Code',
      'OpenCode',
      'GitHub Copilot CLI',
      'Gemini CLI',
      'Cursor CLI',
      'Kiro CLI',
      'Qoder CLI',
      'CodeBuddy',
    ]);
    expect(new Set(ENABLED_AGENT_PLATFORMS)).toEqual(
      new Set(SUPPORTED_AGENTS.map(agent => agent.platform)),
    );
    expect(SUPPORTED_AGENTS.every(agent => isEnabledAgentPlatform(agent.platform))).toBe(true);
  });

  it('stores display command separately from executable and args', () => {
    for (const agent of SUPPORTED_AGENTS) {
      expect(agent.executable).not.toContain(' ');
      expect(Array.isArray(agent.args)).toBe(true);
    }

    const claude = SUPPORTED_AGENTS.find(agent => agent.platform === 'claude-code');
    expect(claude).toMatchObject({
      command: 'claude --permission-mode bypassPermissions',
      executable: 'claude',
      args: ['--permission-mode', 'bypassPermissions'],
    });

    const openclaude = SUPPORTED_AGENTS.find(agent => agent.platform === 'openclaude');
    expect(openclaude).toMatchObject({
      command: 'openclaude --permission-mode bypassPermissions',
      executable: 'openclaude',
      args: ['--permission-mode', 'bypassPermissions'],
    });

    const opencode = SUPPORTED_AGENTS.find(agent => agent.platform === 'opencode');
    expect(opencode).toMatchObject({
      command: 'opencode',
      executable: 'opencode',
      args: [],
    });

    const kiro = SUPPORTED_AGENTS.find(agent => agent.platform === 'kiro-cli');
    expect(kiro).toMatchObject({
      command: 'kiro-cli chat --trust-all-tools',
      executable: 'kiro-cli',
      args: ['chat', '--trust-all-tools'],
    });

    const qoder = SUPPORTED_AGENTS.find(agent => agent.platform === 'qoder-cli');
    expect(qoder).toMatchObject({
      command: 'qodercli --dangerously-skip-permissions',
      executable: 'qodercli',
      args: ['--dangerously-skip-permissions'],
    });

    const codebuddy = SUPPORTED_AGENTS.find(agent => agent.platform === 'codebuddy-cli');
    expect(codebuddy).toMatchObject({
      command: 'codebuddy --permission-mode bypassPermissions',
      executable: 'codebuddy',
      args: ['--permission-mode', 'bypassPermissions'],
    });
  });
});
