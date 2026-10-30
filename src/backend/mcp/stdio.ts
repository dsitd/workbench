import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpServerConfig, Project } from '../../shared/types';
import { isSensitivePath, isWithin } from '../access';
import { sandboxAvailable, sandboxProfile, prepareSandbox, commandPath, commandLocale } from '../sandbox';
import { envName, McpFailure, MESSAGE_LIMIT, type SecretValues } from './safety';

export interface StdioLaunch { command: string; args: string[]; cwd: string; env: Record<string, string>; scratch: string; profile: string }
export interface ManagedTransport { transport: Transport; cleanup(): Promise<void> }
export type StdioFactory = (launch: StdioLaunch) => Promise<ManagedTransport>;

/** SDK protocol codec with detached process groups; no shell, stderr or inherited env. */
export class ProcessTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcessWithoutNullStreams;
  private buffer = new ReadBuffer({ maxBufferSize: MESSAGE_LIMIT });
  private stopped = false;
  private notified = false;
  private closed?: Promise<void>;
  constructor(private launch: Pick<StdioLaunch, 'command' | 'args' | 'cwd' | 'env'>) {}
  async start(): Promise<void> {
    if (this.child || this.stopped) throw new McpFailure('MCP stdio transport cannot be restarted.');
    const child = this.child = spawn(this.launch.command, this.launch.args, { cwd: this.launch.cwd, env: this.launch.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => this.onerror?.(new McpFailure('MCP stdio write failed.')));
    child.stdout.on('error', () => this.onerror?.(new McpFailure('MCP stdio read failed.')));
    child.stderr.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      try { this.buffer.append(chunk); for (;;) { const message = this.buffer.readMessage(); if (!message) break; this.onmessage?.(message); } }
      catch { this.onerror?.(new McpFailure('MCP stdio produced an invalid or oversized protocol message.')); void this.close(); }
    });
    child.on('exit', () => { this.stopped = true; this.kill('SIGKILL'); this.buffer.clear(); this.notifyClosed(); });
    child.on('error', () => { this.onerror?.(new McpFailure('MCP executable could not be started.')); });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new McpFailure('MCP executable could not be started.'))); });
  }
  private kill(signal: NodeJS.Signals) { try { if (this.child?.pid) process.kill(-this.child.pid, signal); } catch { /* already reaped */ } }
  private notifyClosed() { if (!this.notified) { this.notified = true; this.onclose?.(); } }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.stopped) throw new McpFailure('MCP stdio connection is closed.');
    const body = serializeMessage(message);
    if (Buffer.byteLength(body) > MESSAGE_LIMIT) throw new McpFailure('MCP request exceeds the supported size.');
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(body, error => error ? reject(new McpFailure('MCP stdio write failed.')) : resolve()));
  }
  async close(): Promise<void> {
    this.closed ??= (async () => {
      this.stopped = true;
      const child = this.child;
      if (!child) { this.notifyClosed(); return; }
      this.kill('SIGTERM');
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); };
        timer = setTimeout(() => { this.kill('SIGKILL'); finish(); }, 500);
        child.once('exit', finish);
        if (child.exitCode !== null || child.signalCode !== null) finish();
      });
      this.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); this.buffer.clear();
      this.notifyClosed();
    })();
    await this.closed;
  }
}

export async function createStdio(storeDirectory: string, server: McpServerConfig, project: Project, secrets: SecretValues, factory?: StdioFactory): Promise<ManagedTransport> {
  // An injected launcher is available only to local fixture tests. The app never supplies one.
  if (!factory && !(await sandboxAvailable())) throw new McpFailure('The command sandbox is unavailable. MCP stdio servers are disabled.');
  const privateRoot = await realpath(storeDirectory);
  const roots = await Promise.all(project.folders.map(async root => {
    const canonical = await realpath(root.path);
    if (canonical !== root.path) throw new McpFailure('Project folder identity changed. Re-select the folder before using MCP.');
    return { ...root, path: canonical };
  }));
  if (!roots.length || isWithin(privateRoot, roots[0].path)) throw new McpFailure('MCP requires a project folder outside application storage.');
  const scratch = path.join(privateRoot, 'mcp-scratch', randomUUID());
  const env: Record<string, string> = {
    PATH: commandPath, HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp'),
    LANG: commandLocale, LC_ALL: commandLocale, TERM: 'dumb', CI: '1', npm_config_cache: path.join(scratch, 'home', '.npm'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const [name, value] of Object.entries(secrets.env)) {
    if (!envName(name) || !server.envNames.includes(name) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new McpFailure('Resolved MCP environment does not match its declared allowlist.');
    env[name] = value;
  }
  const candidates = path.isAbsolute(server.command) ? [server.command] : server.command.includes('/') ? [path.resolve(roots[0].path, server.command)] : env.PATH.split(':').map(directory => path.join(directory, server.command));
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (isSensitivePath(candidate)) continue;
    try { await access(candidate, constants.X_OK); const canonical = await realpath(candidate); if (!isSensitivePath(canonical) && !isWithin(privateRoot, canonical)) { executable = canonical; break; } } catch { /* try next allowed PATH entry */ }
  }
  if (!executable) throw new McpFailure('MCP executable was not found in the configured path.');
  await Promise.all([mkdir(path.join(scratch, 'home'), { recursive: true, mode: 0o700 }), mkdir(path.join(scratch, 'tmp'), { recursive: true, mode: 0o700 })]);
  // A canonical executable may live outside ordinary project/system reads. Permit
  // that one binary without opening its parent directory or the user's home.
  const profile = `${sandboxProfile(roots, scratch, project.internet, privateRoot)}\n(allow file-read* (literal ${JSON.stringify(executable)}))`;
  let sandbox: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
  try {
    if (!factory) sandbox = await prepareSandbox({ roots, temporary: scratch, internet: project.internet, privateRoot, readFiles: [executable] }, executable, server.args);
    const managed = factory ? await factory({ command: executable, args: server.args, cwd: roots[0].path, env, scratch, profile }) : {
      transport: new ProcessTransport({ command: sandbox!.executable, args: sandbox!.args, cwd: roots[0].path, env }),
      cleanup: async () => { await sandbox?.cleanup(); },
    };
    let cleanup: Promise<void> | undefined;
    return { transport: managed.transport, cleanup: () => cleanup ??= (async () => { await managed.cleanup(); await rm(scratch, { recursive: true, force: true }); })() };
  } catch (error) { await sandbox?.cleanup(); await rm(scratch, { recursive: true, force: true }); throw error; }
}
