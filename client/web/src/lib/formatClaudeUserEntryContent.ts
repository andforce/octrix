/**
 * Claude Code 的 user 条目 content 常为 JSON 数组/对象字符串（见 conversation-watcher parseClaudeEntry）。
 * 解析成功则缩进展示；失败则回退原文。仅应在 Claude Code 兼容平台时调用。
 *
 * 若用 JSON.stringify 整段输出，字符串里的换行会变成字面量 \\n，阅读性差。
 * 对每个字符串叶子单独 stringify 后，仅在该引号对内把 JSON 转义解开为真实 \\n / \\r / \\t，
 * 多行源码在 <pre> 里会按真实换行展示（不对整段结果做全局 replace，避免和结构换行混淆）。
 */

function normalizeLineEndingsInStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLineEndingsInStrings);
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      next[k] = normalizeLineEndingsInStrings(o[k]);
    }
    return next;
  }
  return value;
}

/** 对单个字符串做 JSON 引号包裹，并把 \\n \\r \\t 转为真实字符以便在 pre 里换行显示 */
function jsonStringWithRealEscapesUnwrapped(s: string): string {
  return JSON.stringify(s)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function prettyPrintJsonForDisplay(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const nextPad = '  '.repeat(indent + 1);

  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return jsonStringWithRealEscapesUnwrapped(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((v, i) => {
      const chunk = prettyPrintJsonForDisplay(v, indent + 1);
      const comma = i < value.length - 1 ? ',' : '';
      return `${nextPad}${chunk}${comma}`;
    });
    return `[\n${lines.join('\n')}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k, i) => {
      const chunk = prettyPrintJsonForDisplay(o[k], indent + 1);
      const comma = i < keys.length - 1 ? ',' : '';
      return `${nextPad}${JSON.stringify(k)}: ${chunk}${comma}`;
    });
    return `{\n${lines.join('\n')}\n${pad}}`;
  }
  return String(value);
}

export function formatClaudeUserEntryContent(raw: string): { display: string; isPrettyJson: boolean } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { display: raw, isPrettyJson: false };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalizeLineEndingsInStrings(parsed);
    return { display: prettyPrintJsonForDisplay(normalized), isPrettyJson: true };
  } catch {
    return { display: raw, isPrettyJson: false };
  }
}
