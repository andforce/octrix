const SNAPSHOT_PATTERN = /```octrix-state[ \t]*\r?\n([\s\S]*?)\r?\n```/;

export function appendRecoverySnapshot(markdown: string, state: unknown): string {
  const prefix = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  return `${prefix}\n## Octrix 恢复快照\n\n\`\`\`octrix-state\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`;
}

export function parseRecoverySnapshot(markdown: string): unknown {
  const match = SNAPSHOT_PATTERN.exec(markdown);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}
