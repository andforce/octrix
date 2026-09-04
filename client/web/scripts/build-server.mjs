import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'dist-server');
const runtimeNodeModulesDir = resolve(outDir, 'node_modules');
const runtimeModules = ['node-pty', 'node-addon-api'];

function ensureNodePtyHelpersExecutable(baseDir) {
  const prebuildRoots = [
    resolve(baseDir, 'node_modules', 'node-pty', 'prebuilds'),
    resolve(baseDir, 'prebuilds'),
  ];
  for (const prebuildsDir of prebuildRoots) {
    for (const platformDir of ['darwin-arm64', 'darwin-x64']) {
      const helperPath = resolve(prebuildsDir, platformDir, 'spawn-helper');
      if (existsSync(helperPath)) {
        chmodSync(helperPath, 0o755);
      }
    }
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(runtimeNodeModulesDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'server/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(outDir, 'index.mjs'),
  banner: {
    js: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: true,
  external: ['node-pty'],
});

for (const moduleName of runtimeModules) {
  cpSync(
    resolve(root, 'node_modules', moduleName),
    resolve(runtimeNodeModulesDir, moduleName),
    { recursive: true },
  );
}

ensureNodePtyHelpersExecutable(root);
ensureNodePtyHelpersExecutable(outDir);

console.log('[build-server] Server bundled to dist-server/ with runtime node modules');
