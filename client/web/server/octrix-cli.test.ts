import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getOctrixCliStatus, installOctrixCli } from './octrix-cli.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('octrix CLI 安装器', () => {
  it('无需桌面 App 即可启动已安装的 Octrix Host', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-host-home-'));
    dirs.push(home);
    const cli = path.resolve('host/bin/octrix');
    const stateFile = path.join(home, 'host-started');
    const launchctlLog = path.join(home, 'launchctl.log');
    const openLog = path.join(home, 'open.log');
    const launchctl = path.join(home, 'launchctl');
    const curl = path.join(home, 'curl');
    const open = path.join(home, 'open');
    const plist = path.join(home, 'Library', 'LaunchAgents', 'work.octrix.host.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    fs.writeFileSync(launchctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${launchctlLog}"\nif [[ "$*" == *kickstart* ]]; then touch "${stateFile}"; fi\n`);
    fs.writeFileSync(curl, `#!/usr/bin/env bash\nif [[ "$*" == *:9800/* ]]; then printf '{"ok":true}'; elif [[ -f "${stateFile}" ]]; then printf '{"ok":true}'; else exit 7; fi\n`);
    fs.writeFileSync(open, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${openLog}"\n`);
    fs.chmodSync(launchctl, 0o755);
    fs.chmodSync(curl, 0o755);
    fs.chmodSync(open, 0o755);

    const output = await new Promise<string>((resolve, reject) => {
      execFile(cli, ['start'], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_START_WAIT_ATTEMPTS: '3',
          OCTRIX_START_WAIT_INTERVAL: '0.01',
        },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });

    expect(fs.readFileSync(launchctlLog, 'utf8')).toContain('kickstart');
    expect(output).toContain('Octrix Host 已启动');

    await new Promise<void>((resolve, reject) => {
      execFile(cli, ['webtui'], {
        env: {
          ...process.env,
          HOME: home,
          OCTRIX_LAUNCHCTL: launchctl,
          OCTRIX_CURL: curl,
          OCTRIX_OPEN: open,
        },
      }, error => error ? reject(error) : resolve());
    });
    expect(fs.readFileSync(openLog, 'utf8').trim()).toBe('http://127.0.0.1:39800');
  });

  it('区分未安装、需要更新和当前版本', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    expect(getOctrixCliStatus(home).state).toBe('not_installed');

    const target = installOctrixCli(home);
    expect(getOctrixCliStatus(home)).toEqual({ path: target, state: 'current' });

    fs.appendFileSync(target, '\n# old launcher');
    expect(getOctrixCliStatus(home).state).toBe('outdated');
  });

  it('只安装调用本机服务的 0755 启动器', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);
    const content = fs.readFileSync(target, 'utf8');
    expect(target).toBe(path.join(home, '.local', 'bin', 'octrix'));
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(content).toContain('127.0.0.1');
    expect(content).not.toContain('octrix.work');
    expect(content).not.toContain('RELAY_TOKEN');
  });

  it('帮助中公开 auth、webtui 和 logout 命令，并移除旧命令', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);

    const output = await new Promise<string>((resolve, reject) => {
      execFile(target, ['--help'], (error, stdout) => error ? reject(error) : resolve(stdout));
    });

    expect(output).toContain('auth [--device-code]');
    expect(output).toContain('webtui');
    expect(output).toContain('logout');
    expect(output).toContain('退出账号并断开云端连接');
    expect(output).not.toMatch(/^\s+login(?:\s|$)/m);
    expect(output).not.toMatch(/^\s+open(?:\s|$)/m);
  });

  it('logout 通过本机 Host 退出账号', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);
    let logoutMethod = '';
    const server = createServer((request, response) => {
      if (request.url === '/v1/health') {
        response.writeHead(200).end('{"ok":true}');
        return;
      }
      if (request.url === '/api/relay/logout') {
        logoutMethod = request.method ?? '';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(target, ['logout'], {
          env: { ...process.env, OCTRIX_LOCAL_PORT: String(port) },
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });

      expect(logoutMethod).toBe('POST');
      expect(output).toContain('已退出 Octrix');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('auth 向本机服务发送有效 JSON 并等待账号授权', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);
    let receivedMode = '';
    let statusChecks = 0;
    const server = createServer((request, response) => {
      if (request.url === '/v1/health') {
        response.writeHead(200).end('{"ok":true}');
        return;
      }
      if (request.url === '/api/relay/auth/start') {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          receivedMode = (JSON.parse(Buffer.concat(chunks).toString()) as { mode: string }).mode;
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ authorizationState: 'pending', verificationUri: 'https://remote.example/activate' }));
        });
        return;
      }
      if (request.url === '/api/relay/status') {
        statusChecks += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          authorizationState: 'authorized', accountLabel: 'alice@example.com',
          connected: statusChecks >= 4, url: 'https://remote.example',
        }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(target, ['auth'], { env: {
          ...process.env,
          OCTRIX_LOCAL_PORT: String(port),
          OCTRIX_AUTH_WAIT_INTERVAL: '0.01',
          OCTRIX_CONNECT_WAIT_INTERVAL: '0.01',
        } }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      expect(receivedMode).toBe('browser');
      expect(output).toContain('alice@example.com');
      expect(output).toContain('连接：在线');
      expect(statusChecks).toBeGreaterThanOrEqual(4);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('auth --device-code 输出授权网址和设备码', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);
    let receivedMode = '';
    const server = createServer((request, response) => {
      if (request.url === '/v1/health') {
        response.writeHead(200).end('{"ok":true}');
        return;
      }
      if (request.url === '/api/relay/auth/start') {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
          receivedMode = (JSON.parse(Buffer.concat(chunks).toString()) as { mode: string }).mode;
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            authorizationState: 'pending',
            verificationUri: 'https://remote.example/activate',
            userCode: 'ABCD-EFGH',
          }));
        });
        return;
      }
      if (request.url === '/api/relay/status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          authorizationState: 'authorized', accountLabel: 'alice@example.com',
          connected: true, url: 'https://remote.example',
        }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(target, ['auth', '--device-code'], { env: {
          ...process.env,
          OCTRIX_LOCAL_PORT: String(port),
          OCTRIX_AUTH_WAIT_INTERVAL: '0.01',
        } }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      expect(receivedMode).toBe('device_code');
      expect(output).toContain('https://remote.example/activate');
      expect(output).toContain('ABCD-EFGH');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['login', 'open'])('拒绝旧命令 %s', async command => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octrix-cli-home-'));
    dirs.push(home);
    const target = installOctrixCli(home);

    await expect(new Promise<void>((resolve, reject) => {
      execFile(target, [command], error => error ? reject(error) : resolve());
    })).rejects.toMatchObject({ code: 2 });
  });
});
