import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';

/** 与 hub / 消息协议冲突的 Skill 目录名，不在列表中展示 */
export const SKILL_NAME_BLOCKLIST = new Set(['assign', 'wf']);

export interface SkillScanItem {
  id: string;
  name: string;
  skillMdPath: string;
  rootPath: string;
  sourceTag: string;
  summary: string | null;
}

let cache: { at: number; items: SkillScanItem[] } | null = null;
const CACHE_TTL_MS = 60_000;

function readFirstSummaryLine(skillMdPath: string): string | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && lines[i].trim() === '---') {
      i++;
      while (i < lines.length) {
        if (lines[i].trim() === '---') {
          i++;
          break;
        }
        i++;
      }
      while (i < lines.length && !lines[i].trim()) i++;
    }
    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      const h1 = t.match(/^#\s+(.+)/);
      if (h1) return h1[1].trim().slice(0, 160);
      return t.slice(0, 160);
    }
    return null;
  } catch {
    return null;
  }
}

function inferSourceTag(rootPath: string): string {
  const n = normalize(rootPath).replace(/\\/g, '/');
  const h = normalize(homedir()).replace(/\\/g, '/');
  const rel = n.startsWith(h) ? `~${n.slice(h.length)}` : n;
  if (rel.includes('.claude/skills')) return 'claude';
  if (rel.includes('skills-cursor')) return 'cursor-ui';
  if (rel.includes('.cursor/skills')) return 'cursor';
  if (rel.includes('.codex/skills')) return 'codex';
  return rel.length > 28 ? `…${rel.slice(-24)}` : rel;
}

function defaultSkillRoots(): string[] {
  const h = homedir();
  return [
    join(h, '.claude', 'skills'),
    join(h, '.cursor', 'skills'),
    join(h, '.cursor', 'skills-cursor'),
    join(h, '.codex', 'skills'),
  ];
}

function extraRootsFromEnv(): string[] {
  const raw = process.env.AI_AGENT_SKILL_ROOTS;
  if (!raw?.trim()) return [];
  const sep = process.platform === 'win32' ? ';' : ':';
  return raw.split(sep).map(s => s.trim()).filter(Boolean);
}

function uniqueRoots(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...defaultSkillRoots(), ...extraRootsFromEnv()]) {
    const abs = resolve(r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function scanRoot(rootPath: string): SkillScanItem[] {
  const out: SkillScanItem[] = [];
  if (!existsSync(rootPath)) return out;
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = readdirSync(rootPath, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return out;
  }
  const sourceTag = inferSourceTag(rootPath);
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const name = String(d.name);
    if (name.startsWith('.')) continue;
    if (SKILL_NAME_BLOCKLIST.has(name.toLowerCase())) continue;
    const skillMdPath = join(rootPath, name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const id = `${rootPath}::${name}`;
    out.push({
      id,
      name,
      skillMdPath,
      rootPath,
      sourceTag,
      summary: readFirstSummaryLine(skillMdPath),
    });
  }
  return out;
}

/**
 * 扫描本机 Skill 目录（含默认路径与 AI_AGENT_SKILL_ROOTS），合并去重按 id，
 * 同名不同根目录会各自保留并带 sourceTag。
 */
export function scanInstalledSkills(): SkillScanItem[] {
  const merged: SkillScanItem[] = [];
  const seenId = new Set<string>();
  for (const root of uniqueRoots()) {
    for (const item of scanRoot(root)) {
      if (seenId.has(item.id)) continue;
      seenId.add(item.id);
      merged.push(item);
    }
  }
  merged.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.sourceTag.localeCompare(b.sourceTag);
  });
  return merged;
}

export function getCachedSkills(forceRefresh = false): SkillScanItem[] {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.items;
  }
  const items = scanInstalledSkills();
  cache = { at: now, items };
  return items;
}

export function invalidateSkillsCache() {
  cache = null;
}
