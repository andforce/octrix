import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('Octrix Host 安装器', () => {
  it('在没有旧版 LaunchAgent 的全新 Mac 上安装 octrix 命令', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-clean-home-'));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-clean-source-'));
    dirs.push(home, source);

    for (const directory of ['dist-runtime', 'dist-server/node_modules', 'dist', 'host/bin']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'dist-runtime', 'node'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(source, 'dist-server', 'index.mjs'), 'console.log("host");\n');
    fs.writeFileSync(path.join(source, 'dist', 'index.html'), '<main>Octrix TUI</main>\n');
    fs.copyFileSync(path.resolve('host/bin/octrix'), path.join(source, 'host/bin/octrix'));

    const stateFile = path.join(home, 'host-started');
    const launchctl = path.join(home, 'launchctl');
    const curl = path.join(home, 'curl');
    fs.writeFileSync(launchctl, `#!/usr/bin/env bash\nif [[ "$*" == *bootstrap* || "$*" == *kickstart* ]]; then touch "${stateFile}"; fi\n`);
    fs.writeFileSync(curl, `#!/usr/bin/env bash\n[[ -f "${stateFile}" ]] && printf '{"ok":true}' || exit 7\n`);
    fs.chmodSync(launchctl, 0o755);
    fs.chmodSync(curl, 0o755);

    await new Promise<void>((resolve, reject) => {
      execFile(path.resolve('host/install.sh'), ['--source-root', source], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_START_WAIT_INTERVAL: '0.01',
        },
      }, error => error ? reject(error) : resolve());
    });

    expect(fs.statSync(path.join(home, '.local/bin/octrix')).mode & 0o111).not.toBe(0);
  });

  it('安装独立运行时、Web TUI、CLI 和登录后常驻服务', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-install-home-'));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-install-source-'));
    dirs.push(home, source);

    for (const directory of ['dist-runtime', 'dist-server/node_modules', 'dist', 'host/bin']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'dist-runtime', 'node'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(source, 'dist-server', 'index.mjs'), 'console.log("host");\n');
    fs.writeFileSync(path.join(source, 'dist', 'index.html'), '<main>Octrix TUI</main>\n');
    fs.copyFileSync(path.resolve('host/bin/octrix'), path.join(source, 'host/bin/octrix'));

    const stateFile = path.join(home, 'host-started');
    const launchctlLog = path.join(home, 'launchctl.log');
    const launchctl = path.join(home, 'launchctl');
    const curl = path.join(home, 'curl');
    const legacyPlist = path.join(home, 'Library/LaunchAgents/com.octrix.local-dev.plist');
    fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
    fs.writeFileSync(legacyPlist, '<plist/>');
    fs.writeFileSync(launchctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${launchctlLog}"\nif [[ "$*" == *bootstrap* || "$*" == *kickstart* ]]; then touch "${stateFile}"; fi\n`);
    fs.writeFileSync(curl, `#!/usr/bin/env bash\n[[ -f "${stateFile}" ]] && printf '{"ok":true}' || exit 7\n`);
    fs.chmodSync(launchctl, 0o755);
    fs.chmodSync(curl, 0o755);

    const output = await new Promise<string>((resolve, reject) => {
      execFile(path.resolve('host/install.sh'), ['--source-root', source], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_START_WAIT_INTERVAL: '0.01',
        },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });

    const current = path.join(home, '.local/share/octrix-host/current');
    expect(fs.readFileSync(path.join(current, 'web/index.html'), 'utf8')).toContain('Octrix TUI');
    expect(fs.existsSync(path.join(current, 'server/index.mjs'))).toBe(true);
    expect(fs.statSync(path.join(current, 'runtime/node')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(home, '.local/bin/octrix')).mode & 0o111).not.toBe(0);
    const plist = fs.readFileSync(path.join(home, 'Library/LaunchAgents/work.octrix.host.plist'), 'utf8');
    expect(plist).toContain('work.octrix.host');
    expect(plist).toContain(path.join(current, 'server/index.mjs'));
    expect(fs.readFileSync(launchctlLog, 'utf8')).toContain('disable gui/');
    expect(fs.readFileSync(launchctlLog, 'utf8')).toContain('com.octrix.local-dev');
    expect(output).toContain('Octrix Host 安装完成');

    await new Promise<void>((resolve, reject) => {
      execFile(path.resolve('host/install.sh'), ['--source-root', source], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_CLOUD_URL: 'https://relay.example.com',
          OCTRIX_INSTALL_SKIP_PERMISSIONS: '1',
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_START_WAIT_INTERVAL: '0.01',
        },
      }, error => error ? reject(error) : resolve());
    });

    expect(fs.readFileSync(path.join(home, 'Library/LaunchAgents/work.octrix.host.plist'), 'utf8'))
      .toContain('https://relay.example.com');
  });

  it('全新安装时在命令行确认并由后台 Host 申请受保护文件夹权限', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-permission-home-'));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-permission-source-'));
    dirs.push(home, source);

    for (const directory of ['dist-runtime', 'dist-server/node_modules', 'dist', 'host/bin']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'dist-runtime', 'node'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(source, 'dist-server', 'index.mjs'), 'console.log("host");\n');
    fs.writeFileSync(path.join(source, 'dist', 'index.html'), '<main>Octrix TUI</main>\n');
    fs.copyFileSync(path.resolve('host/bin/octrix'), path.join(source, 'host/bin/octrix'));

    const stateFile = path.join(home, 'host-started');
    const launchctl = path.join(home, 'launchctl');
    const curl = path.join(home, 'curl');
    const curlLog = path.join(home, 'curl.log');
    fs.writeFileSync(launchctl, `#!/usr/bin/env bash\nif [[ "$*" == *bootstrap* || "$*" == *kickstart* ]]; then touch "${stateFile}"; fi\n`);
    fs.writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${curlLog}"\nif [[ "$*" == *api/system/permissions/files* ]]; then\n  printf '{"ok":true,"folders":[{"name":"Desktop","granted":true},{"name":"Documents","granted":true},{"name":"Downloads","granted":true}]}'\nelif [[ -f "${stateFile}" ]]; then\n  printf '{"ok":true}'\nelse\n  exit 7\nfi\n`);
    fs.chmodSync(launchctl, 0o755);
    fs.chmodSync(curl, 0o755);

    const install = () => new Promise<string>((resolve, reject) => {
      execFile(path.resolve('host/install.sh'), ['--source-root', source], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_PERMISSION_AUTO_CONFIRM: '1',
          OCTRIX_START_WAIT_INTERVAL: '0.01',
        },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });

    const firstOutput = await install();
    expect(firstOutput).toContain('按回车');
    expect(firstOutput).toContain('桌面、文稿和下载');
    expect(fs.readFileSync(curlLog, 'utf8')).toContain('/api/system/permissions/files');

    await install();
    const permissionRequests = fs.readFileSync(curlLog, 'utf8')
      .split('\n')
      .filter(line => line.includes('/api/system/permissions/files'));
    expect(permissionRequests).toHaveLength(1);
  });
});
