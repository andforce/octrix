import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureImplementationRevision, prepareMissionGitBranch } from './git';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-git-mission-'));
  tempDirs.push(repository);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Octrix Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'octrix@example.com'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), '# Project\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repository });
  return repository;
}

describe('git collaboration preparation', () => {
  it('records the clean baseline and creates a local task branch', async () => {
    const repository = makeRepository();
    fs.mkdirSync(path.join(repository, '.ai-team'), { recursive: true });
    fs.writeFileSync(path.join(repository, '.ai-team', 'context.md'), '# local state\n', 'utf-8');
    const expectedBase = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf-8',
    }).trim();

    const baseline = await prepareMissionGitBranch(
      repository,
      'mission-12345678',
      'Fix Login Flow',
    );

    expect(baseline).toEqual({
      repositoryRoot: fs.realpathSync(repository),
      baseBranch: 'main',
      baseCommit: expectedBase,
      taskBranch: 'octrix/fix-login-flow-mission-1',
      preparedAt: expect.any(Number),
    });
    expect(execFileSync('git', ['branch', '--show-current'], {
      cwd: repository,
      encoding: 'utf-8',
    }).trim()).toBe('octrix/fix-login-flow-mission-1');
    expect(fs.readFileSync(path.join(repository, '.git', 'info', 'exclude'), 'utf-8')).toContain('.ai-team/');
  });

  it('refuses to create a task branch when project files are already dirty', async () => {
    const repository = makeRepository();
    fs.writeFileSync(path.join(repository, 'README.md'), '# Existing user change\n', 'utf-8');

    await expect(prepareMissionGitBranch(
      repository,
      'mission-dirty',
      'Dirty Task',
    )).rejects.toThrow('工作区必须干净：README.md');

    expect(execFileSync('git', ['branch', '--show-current'], {
      cwd: repository,
      encoding: 'utf-8',
    }).trim()).toBe('main');
  });

  it('captures tracked and untracked project changes in one immutable revision patch', async () => {
    const repository = makeRepository();
    const baseline = await prepareMissionGitBranch(repository, 'mission-revision', 'Revision Task');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Updated Project\n', 'utf-8');
    fs.mkdirSync(path.join(repository, 'src'));
    fs.writeFileSync(path.join(repository, 'src', 'login.ts'), 'export const login = true;\n', 'utf-8');
    fs.mkdirSync(path.join(repository, '.ai-team'), { recursive: true });
    fs.writeFileSync(path.join(repository, '.ai-team', 'runtime.md'), '# local\n', 'utf-8');

    const revision = await captureImplementationRevision(repository, baseline, 1);

    expect(revision.id).toBe('R001');
    expect(revision.baseCommit).toBe(baseline.baseCommit);
    expect(revision.branch).toBe(baseline.taskBranch);
    expect(revision.changedFiles).toEqual(['README.md', 'src/login.ts']);
    expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(revision.patch).toContain('diff --git a/README.md b/README.md');
    expect(revision.patch).toContain('diff --git a/src/login.ts b/src/login.ts');
    expect(revision.patch).not.toContain('.ai-team');
  });

  it('captures changes already committed on the task branch relative to the mission baseline', async () => {
    const repository = makeRepository();
    const baseline = await prepareMissionGitBranch(repository, 'mission-committed', 'Committed Change');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Externally committed change\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'feat: external change'], { cwd: repository });
    expect(execFileSync('git', ['status', '--porcelain'], {
      cwd: repository,
      encoding: 'utf-8',
    })).toBe('');

    const revision = await captureImplementationRevision(repository, baseline, 1);

    expect(revision.changedFiles).toEqual(['README.md']);
    expect(revision.patch).toContain('# Externally committed change');
    expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
