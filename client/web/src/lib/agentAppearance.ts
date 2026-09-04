import { SUPPORTED_AGENT_MAP, type AgentPlatform } from '../agent-platforms';
import { COLOR_MAP } from '../types';
import type { Agent, AgentGroup, GroupMember, Role } from '../types';

const PLATFORM_AVATAR_PALETTES: Record<AgentPlatform, { solid: string; from: string; to: string }> = {
  'claude-code': {
    solid: '#d97757',
    from: '#d97757',
    to: '#c4603f',
  },
  openclaude: {
    solid: '#b86f4b',
    from: '#d97757',
    to: '#8f4d2e',
  },
  opencode: {
    solid: '#6366f1',
    from: '#6366f1',
    to: '#4f46e5',
  },
  'github-copilot-cli': {
    solid: '#6e7681',
    from: '#6e7681',
    to: '#484f58',
  },
  'gemini-cli': {
    solid: '#4285f4',
    from: '#4285f4',
    to: '#1a73e8',
  },
  'openai-codex-cli': {
    solid: '#10a37f',
    from: '#10a37f',
    to: '#0d8c6d',
  },
  'cursor-cli': {
    solid: '#a855f7',
    from: '#a855f7',
    to: '#7c3aed',
  },
  'kiro-cli': {
    solid: '#f59e0b',
    from: '#f59e0b',
    to: '#d97706',
  },
  'qoder-cli': {
    solid: '#14b8a6',
    from: '#14b8a6',
    to: '#0d9488',
  },
  'codebuddy-cli': {
    solid: '#0ea5e9',
    from: '#0ea5e9',
    to: '#0284c7',
  },
};

function resolveFallbackColor(fallbackColor?: string): string {
  return COLOR_MAP[fallbackColor ?? ''] ?? fallbackColor ?? '#64748b';
}

export function getAgentAvatarBackground(platform?: AgentPlatform, fallbackColor?: string): string {
  if (fallbackColor) {
    const resolved = resolveFallbackColor(fallbackColor);
    return `linear-gradient(145deg, ${resolved}, ${resolved}cc)`;
  }

  if (platform) {
    const palette = PLATFORM_AVATAR_PALETTES[platform];
    return `linear-gradient(145deg, ${palette.from}, ${palette.to})`;
  }

  const fallback = resolveFallbackColor(fallbackColor);
  return `linear-gradient(145deg, ${fallback}, ${fallback}cc)`;
}

export function getAgentAvatarSolid(platform?: AgentPlatform, fallbackColor?: string): string {
  if (fallbackColor) {
    return resolveFallbackColor(fallbackColor);
  }

  if (platform) {
    return PLATFORM_AVATAR_PALETTES[platform].solid;
  }

  return resolveFallbackColor(fallbackColor);
}

export function getGroupMemberAvatarLabel(
  member: GroupMember,
  group: Pick<AgentGroup, 'members'>,
  roles: Role[],
  fallbackName: string,
): string {
  const memberRoleName = member.roleId ? roles.find(role => role.id === member.roleId)?.name : undefined;
  if (!memberRoleName) return fallbackName.charAt(0).toUpperCase();

  const sameRoleMembers = group.members.filter(groupMember => groupMember.roleId === member.roleId);
  if (sameRoleMembers.length <= 1) return memberRoleName.charAt(0);

  const memberIndex = sameRoleMembers.findIndex(groupMember => groupMember.id === member.id) + 1;
  return `${memberRoleName.charAt(0)}${memberIndex}`;
}

export function getConversationSenderPresentation(
  sender: string,
  ownerName: string,
  group: Pick<AgentGroup, 'members'>,
  agents: Agent[],
  roles: Role[],
): {
  senderLabel: string;
  avatarLabel: string;
  avatarBackground: string;
  avatarLogoUrl?: string;
  avatarPlatform?: AgentPlatform;
} {
  if (sender === 'user') {
    return {
      senderLabel: ownerName,
      avatarLabel: ownerName.charAt(0).toUpperCase(),
      avatarBackground: getAgentAvatarBackground(undefined, 'blue'),
    };
  }

  const agent = agents.find(item => item.name === sender);
  const member = agent ? group.members.find(item => item.agentId === agent.id) : undefined;
  const roleName = member?.roleId ? roles.find(role => role.id === member.roleId)?.name : undefined;

  const avatarLogoUrl =
    agent?.platform != null ? SUPPORTED_AGENT_MAP[agent.platform]?.logoUrl : undefined;

  return {
    senderLabel: roleName ? `${roleName}(${sender})` : sender,
    avatarLabel: agent && member
      ? getGroupMemberAvatarLabel(member, group, roles, agent.name)
      : (roleName ?? sender).charAt(0).toUpperCase(),
    avatarBackground: getAgentAvatarBackground(agent?.platform, agent?.avatarColor ?? 'gray'),
    avatarLogoUrl,
    avatarPlatform: agent?.platform,
  };
}
