import { describe, expect, it } from 'vitest';
import { isReleaseVersion } from './release-version.mjs';

describe('isReleaseVersion', () => {
  it.each(['0.0.0', '1.0.3', '10.20.30'])(
    '接受三段式版本 %s',
    (version) => expect(isReleaseVersion(version)).toBe(true),
  );

  it.each([
    '',
    '1.0',
    '1.0.3.0',
    '01.0.3',
    '1.00.3',
    '1.0.03',
    '1.0.3-beta.1',
    '2026.09.04.19.30',
  ])('拒绝非三段式版本 %s', (version) => {
    expect(isReleaseVersion(version)).toBe(false);
  });
});
