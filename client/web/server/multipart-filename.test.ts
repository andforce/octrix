import { describe, expect, it } from 'vitest';
import { decodeMultipartFilename } from './multipart-filename';

describe('decodeMultipartFilename', () => {
  it('recovers UTF-8 CJK names from latin1-misread bytes', () => {
    const mojibake = Buffer.from('测试.txt', 'utf8').toString('latin1');
    expect(decodeMultipartFilename(mojibake)).toBe('测试.txt');
  });

  it('leaves already-correct Unicode names unchanged', () => {
    expect(decodeMultipartFilename('测试.txt')).toBe('测试.txt');
  });

  it('leaves ASCII unchanged', () => {
    expect(decodeMultipartFilename('readme.md')).toBe('readme.md');
  });
});
