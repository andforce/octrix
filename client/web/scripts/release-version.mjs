import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const THREE_PART_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function isReleaseVersion(value) {
  return THREE_PART_VERSION.test(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = isReleaseVersion(process.argv[2] ?? '') ? 0 : 1;
}
