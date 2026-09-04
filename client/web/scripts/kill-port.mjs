import { execSync } from 'node:child_process';

const rawPort = process.env.CLI_BRIDGE_PORT ?? '9800';
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[kill-port] Invalid port: ${rawPort}`);
  process.exit(1);
}

try {
  const stdout = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const pids = stdout.split('\n').map(pid => pid.trim()).filter(Boolean);

  if (pids.length === 0) {
    console.log(`[kill-port] Port ${port} is free.`);
    process.exit(0);
  }

  execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' });
  console.log(`[kill-port] Killed process(es) on port ${port}: ${pids.join(', ')}`);
} catch {
  console.log(`[kill-port] Port ${port} is free.`);
}
