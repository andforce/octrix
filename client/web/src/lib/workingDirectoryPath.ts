import type { AgentGroup } from '../types';

/** 与后端 path.resolve 后的路径可比对的键（用于前端去重提示） */
export function normalizeWorkingDirectoryKey(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return '';
  const noTrailing = trimmed.replace(/[/\\]+$/, '');
  const isWin = /^[a-zA-Z]:/.test(noTrailing) || noTrailing.startsWith('\\\\');
  const unified = noTrailing.replace(/\\/g, '/');
  if (isWin) {
    const withDrive = unified.length >= 2 && unified[1] === ':'
      ? unified[0]!.toUpperCase() + unified.slice(1)
      : unified;
    return withDrive.toLowerCase();
  }
  return unified.replace(/\/+/g, '/');
}

/** 若已有群组占用相同工作目录（规范化后一致）则返回该群组 */
export function findGroupWithSameWorkingDirectory(
  groups: AgentGroup[] | undefined,
  pickedPath: string,
): AgentGroup | undefined {
  const list = groups ?? [];
  const key = normalizeWorkingDirectoryKey(pickedPath);
  if (!key) return undefined;
  return list.find(g => {
    if (!g.workingDirectory) return false;
    return normalizeWorkingDirectoryKey(g.workingDirectory) === key;
  });
}
