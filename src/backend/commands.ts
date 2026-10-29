import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isWithin, permittedPath } from './access';
import type { ApprovalRequest, CommandProcess, ToolContext } from '../shared/types';
import { agentMode } from '../shared/modes';
import { ProcessManager } from './processes';
import { beginBackground, persistBackgroundTaint } from './snapshot-scopes';

export interface WorkspaceCallbacks {
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  emit(event: import('../shared/types').AgentEvent): void;
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[credential redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization|secret)\s*[:=]\s*)[^\s"']+/gi, '$1[credential redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [credential redacted]')
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|$)/g, '[protected content redacted]');
}

let sandboxProbe: Promise<boolean> | undefined;
export async function sandboxAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  sandboxProbe ??= (async () => {
    try { await access('/usr/bin/sandbox-exec', constants.X_OK); } catch { return false; }
    return new Promise<boolean>(resolve => {
      // A present executable does not prove sandbox_apply is permitted in this
      // host environment. Probe an inert command without reading user files.
      const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny file-write*)', '/usr/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 3000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    });
  })();
  const available = await sandboxProbe;
  // A transient failure (for example a probe timeout under load) must not disable
  // commands until restart; only a successful probe is cached.
  if (!available) sandboxProbe = undefined;
  return available;
}

function quote(value: string): string { return JSON.stringify(value); }

export function sandboxProfile(roots: { path: string; access: 'read' | 'write' }[], temporary: string, internet: boolean, privateRoot?: string, skillRoots: string[] = [], metadataReadRoots: string[] = []): string {
  // Broad system reads are needed for executable loaders and SDKs; credential paths
  // are explicitly denied after allow rules, including those inside project roots.
  const caseInsensitive = (word: string) => [...word].map(character => /[a-z]/i.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character).join('');
  const protectedPattern = `(^|/)(\\.${caseInsensitive('env')}([._-][^/]*)?|${['ssh', 'aws', 'gnupg', 'git', 'codex', 'agents', 'npmrc', 'pypirc', 'netrc', 'git-credentials'].map(name => `\\.${caseInsensitive(name)}`).join('|')}|${caseInsensitive('Keychains')}|${caseInsensitive('credentials')}([^/]*)?|${caseInsensitive('secret')}[sS]?([^/]*)?|${caseInsensitive('auth')}\\.${caseInsensitive('json')}|${caseInsensitive('id')}_(rsa|ed25519|ecdsa|dsa)(\\.${caseInsensitive('pub')})?|[^/]*\\.(${['pem', 'key', 'p12', 'pfx', 'crt', 'cer', 'keystore'].map(caseInsensitive).join('|')}))(/|$)`;
  return [
    '(version 1)', '(deny default)',
    // Apple's minimal loader rules permit dyld/libignition to bootstrap native
    // binaries. They add system loader paths, not project writes or internet.
    '(import "dyld-support.sb")',
    '(allow process-exec)', '(allow process-fork)', '(allow signal (target self))',
    '(allow sysctl-read)', '(allow mach-lookup)', '(allow file-read-metadata)',
    ...['/System', '/Library', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Applications/Xcode.app', '/private/etc', '/dev'].map(root => `(allow file-read* (subpath ${quote(root)}))`),
    '(allow file-write* (literal "/dev/null") (subpath "/dev/fd"))',
    ...roots.map(root => `(allow file-read* (subpath ${quote(root.path)}))`),
    ...roots.filter(root => root.access === 'write').map(root => `(allow file-write* (subpath ${quote(root.path)}))`),
    ...roots.filter(root => root.access === 'read').map(root => {
      const writableChildren = roots.filter(child => child.access === 'write' && child.path.startsWith(`${root.path}/`));
      return writableChildren.length
        ? `(deny file-write* (require-all (subpath ${quote(root.path)}) ${writableChildren.map(child => `(require-not (subpath ${quote(child.path)}))`).join(' ')}))`
        : `(deny file-write* (subpath ${quote(root.path)}))`;
    }),
    `(allow file-read* file-write* (subpath ${quote(temporary)}))`,
    ...(privateRoot ? [
      `(deny file-read* (require-all (subpath ${quote(privateRoot)}) (require-not (subpath ${quote(temporary)})) ${skillRoots.map(root => `(require-not (subpath ${quote(root)}))`).join(' ')}))`,
      `(deny file-write* (require-all (subpath ${quote(privateRoot)}) (require-not (subpath ${quote(temporary)}))))`,
      // Protect ancestor directory renames/deletions without denying unrelated
      // siblings merely because they share a name such as .workbench.
      ...(() => {
        const ancestors: string[] = [];
        let ancestor = path.dirname(privateRoot);
        while (ancestor !== path.dirname(ancestor)) {
          if (roots.some(root => root.access === 'write' && isWithin(root.path, ancestor))) ancestors.push(ancestor);
          ancestor = path.dirname(ancestor);
        }
        return ancestors.map(root => `(deny file-write-unlink (literal ${quote(root)}))`);
      })(),
    ] : []),
    ...(metadataReadRoots.length ? [
      ...metadataReadRoots.map(root => `(allow file-read* (subpath ${quote(root)}))`),
      `(deny file-read* (require-all (regex ${quote(protectedPattern)}) ${metadataReadRoots.map(root => `(require-not (subpath ${quote(root)}))`).join(' ')}))`,
      `(deny file-write* (regex ${quote(protectedPattern)}))`,
    ] : [`(deny file-read* file-write* (regex ${quote(protectedPattern)}))`]),
    // Keychain/credential helper access stays denied; network is project-scoped.
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    ...(internet ? ['(allow network-outbound)', '(allow network-inbound (local ip "localhost:*"))'] : []),
  ].join('\n');
}

export class CommandService {
  private processes: ProcessManager;
  constructor(private dataDir: string, private callbacks: WorkspaceCallbacks, private revalidate?: (context: ToolContext) => Promise<ToolContext>) {
    this.processes = new ProcessManager((process, delta) => callbacks.emit({ type: 'command', projectId: process.projectId, sessionId: process.sessionId, command: { process, delta } }), redactCommandOutput);
  }

  async run(context: ToolContext, command: string, requestedCwd?: string, timeoutMs = 60_000, skillRoots: string[] = []): Promise<string> {
    const process = await this.runDetailed(context, command, requestedCwd, timeoutMs, skillRoots);
    if (process.status !== 'completed') throw new Error(process.output);
    return process.output;
  }
  async runDetailed(context: ToolContext, command: string, requestedCwd?: string, timeoutMs = 60_000, skillRoots: string[] = []): Promise<CommandProcess> {
    return await (await this.launch(context, command, requestedCwd, timeoutMs, skillRoots, false)).completion;
  }
  async startBackground(context: ToolContext, command: string, requestedCwd?: string, timeoutMs = 8 * 3600_000, skillRoots: string[] = []): Promise<CommandProcess> {
    return (await this.launch(context, command, requestedCwd, timeoutMs, skillRoots, true)).process;
  }
  async listProcesses(projectId: string, sessionId?: string): Promise<CommandProcess[]> { return this.processes.list(projectId, sessionId); }
  async stopProcess(projectId: string, id: string): Promise<void> { await this.processes.stop(projectId, id); }
  async stopManaged(context: ToolContext, id: string): Promise<void> {
    if (context.readOnly) throw new Error('Read-only delegated context cannot manage command processes.');
    context = this.revalidate ? await this.revalidate(context) : context;
    const mode = agentMode(context.mode);
    if (mode === 'plan') throw new Error('Plan mode cannot manage command processes.');
    const current = this.processes.list(context.project.id, context.sessionId).find(process => process.id === id);
    if (!current) throw new Error('Command process does not belong to this chat.');
    if (mode !== 'bypass' && (mode === 'ask' || context.project.commandPolicy === 'ask')) {
      const request: ApprovalRequest = { id: randomUUID(), sessionId: context.sessionId, projectId: context.project.id, kind: 'command', title: 'Остановить процесс команды', description: `Working directory: ${current.cwd}\n\n${current.command}\n\nProcess: ${id}` };
      if (!(await this.callbacks.approve(request, context.signal))) throw new Error('Stopping the command was declined.');
    }
    if (this.revalidate) context = await this.revalidate(context);
    if (context.signal.aborted) throw new Error('Command cancelled.');
    await this.processes.stop(context.project.id, id);
  }
  async stopSession(sessionId: string): Promise<void> { await this.processes.stopSession(sessionId); }
  async stopProject(projectId: string): Promise<void> { await this.processes.stopProject(projectId); }
  async close(): Promise<void> { await this.processes.close(); }

  private async launch(context: ToolContext, command: string, requestedCwd: string | undefined, timeoutMs: number, skillRoots: string[], background: boolean) {
    if (context.readOnly) throw new Error('Read-only delegated context cannot run commands.');
    if (typeof command !== 'string' || !command.trim() || command.length > 20_000) throw new Error('Command must contain 1–20000 characters.');
    if (context.signal.aborted) throw new Error('Command cancelled.');
    context = this.revalidate ? await this.revalidate(context) : context;
    const mode = agentMode(context.mode);
    if (mode === 'plan') throw new Error('Plan mode cannot run commands.');
    if (!(await sandboxAvailable())) throw new Error('The macOS command sandbox is unavailable. Commands are disabled until a supported sandbox is available.');
    const cwd = await permittedPath(context.project, requestedCwd || context.project.folders[0].path);
    const privateRoot = await realpath(this.dataDir);
    if (isWithin(privateRoot, cwd)) throw new Error('Application storage cannot be used as a command working directory.');
    const roots = await Promise.all(context.project.folders.map(async folder => ({ ...folder, path: await realpath(folder.path) })));
    roots.push(...skillRoots.map(folder => ({ path: folder, access: 'read' as const })));
    if (mode !== 'bypass' && (mode === 'ask' || context.project.commandPolicy === 'ask')) {
      const request: ApprovalRequest = { id: randomUUID(), sessionId: context.sessionId, projectId: context.project.id, kind: 'command', title: background ? 'Запустить фоновую команду' : 'Выполнить команду', description: `Working directory: ${cwd}\n\n${redactCommandOutput(command)}` };
      if (!(await this.callbacks.approve(request, context.signal))) throw new Error('Command was declined.');
      if (context.signal.aborted) throw new Error('Command cancelled.');
    }
    if (this.revalidate) context = await this.revalidate(context);
    const scratch = path.join(privateRoot, 'command-scratch', randomUUID());
    await mkdir(path.join(scratch, 'home'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(scratch, 'tmp'), { recursive: true, mode: 0o700 });
    const maximum = Math.max(1000, Math.min(Number(timeoutMs) || 60_000, background ? 8 * 3600_000 : 300_000));
    let releaseBackground: (() => void) | undefined;
    try {
      if (this.revalidate) context = await this.revalidate(context);
      const writableRoots = roots.filter(root => root.access === 'write').map(root => root.path);
      if (background) {
        await persistBackgroundTaint(privateRoot, writableRoots);
        releaseBackground = beginBackground(writableRoots);
      }
      if (this.revalidate) context = await this.revalidate(context);
      if (context.signal.aborted) throw new Error('Command cancelled.');
      const profile = sandboxProfile(roots, scratch, context.project.internet, privateRoot, skillRoots);
      return this.processes.start({
        projectId: context.project.id, sessionId: context.sessionId, command, cwd, background,
        executable: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/zsh', '-f', '-c', command],
        env: {
            PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp'),
            TMPPREFIX: path.join(scratch, 'tmp', 'zsh'),
            LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'dumb', CI: '1',
            npm_config_cache: path.join(scratch, 'home', '.npm'),
            PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        }, signal: context.signal, timeoutMs: maximum,
        initialOutput: background ? 'После фоновой команды снимки команд отключены для разрешённых папок записи, включая перезапуск, чтобы не приписать чужие правки задаче. Файловые инструменты и их checkpoints доступны.\n' : undefined,
        unmanagedChild: () => persistBackgroundTaint(privateRoot, writableRoots),
        cleanup: async () => { try { await rm(scratch, { recursive: true, force: true }); } finally { releaseBackground?.(); } },
      });
    } catch (error) { releaseBackground?.(); await rm(scratch, { recursive: true, force: true }); throw error; }
  }
}
