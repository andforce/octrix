import { describe, expect, it } from 'vitest';
import { formatDeviceCode, normalizeDeviceCode, safeNext } from './api';

describe('授权页面输入处理', () => {
  it('忽略设备码中的空格、连字符和大小写', () => {
    expect(normalizeDeviceCode(' abcd - efgh ')).toBe('ABCDEFGH');
    expect(formatDeviceCode('abcd efgh')).toBe('ABCD-EFGH');
  });

  it('只接受站内登录后跳转路径', () => {
    expect(safeNext('/authorize/device?token=abc')).toBe('/authorize/device?token=abc');
    expect(safeNext('//evil.example')).toBe('/dashboard');
    expect(safeNext('https://evil.example')).toBe('/dashboard');
  });
});
