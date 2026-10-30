import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isWithin, permittedPath, normalizeFolders } from './access';
import { sandboxAvailable, prepareSandbox, commandShell, commandShellArgs, commandPath, commandLocale } from './sandbox';
export { sandboxAvailable } from './sandbox';
export { sandboxProfile } from './sandbox/macos';
import type { ApprovalRequest, CommandProcess, ToolContext } from '../shared/types';
import { agentMode } from '../shared/modes';
import { ProcessManager } from './processes';
import { beginBackground, persistBackgroundTaint } from './snapshot-scopes';

export interface WorkspaceCallbacks {
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  emit(event: import('../shared/types').AgentEvent): void;
}

/** Trusted composition only: runtime libraries are not project/indexing roots. */
export interface CommandRuntime {
  readRoots?: string[];
  path?: string;
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[credential redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization|secret)\s*[:=]\s*)[^\s"']+/gi, '$1[credential redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [credential redacted]')
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|$)/g, '[protected content redacted]');
}

export class CommandService {
  private processes: ProcessManager;
  constructor(private dataDir: string, private callbacks: WorkspaceCallbacks, private revalidate?: (context: ToolContext) => Promise<ToolContext>, private runtime: CommandRuntime = {}) {
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
    if (!(await sandboxAvailable())) throw new Error('The command sandbox is unavailable. Commands are disabled until a supported sandbox is available.');
    const cwd = await permittedPath(context.project, requestedCwd || context.project.folders[0].path);
    const privateRoot = await realpath(this.dataDir);
    if (isWithin(privateRoot, cwd)) throw new Error('Application storage cannot be used as a command working directory.');
    const roots = await Promise.all(context.project.folders.map(async folder => ({ ...folder, path: await realpath(folder.path) })));
    if (this.runtime.readRoots?.length) {
      const runtimeRoots = await normalizeFolders(this.runtime.readRoots.map(path => ({ path, access: 'read' as const })));
      if (runtimeRoots.some(root => isWithin(root.path, privateRoot) || isWithin(privateRoot, root.path))) throw new Error('Runtime libraries cannot overlap application storage.');
      roots.push(...runtimeRoots);
    }
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
    let sandbox: Awaited<ReturnType<typeof prepareSandbox>> | undefined;
    try {
      if (this.revalidate) context = await this.revalidate(context);
      const writableRoots = roots.filter(root => root.access === 'write').map(root => root.path);
      if (background) {
        await persistBackgroundTaint(privateRoot, writableRoots);
        releaseBackground = beginBackground(writableRoots);
      }
      if (this.revalidate) context = await this.revalidate(context);
      if (context.signal.aborted) throw new Error('Command cancelled.');
      sandbox = await prepareSandbox({ roots, temporary: scratch, internet: context.project.internet, privateRoot, skillRoots }, commandShell, [...commandShellArgs, command]);
      return this.processes.start({
        projectId: context.project.id, sessionId: context.sessionId, command, cwd, background,
        executable: sandbox.executable, args: sandbox.args,
        env: {
            PATH: this.runtime.path ?? commandPath,
            HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp'),
            TMPPREFIX: path.join(scratch, 'tmp', 'zsh'),
            LANG: commandLocale, LC_ALL: commandLocale, TERM: 'dumb', CI: '1',
            npm_config_cache: path.join(scratch, 'home', '.npm'),
            PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        }, signal: context.signal, timeoutMs: maximum,
        initialOutput: background ? 'После фоновой команды снимки команд отключены для разрешённых папок записи, включая перезапуск, чтобы не приписать чужие правки задаче. Файловые инструменты и их checkpoints доступны.\n' : undefined,
        unmanagedChild: () => persistBackgroundTaint(privateRoot, writableRoots),
        cleanup: async () => { try { await sandbox?.cleanup(); await rm(scratch, { recursive: true, force: true }); } finally { releaseBackground?.(); } },
      });
    } catch (error) { releaseBackground?.(); await sandbox?.cleanup(); await rm(scratch, { recursive: true, force: true }); throw error; }
  }
}
