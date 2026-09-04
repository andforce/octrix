import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outputDir = resolve(root, 'release-host');
const staging = resolve(root, '.host-package');

function targetArch() {
  const explicit = process.argv.find(argument => argument.startsWith('--arch='))?.slice(7);
  const target = explicit || process.env.TAURI_ENV_TARGET_TRIPLE || process.arch;
  if (['arm64', 'aarch64', 'aarch64-apple-darwin'].some(value => target.startsWith(value))) return 'arm64';
  if (['x64', 'x86_64', 'x86_64-apple-darwin'].some(value => target.startsWith(value))) return 'x64';
  throw new Error(`不支持的 Octrix Host 架构：${target}`);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const arch = targetArch();
const required = ['dist-runtime/node', 'dist-server/index.mjs', 'dist-server/node_modules', 'dist/index.html', 'host/install.sh', 'host/bin/octrix'];
for (const entry of required) {
  if (!existsSync(resolve(root, entry))) throw new Error(`缺少 Host 构建产物：${entry}`);
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(outputDir, { recursive: true });
for (const entry of ['dist-runtime', 'dist-server', 'dist', 'host']) {
  cpSync(resolve(root, entry), resolve(staging, entry), { recursive: true });
}
chmodSync(resolve(staging, 'dist-runtime/node'), 0o755);
chmodSync(resolve(staging, 'host/install.sh'), 0o755);
chmodSync(resolve(staging, 'host/bin/octrix'), 0o755);

const packageMetadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(resolve(staging, 'host-manifest.json'), JSON.stringify({
  name: 'Octrix Host',
  version: process.env.OCTRIX_HOST_VERSION || packageMetadata.version,
  arch,
  includes: ['AI process host', 'Web terminal TUI', 'Octrix Cloud connector', 'octrix CLI'],
}, null, 2));

const archive = resolve(outputDir, `Octrix-Host-${arch}.tar.gz`);
const result = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', staging, '.'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`创建 Host 安装包失败：${result.stderr.trim()}`);

const digest = await sha256(archive);
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
rmSync(staging, { recursive: true, force: true });
console.log(`[build-host] 已生成 ${archive}`);
console.log(`[build-host] SHA-256 ${digest}`);
