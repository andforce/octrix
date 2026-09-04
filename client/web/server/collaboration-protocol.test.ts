import { describe, expect, it } from 'vitest';
import { parseCollaborationControlBlocks } from './collaboration-protocol';

describe('parseCollaborationControlBlocks', () => {
  it('parses a valid handoff request from an octrix-action Markdown block', () => {
    const content = [
      '研发工作已经完成。',
      '```octrix-action',
      'action: handoff.request',
      'requestId: req-123',
      'missionId: mission-123',
      'workItemId: WI-007',
      'targetRole: 代码审查',
      'artifact: handoffs/001-dev-to-review.md',
      'expectedRevision: 6',
      '```',
    ].join('\n');

    expect(parseCollaborationControlBlocks(content)).toEqual({
      actions: [
        {
          action: 'handoff.request',
          requestId: 'req-123',
          missionId: 'mission-123',
          workItemId: 'WI-007',
          targetRole: '代码审查',
          artifact: 'handoffs/001-dev-to-review.md',
          expectedRevision: 6,
        },
      ],
      errors: [],
    });
  });

  it('rejects a control block with missing identity and stale-version fields', () => {
    const content = [
      '```octrix-action',
      'action: handoff.request',
      'missionId: mission-123',
      'workItemId: WI-007',
      'targetRole: 代码审查',
      'artifact: handoffs/001-dev-to-review.md',
      'expectedRevision: six',
      '```',
    ].join('\n');

    expect(parseCollaborationControlBlocks(content)).toEqual({
      actions: [],
      errors: [
        {
          blockIndex: 0,
          message: 'requestId 必须是非空字符串；expectedRevision 必须是非负整数',
        },
      ],
    });
  });

  it('rejects an unknown action instead of inferring a state transition', () => {
    const content = [
      '```octrix-action',
      'action: developer.finished',
      'requestId: unknown-001',
      'missionId: mission-123',
      'workItemId: WI-007',
      'expectedRevision: 0',
      '```',
    ].join('\n');

    expect(parseCollaborationControlBlocks(content)).toEqual({
      actions: [],
      errors: [
        {
          blockIndex: 0,
          message: '不支持的协作操作：developer.finished',
        },
      ],
    });
  });

  it.each([
    ['work.accept', [], 'contextRevision 必须是非负整数'],
    ['work.progress', [], 'summary 必须是非空字符串'],
    ['work.submit', [], 'artifact 必须是非空字符串'],
    ['consultation.request', ['summary: 请评估'], 'targetRole 或 targetMemberId 至少需要一个'],
    ['handoff.request', ['targetRole: 研发'], 'artifact 必须是非空字符串'],
    ['issue.report', ['issueId: BUG-1', 'severity: critical', 'title: 问题', 'summary: 摘要', 'artifact: evidence.md'], 'severity 必须是 blocker、major、minor 或 suggestion'],
    ['mission.owner_attention', ['summary: 需要群主处理', 'artifact: risk.md'], 'reasonCode 必须是'],
    ['discussion.extend', [], 'summary 必须是非空字符串'],
    ['mission.ready_for_owner', ['artifact: deliverable.md'], 'summary 必须是非空字符串'],
    ['mission.auto_merge_complete', ['artifact: merge.md', 'summary: 已合并', 'prUrl: https://example.com/pr/1'], 'mergeCommitSha 必须是非空字符串'],
  ])('validates required fields for %s', (action, extra, expectedError) => {
    const result = parseCollaborationControlBlocks([
      '```octrix-action',
      `action: ${action}`,
      'requestId: req-fields',
      'missionId: mission-123',
      'workItemId: WI-007',
      'expectedRevision: 0',
      ...extra,
      '```',
    ].join('\n'));

    expect(result.actions).toEqual([]);
    expect(result.errors[0]?.message).toContain(expectedError);
  });

  it('parses a structured request for owner attention', () => {
    const result = parseCollaborationControlBlocks([
      '```octrix-action',
      'action: mission.owner_attention',
      'requestId: owner-attention-1',
      'missionId: mission-123',
      'workItemId: WI-007',
      'expectedRevision: 3',
      'reasonCode: external_verification',
      'summary: 需要群主在真机完成支付验收',
      'artifact: evidence/pending-human.md',
      '```',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.actions[0]).toEqual(expect.objectContaining({
      action: 'mission.owner_attention',
      reasonCode: 'external_verification',
    }));
  });
});
