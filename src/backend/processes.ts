import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { CommandProcess } from '../shared/types';

export interface ProcessLaunch {
  projectId: string; sessionId: string; command: string; cwd: string; background: boolean;
  executable: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number;
  signal: AbortSignal; initialOutput?: string; unmanagedChild?(): Promise<void>; cleanup(): Promise<void>;
}
interface ManagedProcess {
  process: CommandProcess; child: ChildProcess; completion: Promise<CommandProcess>;
  terminate(reason: 'Cancelled' | 'Stopped' | 'Timed out'): void;
}
const OUTPUT_LIMIT = 100_000;
/** Runtime-owned children. No shell credentials or external process inventory is read. */
export class ProcessManager {
  private records = new Map<string, ManagedProcess>();
  private closed = false;
  constructor(private emit: (process: CommandProcess, delta?: string) => void, private redact: (value: string) => string) {}
  start(input: ProcessLaunch): { process: CommandProcess; completion: Promise<CommandProcess> } {
    if (this.closed) throw new Error('Command process manager is closed.');
    if (input.signal.aborted) throw new Error('Command cancelled.');
    if ([...this.records.values()].filter(record => record.process.status === 'running').length >= 16) throw new Error('Too many active commands. Stop an existing command first.');
    const process: CommandProcess = { id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, command: this.redact(input.command), cwd: input.cwd, status: 'running', output: this.redact(input.initialOutput ?? ''), startedAt: new Date().toISOString(), background: input.background };
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let complete!: (value: CommandProcess) => void;
    const completion = new Promise<CommandProcess>(resolve => { complete = resolve; });
    let finished = false;
    let reason = '';
    let truncated = false;
    let openPipes = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => { try { if (child.pid) globalThis.process.kill(-child.pid, signal); } catch { /* Already stopped. */ } };
    const notify = (delta?: string) => { try { this.emit(structuredClone(process), delta); } catch { /* UI teardown cannot orphan the child. */ } };
    const append = (text: string) => {
      if (!text || truncated) return;
      const sanitized = this.redact(text);
      const available = OUTPUT_LIMIT - process.output.length;
      const delta = sanitized.slice(0, Math.max(0, available));
      process.output += delta;
      if (delta) notify(delta);
      if (sanitized.length > available) { truncated = true; process.output += '\n[Output truncated at 100000 characters]'; notify('\n[Output truncated at 100000 characters]'); }
    };
    // Keep incomplete lines together so a credential split between OS chunks
    // cannot escape redaction. Oversized lines are omitted rather than split.
    const channels = [child.stdout!, child.stderr!].map(stream => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let omitted = false;
      let protectedLabel: string | undefined;
      const protectedBegin = /-----BEGIN ([A-Z ]*PRIVATE KEY|CERTIFICATE)-----/;
      const filteredLine = (line: string) => {
        let remaining = line;
        while (remaining) {
          if (protectedLabel) {
            const marker = `-----END ${protectedLabel}-----`;
            const end = remaining.indexOf(marker);
            if (end < 0) return;
            remaining = remaining.slice(end + marker.length); protectedLabel = undefined;
          } else {
            const begin = protectedBegin.exec(remaining);
            if (!begin) { append(remaining); return; }
            append(remaining.slice(0, begin.index));
            append('[protected content redacted]');
            protectedLabel = begin[1]; remaining = remaining.slice(begin.index + begin[0].length);
          }
        }
      };
      const consume = (text: string) => {
        for (const fragment of text.split(/(?<=\n)/)) {
          if (!omitted) pending += fragment;
          if (pending.length > OUTPUT_LIMIT) { protectedLabel ??= protectedBegin.exec(pending)?.[1]; pending = ''; omitted = true; }
          if (fragment.endsWith('\n')) { filteredLine(omitted ? '[Oversized output line omitted]\n' : pending); pending = ''; omitted = false; }
        }
      };
      stream.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
      return () => { consume(decoder.end()); filteredLine(omitted ? '[Oversized output line omitted]\n' : pending); pending = ''; };
    });
    const terminate = (value: 'Cancelled' | 'Stopped' | 'Timed out') => {
      if (finished || reason) return;
      reason = value; killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1000); killTimer.unref();
    };
    const onAbort = () => terminate('Cancelled');
    const timer = setTimeout(() => terminate('Timed out'), input.timeoutMs); timer.unref();
    input.signal.addEventListener('abort', onAbort, { once: true });
    const finish = async (code: number | null, signal?: NodeJS.Signals | null, startupError?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (drainTimer) clearTimeout(drainTimer);
      input.signal.removeEventListener('abort', onAbort); killGroup('SIGKILL');
      for (const flush of channels) flush();
      if (startupError) append(`Command could not start: ${(startupError as NodeJS.ErrnoException).code ?? startupError.name}\n`);
      process.status = reason === 'Cancelled' || reason === 'Stopped' ? 'stopped' : reason || startupError || code !== 0 ? 'failed' : 'completed';
      process.exitCode = code ?? undefined; process.finishedAt = new Date().toISOString();
      const summary = `${reason || (startupError ? 'Could not start' : `Exit ${code ?? signal ?? 'unknown'}`)}\n`;
      process.output = summary + process.output;
      let cleaned = true;
      await input.cleanup().catch(() => { cleaned = false; });
      process.exitObserved = !reason && !startupError && !signal && Number.isInteger(code) && !openPipes && cleaned;
      notify(); complete(structuredClone(process));
      const ended = [...this.records.values()].filter(record => record.process.status !== 'running');
      for (const old of ended.slice(0, Math.max(0, this.records.size - 200))) this.records.delete(old.process.id);
    };
    child.on('error', error => { void finish(null, null, error); });
    child.on('exit', (code, signal) => {
      // A detached child can retain inherited pipes after the managed leader
      // exits. Completion must not depend indefinitely on those pipe handles.
      drainTimer = setTimeout(() => {
        if (finished) return;
        openPipes = true;
        append('\n[Managed command exited with open output pipes; a detached child may still be running.]\n');
        void (async () => {
          await input.unmanagedChild?.().catch(() => undefined);
          child.stdout?.destroy(); child.stderr?.destroy(); await finish(code, signal);
        })();
      }, 250);
      drainTimer.unref();
    });
    child.on('close', (code, signal) => { void finish(code, signal); });
    this.records.set(process.id, { process, child, completion, terminate });
    notify();
    if (input.signal.aborted) onAbort();
    return { process: structuredClone(process), completion };
  }
  list(projectId: string, sessionId?: string): CommandProcess[] {
    return [...this.records.values()].filter(record => record.process.projectId === projectId && (!sessionId || record.process.sessionId === sessionId)).map(record => structuredClone(record.process));
  }
  async stop(projectId: string, id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.process.projectId !== projectId) throw new Error('Command process does not belong to this project.');
    record.terminate('Stopped'); await record.completion;
  }
  async stopSession(sessionId: string): Promise<void> { await this.stopMatching(record => record.process.sessionId === sessionId); }
  async stopProject(projectId: string): Promise<void> { await this.stopMatching(record => record.process.projectId === projectId); }
  private async stopMatching(predicate: (record: ManagedProcess) => boolean): Promise<void> {
    const matching = [...this.records.values()].filter(predicate);
    for (const record of matching) record.terminate('Stopped');
    await Promise.all(matching.map(record => record.completion));
  }
  async close(): Promise<void> { this.closed = true; await this.stopMatching(() => true); }
}
