import { describe, expect, it } from 'vitest';
import { getActiveToken } from './chatInputTriggers';

describe('getActiveToken', () => {
  it('在行首或空白后识别 @ token', () => {
    expect(getActiveToken('@', 1)).toEqual({ kind: 'mention', triggerStart: 0, query: '' });
    expect(getActiveToken('hi @x', 5)).toEqual({ kind: 'mention', triggerStart: 3, query: 'x' });
    expect(getActiveToken('hi\n@ab', 6)).toEqual({ kind: 'mention', triggerStart: 3, query: 'ab' });
  });

  it('单词中间的 @ 不触发', () => {
    expect(getActiveToken('a@b', 3)).toBeNull();
  });

  it('在行首或空白后识别 / token', () => {
    expect(getActiveToken('/', 1)).toEqual({ kind: 'slash', triggerStart: 0, query: '' });
    expect(getActiveToken('ok /skill', 9)).toEqual({ kind: 'slash', triggerStart: 3, query: 'skill' });
  });

  it('@ 与 / 同时合法时取更靠近光标的一侧', () => {
    const t = ' @a /b';
    const cursor = t.length;
    expect(getActiveToken(t, cursor)).toEqual({ kind: 'slash', triggerStart: 4, query: 'b' });
  });

  it('token 内出现空格则关闭', () => {
    expect(getActiveToken('@a ', 3)).toBeNull();
  });
});
