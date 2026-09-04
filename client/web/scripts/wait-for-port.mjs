import net from 'node:net';

const rawPort = process.env.CLI_BRIDGE_PORT ?? '39800';
const port = Number.parseInt(rawPort, 10);
const host = '127.0.0.1';
const timeoutMs = 10000;
const retryIntervalMs = 150;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[wait-for-port] Invalid port: ${rawPort}`);
  process.exit(1);
}

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.once('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.once('error', () => {
      cleanup();
      resolve(false);
    });
  });
}

const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
  if (await isPortOpen()) {
    console.log(`[wait-for-port] Backend is ready on ${host}:${port}.`);
    process.exit(0);
  }

  await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
}

console.error(`[wait-for-port] Timed out waiting for ${host}:${port}.`);
process.exit(1);
