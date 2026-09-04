import { describe, expect, it } from 'vitest';
import { appendRecoverySnapshot, parseRecoverySnapshot } from './collaboration-recovery';

describe('collaboration recovery snapshot', () => {
  it('round-trips server-managed state through a Markdown block', () => {
    const state = {
      id: 'mission-1',
      groupId: 'group-1',
      kind: 'mission',
      status: 'active',
      revision: 7,
      title: '恢复任务',
    };
    const markdown = appendRecoverySnapshot('# 任务现场\n', state);

    expect(markdown).toContain('```octrix-state');
    expect(parseRecoverySnapshot(markdown)).toEqual(state);
  });

  it('ignores ordinary Markdown without a server snapshot', () => {
    expect(parseRecoverySnapshot('# AI 自己写的文档')).toBeUndefined();
  });
});
