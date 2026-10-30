import { createServer, connect, type Socket } from 'node:net';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareSandbox, type SandboxOptions, type SandboxLaunch } from '../../src/backend/sandbox';
import { nodeExecutable } from './platform';

/** Bubblewrap has no TCP port allowlist. Relay one parent gateway over one Unix socket. */
export async function benchmarkSandbox(options: SandboxOptions, executable: string, args: string[]): Promise<SandboxLaunch> {
  if (process.platform !== 'linux' || !options.localhostPort) return prepareSandbox(options, executable, args);
  const port = options.localhostPort;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || options.internet) throw new Error('Invalid isolated benchmark gateway');
  const relayDir = path.join(options.temporary, `gateway-relay-${randomUUID()}`);
  await mkdir(relayDir, { mode: 0o700 });
  // Linux sockaddr_un is short; use a socket outside the long case directory.
  const socket = path.join('/tmp', `wb-${randomUUID()}.sock`);
  const socketPath = '/tmp/workbench-gateway.sock';
  const connections = new Set<Socket>();
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port });
    for (const connection of [client, upstream]) {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
      connection.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  let launch: SandboxLaunch | undefined;
  const cleanup = async () => {
    for (const connection of connections) connection.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await launch?.cleanup();
    await rm(socket, { force: true });
    await rm(relayDir, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const wrapper = path.join(relayDir, 'relay.cjs');
    await writeFile(wrapper, `const net = require('node:net');
const { spawn } = require('node:child_process');
const server = net.createServer(client => {
  const peer = net.connect(${JSON.stringify(socketPath)});
  client.on('error', () => peer.destroy()); peer.on('error', () => client.destroy());
  client.pipe(peer).pipe(client);
});
server.listen(${port}, '127.0.0.1', () => {
  const child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(args)}, { stdio: 'inherit', env: process.env });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
});
server.on('error', () => process.exit(1));
`, { mode: 0o600 });
    launch = await prepareSandbox({ ...options, localhostPort: undefined }, nodeExecutable, [wrapper]);
    // Mount only this socket, before '--'. No host network or session bus exposed.
    const boundary = launch.args.indexOf('--');
    launch.args.splice(boundary, 0, '--ro-bind', await realpath(socket), socketPath);
    return { executable: launch.executable, args: launch.args, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
