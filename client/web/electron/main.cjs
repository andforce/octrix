const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_PORT = Number(process.env.CLI_BRIDGE_PORT || 39800);
const IS_DEV = !app.isPackaged;

function augmentedPath() {
  const home = process.env.HOME || '';
  const parts = [
    home && path.join(home, '.local/bin'),
    home && path.join(home, '.cargo/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean);
  return [...new Set(parts)].join(':');
}

function installAndStartHost() {
  const installer = path.join(process.resourcesPath, 'host', 'install.sh');
  if (!fs.existsSync(installer)) {
    return Promise.reject(new Error(`Octrix Host 安装器不存在：${installer}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [installer, '--source-root', process.resourcesPath], {
      env: { ...process.env, PATH: augmentedPath(), OCTRIX_LOCAL_PORT: String(DEFAULT_PORT) },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Octrix Host 安装失败（code=${code}, signal=${signal || 'none'}）`));
    });
  });
}

function waitForHost(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Octrix Host 未能在 ${timeoutMs / 1000} 秒内启动`));
          return;
        }
        setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

function createWindow(loadUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    title: 'Octrix',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true,
    },
  });
  if (process.env.OCTRIX_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  return win.loadURL(loadUrl);
}

async function bootstrap() {
  if (IS_DEV) {
    await createWindow('http://localhost:5173');
    return;
  }
  await installAndStartHost();
  await waitForHost(DEFAULT_PORT);
  await createWindow(`http://127.0.0.1:${DEFAULT_PORT}`);
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Octrix 启动失败', message);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const url = IS_DEV ? 'http://localhost:5173' : `http://127.0.0.1:${DEFAULT_PORT}`;
      createWindow(url).catch(() => {});
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
