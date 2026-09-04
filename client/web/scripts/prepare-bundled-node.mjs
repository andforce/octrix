import { createWriteStream } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'dist-runtime');
const cacheRoot = resolve(root, '.cache', 'bundled-node');

function inferTargetTriple() {
  const explicit = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (explicit) return explicit;

  const archMap = {
    arm64: 'aarch64',
    x64: 'x86_64',
  };

  if (process.platform !== 'darwin') {
    throw new Error(`Bundled Node is only configured for macOS builds, got ${process.platform}`);
  }

  const arch = archMap[process.arch];
  if (!arch) {
    throw new Error(`Unsupported host architecture: ${process.arch}`);
  }

  return `${arch}-apple-darwin`;
}

function nodeArchForTarget(targetTriple) {
  if (targetTriple.startsWith('aarch64-apple-darwin')) return 'arm64';
  if (targetTriple.startsWith('x86_64-apple-darwin')) return 'x64';
  if (targetTriple.startsWith('universal-apple-darwin')) return 'universal';
  throw new Error(`Unsupported target triple for bundled Node: ${targetTriple}`);
}

function tarBinary() {
  const result = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error('The `tar` command is required to unpack the bundled Node runtime.');
  }
  return 'tar';
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function main() {
  const targetTriple = inferTargetTriple();
  const nodeArch = nodeArchForTarget(targetTriple);
  const nodeVersion = (process.env.OCTRIX_NODE_VERSION || process.version).replace(/^v/, '');
  const outputBinary = resolve(outDir, 'node');
  const outputMeta = resolve(outDir, 'metadata.json');

  mkdirSync(cacheRoot, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  async function ensureExtractedBinary(arch) {
    const archiveBase = `node-v${nodeVersion}-darwin-${arch}`;
    const archiveName = `${archiveBase}.tar.gz`;
    const archiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
    const targetCacheDir = resolve(cacheRoot, archiveBase);
    const archivePath = resolve(cacheRoot, archiveName);
    const extractedBinary = resolve(targetCacheDir, archiveBase, 'bin', 'node');

    if (!existsSync(extractedBinary)) {
      if (!existsSync(archivePath)) {
        console.log(`[bundle-node] Downloading ${archiveUrl}`);
        await download(archiveUrl, archivePath);
      } else {
        console.log(`[bundle-node] Reusing cached archive ${archiveName}`);
      }

      rmSync(targetCacheDir, { recursive: true, force: true });
      mkdirSync(targetCacheDir, { recursive: true });
      const tar = tarBinary();
      const extract = spawnSync(
        tar,
        ['-xzf', archivePath, '-C', targetCacheDir],
        { encoding: 'utf-8' },
      );
      if (extract.status !== 0) {
        throw new Error(`Failed to extract ${archiveName}: ${extract.stderr.trim()}`);
      }
    } else {
      console.log(`[bundle-node] Reusing extracted Node ${archiveBase}`);
    }

    return { extractedBinary, archiveUrl };
  }

  let metadata;
  if (nodeArch === 'universal') {
    const arm64 = await ensureExtractedBinary('arm64');
    const x64 = await ensureExtractedBinary('x64');
    const lipo = spawnSync(
      'lipo',
      ['-create', '-output', outputBinary, arm64.extractedBinary, x64.extractedBinary],
      { encoding: 'utf-8' },
    );
    if (lipo.status !== 0) {
      throw new Error(`Failed to create universal Node binary: ${lipo.stderr.trim()}`);
    }
    metadata = {
      version: nodeVersion,
      targetTriple,
      arch: nodeArch,
      source: [arm64.archiveUrl, x64.archiveUrl],
    };
  } else {
    const { extractedBinary, archiveUrl } = await ensureExtractedBinary(nodeArch);
    copyFileSync(extractedBinary, outputBinary);
    metadata = {
      version: nodeVersion,
      targetTriple,
      arch: nodeArch,
      source: archiveUrl,
    };
  }
  chmodSync(outputBinary, 0o755);

  writeFileSync(
    outputMeta,
    JSON.stringify(metadata, null, 2),
    'utf-8',
  );

  const bundledVersion = readFileSync(outputMeta, 'utf-8');
  console.log(`[bundle-node] Bundled Node ${nodeVersion} for ${targetTriple}`);
  if (!bundledVersion.includes(nodeVersion)) {
    throw new Error('Failed to write bundled Node metadata');
  }
}

await main();
