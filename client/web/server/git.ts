import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GitChangeKind, GitChangeSection, GitDiffSnapshot, GitDiffView, GitStatusEntry, GitWorkspaceStatus } from '../src/types.js';
import type { MissionGitBaseline } from './models.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface GitRevisionSnapshot {
  id: string;
  baseCommit: string;
  branch: string;
  contentHash: string;
  changedFiles: string[];
  patch: string;
  createdAt: number;
}

export function nextImplementationRevisionNumber(revisions: Array<{ id: string }>): number {
  const highest = revisions.reduce((current, revision) => {
    const match = /^R(\d+)$/.exec(revision.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return highest + 1;
}

function isSafeWorkspacePath(workingDirectory: string, relativePath: string) {
  const root = resolve(workingDirectory);
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(`${root}${sep}`);
}

function normalizeRelativePath(relativePath: string) {
  return relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isAiTeamPath(relativePath: string) {
  return normalizeRelativePath(relativePath).split('/').includes('.ai-team');
}

function bufferToSnapshot(buffer: Buffer): GitDiffSnapshot {
  const isBinary = buffer.includes(0);
  return {
    exists: true,
    isBinary,
    text: isBinary ? '' : buffer.toString('utf8'),
  };
}

function emptySnapshot(): GitDiffSnapshot {
  return { exists: false, isBinary: false, text: '' };
}

async function runGitBuffer(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function runGitText(cwd: string, args: string[]) {
  const buffer = await runGitBuffer(cwd, args);
  return buffer.toString('utf8');
}

function parseBranch(header: string) {
  const branch = header.replace(/\.\.\..*$/, '').trim();
  if (!branch || branch === 'HEAD') return null;
  return branch;
}

function toChangeKind(code: string): GitChangeKind {
  switch (code) {
    case 'A':
    case '?':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'modified';
  }
}

function pushEntry(
  entries: GitStatusEntry[],
  {
    path,
    section,
    code,
    x,
    y,
    previousPath,
  }: {
    path: string;
    section: GitChangeSection;
    code: string;
    x: string;
    y: string;
    previousPath?: string;
  },
) {
  entries.push({
    path,
    previousPath,
    section,
    staged: section === 'staged',
    kind: toChangeKind(code),
    x,
    y,
  });
}

function parseStatusOutput(output: string): Pick<GitWorkspaceStatus, 'branch' | 'entries'> {
  const tokens = output.split('\0');
  const entries: GitStatusEntry[] = [];
  let branch: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (!branch && token.startsWith('## ')) {
      branch = parseBranch(token.slice(3));
      continue;
    }

    const x = token[0] ?? ' ';
    const y = token[1] ?? ' ';
    const path = normalizeRelativePath(token.slice(3));
    if (!path) continue;

    const renameLike = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const previousPath = renameLike ? normalizeRelativePath(tokens[index + 1] ?? '') || undefined : undefined;
    if (renameLike) index += 1;

    if (x === '?' && y === '?') {
      pushEntry(entries, { path, section: 'untracked', code: '?', x, y, previousPath });
      continue;
    }

    if (x !== ' ' && x !== '?') {
      pushEntry(entries, { path, section: 'staged', code: x, x, y, previousPath });
    }
    if (y !== ' ' && y !== '?') {
      pushEntry(entries, { path, section: 'unstaged', code: y, x, y, previousPath });
    }
  }

  return { branch, entries };
}

function isNotGitRepositoryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('not a git repository');
}

async function readWorktreeSnapshot(workingDirectory: string, relativePath: string) {
  if (!isSafeWorkspacePath(workingDirectory, relativePath)) {
    throw new Error('path traversal not allowed');
  }

  try {
    const buffer = await readFile(resolve(workingDirectory, relativePath));
    return bufferToSnapshot(buffer);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return emptySnapshot();
    }
    throw error;
  }
}

async function readGitSnapshot(workingDirectory: string, spec: string) {
  try {
    const buffer = await runGitBuffer(workingDirectory, ['show', spec]);
    return bufferToSnapshot(buffer);
  } catch {
    return emptySnapshot();
  }
}

export async function getGitWorkspaceStatus(workingDirectory: string): Promise<GitWorkspaceStatus> {
  try {
    const [statusOutput, repoRoot] = await Promise.all([
      runGitText(workingDirectory, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']),
      runGitText(workingDirectory, ['rev-parse', '--show-toplevel']),
    ]);
    const parsed = parseStatusOutput(statusOutput);

    return {
      isGitRepository: true,
      branch: parsed.branch,
      repositoryRoot: repoRoot.trim() || null,
      entries: parsed.entries,
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        isGitRepository: false,
        branch: null,
        repositoryRoot: null,
        entries: [],
      };
    }
    throw error;
  }
}

export async function getGitDiffForPath(
  workingDirectory: string,
  options: { path: string; section: GitChangeSection; kind: GitChangeKind },
): Promise<GitDiffView> {
  const path = normalizeRelativePath(options.path);
  if (!path) {
    throw new Error('path required');
  }
  if (!isSafeWorkspacePath(workingDirectory, path)) {
    throw new Error('path traversal not allowed');
  }

  let before: GitDiffSnapshot;
  let after: GitDiffSnapshot;
  let beforeLabel: string;
  let afterLabel: string;

  switch (options.section) {
    case 'staged':
      before = await readGitSnapshot(workingDirectory, `HEAD:${path}`);
      after = await readGitSnapshot(workingDirectory, `:${path}`);
      beforeLabel = 'HEAD';
      afterLabel = 'Index';
      break;
    case 'unstaged':
      before = await readGitSnapshot(workingDirectory, `:${path}`);
      after = await readWorktreeSnapshot(workingDirectory, path);
      beforeLabel = 'Index';
      afterLabel = 'Working tree';
      break;
    case 'untracked':
      before = emptySnapshot();
      after = await readWorktreeSnapshot(workingDirectory, path);
      beforeLabel = 'Empty';
      afterLabel = 'Working tree';
      break;
    default:
      before = emptySnapshot();
      after = emptySnapshot();
      beforeLabel = 'Empty';
      afterLabel = 'Empty';
      break;
  }

  return {
    path,
    kind: options.kind,
    section: options.section,
    staged: options.section === 'staged',
    before,
    after,
    beforeLabel,
    afterLabel,
    isBinary: before.isBinary || after.isBinary,
  };
}

export async function stageGitPath(workingDirectory: string, relativePath: string) {
  const path = normalizeRelativePath(relativePath);
  if (!path) throw new Error('path required');
  if (!isSafeWorkspacePath(workingDirectory, path)) {
    throw new Error('path traversal not allowed');
  }
  await runGitText(workingDirectory, ['add', '--', path]);
}

export async function unstageGitPath(workingDirectory: string, relativePath: string) {
  const path = normalizeRelativePath(relativePath);
  if (!path) throw new Error('path required');
  if (!isSafeWorkspacePath(workingDirectory, path)) {
    throw new Error('path traversal not allowed');
  }
  await runGitText(workingDirectory, ['restore', '--staged', '--', path]);
}

export async function rollbackAllGitChanges(workingDirectory: string) {
  await runGitText(workingDirectory, ['restore', '--staged', '.']);
  await runGitText(workingDirectory, ['restore', '.']);
  await runGitText(workingDirectory, ['clean', '-fd']);
}

export async function ensureMissionGitRepository(workingDirectory: string): Promise<string> {
  const status = await getGitWorkspaceStatus(workingDirectory);
  let repositoryRoot = status.repositoryRoot;

  if (!status.isGitRepository) {
    await runGitText(workingDirectory, ['init', '--initial-branch=main']);
    repositoryRoot = (await runGitText(workingDirectory, ['rev-parse', '--show-toplevel'])).trim();
  }
  if (!repositoryRoot) throw new Error('无法初始化 Git 工作目录');

  try {
    await runGitText(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    await ensureAiTeamExcluded(repositoryRoot);
    await runGitText(repositoryRoot, ['add', '-A', '--', '.']);
    await runGitText(repositoryRoot, [
      '-c',
      'user.name=Octrix',
      '-c',
      'user.email=octrix@localhost',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      'chore: initialize repository',
    ]);
  }

  return repositoryRoot;
}

export async function prepareMissionGitBranch(
  workingDirectory: string,
  missionId: string,
  missionTitle: string,
): Promise<MissionGitBaseline> {
  const repositoryRoot = await ensureMissionGitRepository(workingDirectory);
  await ensureAiTeamExcluded(repositoryRoot);

  const status = await getGitWorkspaceStatus(repositoryRoot);
  if (status.entries.length > 0) {
    throw new Error(`工作区必须干净：${status.entries.map(entry => entry.path).join('、')}`);
  }

  const baseBranch = (await runGitText(repositoryRoot, ['branch', '--show-current'])).trim();
  if (!baseBranch) throw new Error('代码任务不能从 detached HEAD 启动');
  const baseCommit = (await runGitText(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  const titleSlug = slugSegment(missionTitle, 36) || 'task';
  const missionSlug = slugSegment(missionId, 9) || 'mission';
  const taskBranch = `octrix/${titleSlug}-${missionSlug}`;
  await runGitText(repositoryRoot, ['switch', '-c', taskBranch]);

  return {
    repositoryRoot,
    baseBranch,
    baseCommit,
    taskBranch,
    preparedAt: Date.now() / 1000,
  };
}

export async function captureImplementationRevision(
  workingDirectory: string,
  baseline: MissionGitBaseline,
  revisionNumber: number,
): Promise<GitRevisionSnapshot> {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new Error('实现修订编号必须从 1 开始');
  }
  const repositoryRoot = (await runGitText(workingDirectory, ['rev-parse', '--show-toplevel'])).trim();
  const branch = (await runGitText(repositoryRoot, ['branch', '--show-current'])).trim();
  if (branch !== baseline.taskBranch) {
    throw new Error(`当前分支不是任务分支：${baseline.taskBranch}`);
  }
  const status = await getGitWorkspaceStatus(repositoryRoot);
  const trackedChanges = (await runGitBuffer(
    repositoryRoot,
    ['diff', '--name-only', '-z', baseline.baseCommit, '--'],
  )).toString('utf-8').split('\0').filter(Boolean);
  const changedFiles = [...new Set(
    [
      ...trackedChanges,
      ...status.entries.map(entry => entry.path),
    ].filter(file => !isAiTeamPath(file)),
  )].sort();
  if (changedFiles.length === 0) throw new Error('当前没有可生成实现修订的项目改动');

  const tempDirectory = await mkdtemp(join(tmpdir(), 'octrix-revision-index-'));
  const indexPath = join(tempDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await execFileAsync('git', ['read-tree', baseline.baseCommit], {
      cwd: repositoryRoot,
      env,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    await execFileAsync('git', ['add', '-A', '--', '.'], {
      cwd: repositoryRoot,
      env,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--cached', '--binary', '--no-ext-diff', baseline.baseCommit, '--'],
      {
        cwd: repositoryRoot,
        env,
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
    const patchBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const patch = patchBuffer.toString('utf-8');
    if (!patch) throw new Error('实现修订没有可记录的 diff');
    return {
      id: `R${String(revisionNumber).padStart(3, '0')}`,
      baseCommit: baseline.baseCommit,
      branch,
      contentHash: createHash('sha256').update(patchBuffer).digest('hex'),
      changedFiles,
      patch,
      createdAt: Date.now() / 1000,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function ensureAiTeamExcluded(repositoryRoot: string) {
  const gitPath = (await runGitText(repositoryRoot, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const excludePath = isAbsolute(gitPath) ? gitPath : resolve(repositoryRoot, gitPath);
  let current = '';
  try {
    current = await readFile(excludePath, 'utf-8');
  } catch { /* create below */ }
  const lines = current.split(/\r?\n/).map(line => line.trim());
  if (lines.includes('.ai-team/')) return;
  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(excludePath, `${prefix}.ai-team/\n`, 'utf-8');
}

function slugSegment(value: string, maxLength: number) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
