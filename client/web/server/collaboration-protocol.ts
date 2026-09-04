import { parse } from 'yaml';

export const COLLABORATION_ACTION_NAMES = [
  'work.accept',
  'work.reject',
  'work.clarify',
  'work.started',
  'work.progress',
  'work.submit',
  'consultation.request',
  'clarification.request',
  'handoff.request',
  'defect.return',
  'issue.report',
  'issue.resolve',
  'issue.reopen',
  'stage.pass',
  'discussion.extend',
  'mission.owner_attention',
  'mission.ready_for_owner',
  'mission.auto_merge_complete',
] as const;

export type CollaborationActionName = typeof COLLABORATION_ACTION_NAMES[number];

export interface CollaborationControlAction {
  action: CollaborationActionName;
  requestId: string;
  missionId: string;
  workItemId: string;
  expectedRevision: number;
  targetRole?: string;
  targetMemberId?: string;
  artifact?: string;
  contextRevision?: number;
  summary?: string;
  issueId?: string;
  severity?: string;
  title?: string;
  implementationRevisionId?: string;
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  draftPr?: boolean;
  mergeCommitSha?: string;
  reasonCode?: string;
}

const COLLABORATION_ACTIONS = new Set<string>(COLLABORATION_ACTION_NAMES);
const OWNER_ATTENTION_REASONS = new Set([
  'scope_change',
  'major_risk',
  'missing_role_change',
  'external_verification',
  'external_action',
]);

function assertNever(value: never): never {
  throw new Error(`未实现的协作操作：${String(value)}`);
}

export interface CollaborationControlError {
  blockIndex: number;
  message: string;
}

export interface CollaborationControlParseResult {
  actions: CollaborationControlAction[];
  errors: CollaborationControlError[];
}

export function parseCollaborationControlBlocks(content: string): CollaborationControlParseResult {
  const actions: CollaborationControlAction[] = [];
  const errors: CollaborationControlError[] = [];
  const pattern = /```octrix-action[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

  let blockIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    try {
      const parsed = parse(match[1]) as unknown;
      const validation = validateControlAction(parsed);
      if (validation.error) {
        errors.push({ blockIndex, message: validation.error });
      } else if (validation.action) {
        actions.push(validation.action);
      }
    } catch (error) {
      errors.push({
        blockIndex,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    blockIndex++;
  }

  return { actions, errors };
}

function validateControlAction(value: unknown): {
  action?: CollaborationControlAction;
  error?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '控制块必须是字段映射' };
  }

  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of ['action', 'requestId', 'missionId', 'workItemId'] as const) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      errors.push(`${field} 必须是非空字符串`);
    }
  }
  if (!Number.isInteger(record.expectedRevision) || Number(record.expectedRevision) < 0) {
    errors.push('expectedRevision 必须是非负整数');
  }
  if (errors.length > 0) return { error: errors.join('；') };

  const actionName = String(record.action) as CollaborationActionName;
  if (!COLLABORATION_ACTIONS.has(actionName)) {
    return { error: `不支持的协作操作：${record.action}` };
  }

  const actionErrors: string[] = [];
  const requireString = (field: keyof CollaborationControlAction) => {
    if (typeof record[field] !== 'string' || !String(record[field]).trim()) {
      actionErrors.push(`${field} 必须是非空字符串`);
    }
  };
  const requireArtifact = () => requireString('artifact');
  const requireSummary = () => requireString('summary');
  const requireTarget = () => {
    const hasRole = typeof record.targetRole === 'string' && record.targetRole.trim();
    const hasMember = typeof record.targetMemberId === 'string' && record.targetMemberId.trim();
    if (!hasRole && !hasMember) actionErrors.push('targetRole 或 targetMemberId 至少需要一个');
  };
  switch (actionName) {
    case 'work.accept':
      if (!Number.isInteger(record.contextRevision) || Number(record.contextRevision) < 0) {
        actionErrors.push('contextRevision 必须是非负整数');
      }
      break;
    case 'work.reject':
    case 'work.clarify':
    case 'work.progress':
      requireSummary();
      break;
    case 'work.submit':
    case 'stage.pass':
      requireArtifact();
      break;
    case 'consultation.request':
    case 'clarification.request':
      requireTarget();
      requireSummary();
      break;
    case 'handoff.request':
      requireString('targetRole');
      requireArtifact();
      break;
    case 'defect.return':
      requireString('targetRole');
      requireString('issueId');
      requireArtifact();
      break;
    case 'issue.report':
      requireString('issueId');
      requireString('severity');
      requireString('title');
      requireSummary();
      requireArtifact();
      if (
        typeof record.severity === 'string'
        && !['blocker', 'major', 'minor', 'suggestion'].includes(record.severity)
      ) {
        actionErrors.push('severity 必须是 blocker、major、minor 或 suggestion');
      }
      break;
    case 'issue.resolve':
    case 'issue.reopen':
      requireString('issueId');
      requireSummary();
      requireArtifact();
      break;
    case 'discussion.extend':
      requireSummary();
      break;
    case 'mission.owner_attention':
      requireSummary();
      requireArtifact();
      if (typeof record.reasonCode !== 'string' || !OWNER_ATTENTION_REASONS.has(record.reasonCode)) {
        actionErrors.push('reasonCode 必须是 scope_change、major_risk、missing_role_change、external_verification 或 external_action');
      }
      break;
    case 'mission.ready_for_owner':
      requireArtifact();
      requireSummary();
      break;
    case 'mission.auto_merge_complete':
      requireArtifact();
      requireSummary();
      requireString('prUrl');
      requireString('mergeCommitSha');
      break;
    case 'work.started':
      break;
    default:
      assertNever(actionName);
  }
  if (actionErrors.length > 0) return { error: actionErrors.join('；') };

  const action: CollaborationControlAction = {
    action: actionName,
    requestId: String(record.requestId),
    missionId: String(record.missionId),
    workItemId: String(record.workItemId),
    expectedRevision: Number(record.expectedRevision),
  };
  for (const field of [
    'targetRole',
    'targetMemberId',
    'artifact',
    'summary',
    'issueId',
    'severity',
    'title',
    'implementationRevisionId',
    'commitSha',
    'branch',
    'prUrl',
    'mergeCommitSha',
    'reasonCode',
  ] as const) {
    if (typeof record[field] === 'string') action[field] = record[field];
  }
  if (Number.isInteger(record.contextRevision)) {
    action.contextRevision = Number(record.contextRevision);
  }
  if (typeof record.draftPr === 'boolean') action.draftPr = record.draftPr;
  return { action };
}
