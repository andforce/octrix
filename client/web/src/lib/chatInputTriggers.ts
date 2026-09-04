export type ActiveToken =
  | { kind: 'mention'; triggerStart: number; query: string }
  | { kind: 'slash'; triggerStart: number; query: string };

/**
 * 与 ChatView 中 @ / 一致：仅在行首或空白后触发；token 内无空格。
 * `/` token 由上层决定展示 CLI 命令还是本机 Skill。
 * 若 @ 与 / 同时合法，取更靠近光标（下标更大）的一侧。
 */
export function getActiveToken(text: string, cursor: number): ActiveToken | null {
  const before = text.slice(0, cursor);
  const lastAt = before.lastIndexOf('@');
  const lastSlash = before.lastIndexOf('/');
  const validPrefix = (idx: number) =>
    idx >= 0 && (idx === 0 || before[idx - 1] === ' ' || before[idx - 1] === '\n');
  const tokenAfter = (idx: number) => before.slice(idx + 1);
  const atOk = validPrefix(lastAt) && !tokenAfter(lastAt).includes(' ');
  const slashOk = validPrefix(lastSlash) && !tokenAfter(lastSlash).includes(' ');
  if (!atOk && !slashOk) return null;
  if (atOk && !slashOk) {
    return { kind: 'mention', triggerStart: lastAt, query: tokenAfter(lastAt) };
  }
  if (!atOk && slashOk) {
    return { kind: 'slash', triggerStart: lastSlash, query: tokenAfter(lastSlash) };
  }
  return lastAt > lastSlash
    ? { kind: 'mention', triggerStart: lastAt, query: tokenAfter(lastAt) }
    : { kind: 'slash', triggerStart: lastSlash, query: tokenAfter(lastSlash) };
}
