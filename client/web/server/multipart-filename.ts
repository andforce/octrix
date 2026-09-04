/**
 * Browsers send UTF-8 filenames in multipart; some stacks expose those bytes as a
 * latin1 string, producing mojibake (e.g. 测试 → æµ‹è¯•). Re-decode when safe.
 * If the name already contains characters outside U+00FF (e.g. proper 中文), keep it.
 */
export function decodeMultipartFilename(name: string): string {
  if (!name) return '';
  const hasCharOutsideLatin1 = [...name].some(c => c.charCodeAt(0) > 0xff);
  if (hasCharOutsideLatin1) return name;
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  if (utf8.includes('\uFFFD')) return name;
  return utf8;
}
