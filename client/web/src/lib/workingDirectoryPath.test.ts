import { describe, expect, it } from 'vitest';
import type { AgentGroup } from '../types';
import { findGroupWithSameWorkingDirectory, normalizeWorkingDirectoryKey } from './workingDirectoryPath';

describe('normalizeWorkingDirectoryKey', () => {
  it('strips trailing slashes and collapses POSIX segments', () => {
    expect(normalizeWorkingDirectoryKey('/foo/bar/')).toBe('/foo/bar');
    expect(normalizeWorkingDirectoryKey('/foo//bar')).toBe('/foo/bar');
  });

  it('normalizes Windows-style paths', () => {
    expect(normalizeWorkingDirectoryKey('C:\\Proj\\')).toBe('c:/proj');
  });
});

describe('findGroupWithSameWorkingDirectory', () => {
  const base: AgentGroup = {
    id: 'g1',
    name: 'G',
    ownerName: '群主',
    members: [],
    workingDirectory: '/tmp/project',
    groupType: 'collaboration',
    createdAt: 0,
  };

  it('finds group when picked path matches existing directory', () => {
    expect(findGroupWithSameWorkingDirectory([base], '/tmp/project')).toEqual(base);
    expect(findGroupWithSameWorkingDirectory([base], '/tmp/project/')).toEqual(base);
  });

  it('returns undefined when groups is empty or path is new', () => {
    expect(findGroupWithSameWorkingDirectory([], '/tmp/project')).toBeUndefined();
    expect(findGroupWithSameWorkingDirectory([base], '/tmp/other')).toBeUndefined();
  });
});
