import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { assertNonSensitive, isSensitivePath, isWithin, permittedPath } from './access';
import { StateStore, type ChangeRecord } from './storage';
import { beginSnapshot, restoreBackgroundTaint } from './snapshot-scopes';
import { searchExcerpts } from './search-excerpts';
import { applyTextEdits, type TextEdit } from './batch-edit';
import { ripgrepSearch, type SearchOptions } from './ripgrep-search';
import type { FileChange, FileConflict, FileEntry, Project, RuleDocument, TaskCheckpoint } from '../shared/types';
export type { TaskCheckpoint } from '../shared/types';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const skippedDirectories = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.workbench', 'release']);

export interface FileWriteOptions { expectedVersion?: string | null; requireRead?: boolean; checkpointId?: string }
export class FileConflictError extends Error {
  readonly code = 'FILE_CONFLICT';
  readonly conflict: FileConflict;
  constructor(readonly path: string, readonly expected: string | null | undefined, readonly actual: string | null, currentContent: string | null = null) {
    super('File version conflict. Read the current file and review your changes before saving again.');
    this.name = 'FileConflictError';
    this.conflict = { path, expectedVersion: expected ?? null, currentVersion: actual, currentContent };
  }
}
export function fileVersion(content: string | Buffer): string { return `sha256:${createHash('sha256').update(content).digest('hex')}`; }
async function currentText(file: string): Promise<{ content: string | null; version: string | null }> {
  try { const content = await readTextFile(file); return { content, version: fileVersion(content) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, version: null }; throw error; }
}

export async function readTextFile(file: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  assertNonSensitive(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Path is not a regular file.');
    if (info.size > maxBytes) throw new Error(`Text file exceeds ${Math.floor(maxBytes / 1024)} KiB.`);
    const buffer = await handle.readFile();
    if (buffer.includes(0) || !isUtf8(buffer)) throw new Error('Binary file cannot be displayed as text.');
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

async function atomicTextWrite(file: string, content: string, expectedVersion?: string | null): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.workbench-${randomUUID()}.tmp`);
  let mode = 0o644;
  try { mode = (await stat(file)).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    if (expectedVersion !== undefined) {
      const current = await currentText(file);
      if (current.version !== expectedVersion) throw new FileConflictError(file, expectedVersion, current.version, current.content);
    }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export const MAX_PROJECT_CHECKPOINTS = 1000;
/** Per-project soft cap. Evicts the oldest checkpoints that no stored change references and that are not the latest of their
 *  session (a running task keeps writing into it). Undo of surviving changes is untouched; if every old checkpoint still owns
 *  changes the cap is exceeded rather than failing writes. */
export function evictCheckpoints(checkpoints: TaskCheckpoint[], changes: readonly (FileChange | ChangeRecord)[], projectId: string, limit = MAX_PROJECT_CHECKPOINTS): TaskCheckpoint[] {
  const own = checkpoints.filter(point => point.projectId === projectId);
  let excess = own.length - limit;
  if (excess <= 0) return checkpoints;
  const referenced = new Set(changes.filter(change => change.projectId === projectId).map(change => change.checkpointId));
  const latest = new Map(own.map(point => [point.sessionId, point.id]));
  const evicted = new Set<string>();
  for (const point of own) { if (excess <= 0) break; if (referenced.has(point.id) || latest.get(point.sessionId) === point.id) continue; evicted.add(point.id); excess--; }
  return evicted.size ? checkpoints.filter(point => !evicted.has(point.id)) : checkpoints;
}

export class FileService {
  private writes: { roots: string[]; done: Promise<unknown> }[] = [];
  private reads = new Map<string, Map<string, string | null>>();
  constructor(private store: StateStore, private changed: (projectId: string) => void) {}
  async privateDirectory(): Promise<string> { return realpath(this.store.directory); }

  async resolvePath(project: Project, requested: string, write = false): Promise<string> {
    const target = await permittedPath(project, requested, write);
    const privateRoot = await realpath(this.store.directory);
    if (isWithin(privateRoot, target)) throw new Error('Application storage is private and cannot be accessed through project files.');
    return target;
  }

  private async writable(project: Project, requested: string): Promise<boolean> {
    try { await this.resolvePath(project, requested, true); return true; } catch { return false; }
  }

  private exclusive<T>(project: Project, operation: () => Promise<T>): Promise<T> {
    const roots = project.folders.filter(folder => folder.access === 'write').map(folder => folder.path);
    const dependencies = this.writes.filter(lock => roots.some(root => lock.roots.some(other => isWithin(root, other) || isWithin(other, root))));
    const pending = Promise.all(dependencies.map(lock => lock.done)).then(operation);
    const settled = pending.catch(() => undefined);
    const lock = { roots, done: settled };
    this.writes.push(lock);
    void settled.then(() => { this.writes = this.writes.filter(value => value !== lock); });
    return pending;
  }

  async list(project: Project, requested?: string): Promise<FileEntry[]> {
    if (!requested) {
      return Promise.all(project.folders.map(async folder => ({ path: folder.path, name: path.basename(folder.path), kind: 'directory' as const, writable: await this.writable(project, folder.path) })));
    }
    const directory = await this.resolvePath(project, requested);
    const entries = await readdir(directory, { withFileTypes: true });
    const results: FileEntry[] = [];
    for (const entry of entries.slice(0, 3000)) {
      const file = path.join(directory, entry.name);
      if (isSensitivePath(file)) {
        // Names may be displayed; no contents or credential directory listing is loaded.
        results.push({ path: file, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', writable: false });
        continue;
      }
      try {
        const canonical = await this.resolvePath(project, file);
        const info = await stat(canonical);
        if (!info.isFile() && !info.isDirectory()) continue;
        results.push({ path: file, name: entry.name, kind: info.isDirectory() ? 'directory' : 'file', writable: await this.writable(project, file), size: info.isFile() ? info.size : undefined });
      } catch { /* Escaping or broken symlinks are omitted. */ }
    }
    return results.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  }

  async read(project: Project, requested: string, sessionId?: string): Promise<FileEntry & { version: string }> {
    const file = await this.resolvePath(project, requested);
    const content = await readTextFile(file);
    const version = fileVersion(content);
    if (sessionId) { await this.session(project, sessionId); this.remember(project, sessionId, file, version); }
    return { path: file, name: path.basename(file), kind: 'file', writable: await this.writable(project, file), size: Buffer.byteLength(content), content, version };
  }

  private async session(project: Project, sessionId: string): Promise<void> {
    if (!(await this.store.read()).sessions.some(session => session.id === sessionId && session.projectId === project.id)) throw new Error('File session does not belong to this project.');
  }
  private remember(project: Project, sessionId: string, file: string, version: string | null): void {
    const key = `${project.id}:${sessionId}`;
    const reads = this.reads.get(key) ?? new Map<string, string | null>();
    reads.set(file, version); this.reads.set(key, reads);
    if (reads.size > 4000) reads.delete(reads.keys().next().value!);
    if (this.reads.size > 200) this.reads.delete(this.reads.keys().next().value!);
  }
  clearReads(sessionId: string): void { for (const key of this.reads.keys()) if (key.endsWith(`:${sessionId}`)) this.reads.delete(key); }
  private checkVersion(project: Project, file: string, version: string | null, sessionId?: string, options: FileWriteOptions = {}, currentContent: string | null = null): void {
    const expected = options.expectedVersion;
    if (expected !== undefined && expected !== null && !/^sha256:[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid file version. Reload the file.');
    if (expected !== undefined && expected !== version) throw new FileConflictError(file, expected, version, currentContent);
    if (options.requireRead && version !== null && expected === undefined) {
      const remembered = sessionId && this.reads.get(`${project.id}:${sessionId}`)?.get(file);
      if (remembered === undefined) throw new Error('Read this file in the current chat before editing it.');
      if (remembered !== version) throw new FileConflictError(file, remembered, version, currentContent);
    }
  }
  async write(project: Project, requested: string, content: string, sessionId?: string, options: FileWriteOptions = {}): Promise<void> {
    return this.exclusive(project, () => this.writeLocked(project, requested, content, sessionId, options));
  }

  private async writeLocked(project: Project, requested: string, content: string, sessionId?: string, options: FileWriteOptions = {}): Promise<void> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error('File content must be text, up to 2 MiB.');
    const file = await this.resolvePath(project, requested, true);
    if (sessionId) await this.session(project, sessionId);
    const original = await currentText(file);
    const before = original.content;
    this.checkVersion(project, file, original.version, sessionId, options, original.content);
    if (before === content) return;
    const checkpointId = await this.changeCheckpoint(project, sessionId, options.checkpointId);
    const change = { id: randomUUID(), projectId: project.id, path: file, before, after: content, createdAt: new Date().toISOString(), sessionId, checkpointId, beforeVersion: original.version, afterVersion: fileVersion(content) } satisfies FileChange & { checkpointId?: string; beforeVersion: string | null; afterVersion: string | null };
    await atomicTextWrite(file, content, original.version);
    try { await this.store.addChanges([change]); }
    catch (error) {
      const latest = await currentText(file);
      if (latest.version === change.afterVersion) {
        if (before === null) await rm(file, { force: true });
        else await atomicTextWrite(file, before, change.afterVersion);
      }
      throw error;
    }
    if (sessionId) this.remember(project, sessionId, file, change.afterVersion);
    this.changed(project.id);
  }

  async edit(project: Project, requested: string, oldText: string, newText: string, replaceAll = false, sessionId?: string, options: FileWriteOptions = {}): Promise<void> {
    return this.editBatch(project, requested, [{ oldText, newText, replaceAll }], sessionId, options);
  }

  async editBatch(project: Project, requested: string, edits: readonly TextEdit[], sessionId?: string, options: FileWriteOptions = {}): Promise<void> {
    return this.exclusive(project, async () => {
      const file = await this.read(project, requested);
      this.checkVersion(project, file.path, file.version, sessionId, options, file.content!);
      const content = applyTextEdits(file.content!, edits);
      await this.writeLocked(project, requested, content, sessionId, { ...options, expectedVersion: file.version });
    });
  }

  /** Newest first. A change whose stored body is unreadable is omitted here; undoing it reports the error. */
  async changes(projectId: string, sessionId?: string): Promise<FileChange[]> {
    const records = await this.store.view(state => state.changes.filter(value => value.projectId === projectId && (!sessionId || value.sessionId === sessionId)));
    return (await this.store.changeBodies(records, true)).reverse();
  }

  async createCheckpoint(project: Project, sessionId: string, title = 'Изменения задачи', runId?: string): Promise<TaskCheckpoint> {
    await this.session(project, sessionId);
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('Checkpoint title must contain 1–160 characters.');
    if (runId && !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid run identifier.');
    const checkpoint: TaskCheckpoint = { id: randomUUID(), projectId: project.id, sessionId, title: title.trim(), createdAt: new Date().toISOString(), runId };
    await this.store.mutate(state => {
      const collection = state as typeof state & { checkpoints?: TaskCheckpoint[] };
      collection.checkpoints ??= [];
      collection.checkpoints.push(checkpoint);
      collection.checkpoints = evictCheckpoints(collection.checkpoints, state.changes, project.id);
    });
    return checkpoint;
  }
  async checkpoints(projectId: string, sessionId?: string): Promise<TaskCheckpoint[]> {
    const state = await this.store.read() as Awaited<ReturnType<StateStore['read']>> & { checkpoints?: TaskCheckpoint[] };
    return (state.checkpoints ?? []).filter(point => point.projectId === projectId && (!sessionId || point.sessionId === sessionId)).reverse();
  }
  private async changeCheckpoint(project: Project, sessionId?: string, explicitId?: string): Promise<string | undefined> {
    if (explicitId) {
      const checkpoint = (await this.checkpoints(project.id, sessionId)).find(point => point.id === explicitId);
      if (!sessionId || !checkpoint || checkpoint.sessionId !== sessionId) throw new Error('Checkpoint does not belong to this task and project.');
      return explicitId;
    }
    if (!sessionId) return undefined;
    // Legacy callers may capture shell snapshots without a saved chat.
    if (!(await this.store.read()).sessions.some(session => session.id === sessionId && session.projectId === project.id)) return undefined;
    return (await this.checkpoints(project.id, sessionId))[0]?.id ?? (await this.createCheckpoint(project, sessionId)).id;
  }

  async revert(project: Project, changeId: string): Promise<void> {
    return this.exclusive(project, async () => {
      const change = await this.store.view(state => state.changes.find(value => value.id === changeId && value.projectId === project.id));
      if (!change) throw new Error('Change not found in this project.');
      await this.revertLocked(project, await this.store.changeBodies([change]));
    });
  }
  async revertCheckpoint(project: Project, checkpointId: string): Promise<void> {
    return this.exclusive(project, async () => {
      const checkpoint = (await this.checkpoints(project.id)).find(point => point.id === checkpointId);
      if (!checkpoint) throw new Error('Checkpoint not found in this project.');
      const records = await this.store.view(state => state.changes.filter(change => change.projectId === project.id && change.checkpointId === checkpointId));
      await this.revertLocked(project, await this.store.changeBodies(records));
    });
  }
  private async revertLocked(project: Project, changes: FileChange[]): Promise<void> {
    const planned = new Map<string, { before: string | null; after: string | null }>();
    for (const change of changes) {
      const file = await this.resolvePath(project, change.path, true);
      const previous = planned.get(file);
      if (previous && previous.after !== change.before) throw new Error('Checkpoint includes intervening edits from another task. Undo refused to preserve newer edits.');
      planned.set(file, { before: previous ? previous.before : change.before, after: change.after });
    }
    // Validate EVERY file before touching any file; one stale file revokes the group.
    for (const [file, change] of planned) if ((await currentText(file)).content !== change.after) throw new Error('File changed after this snapshot. Undo refused to preserve newer edits.');
    const applied: string[] = [];
    try {
      for (const [file, change] of planned) {
        const version = change.after === null ? null : fileVersion(change.after);
        if (change.before === null) {
          if ((await currentText(file)).version !== version) throw new FileConflictError(file, version, (await currentText(file)).version);
          await rm(file, { force: true });
        } else await atomicTextWrite(file, change.before, version);
        applied.push(file);
      }
      await this.store.removeChanges(changes.map(change => change.id));
    } catch (error) {
      // External writers are not covered by our mutex. Roll back only our own
      // untouched results, never replace a newer external edit during recovery.
      for (const file of applied.reverse()) {
        const change = planned.get(file)!;
        const expected = change.before === null ? null : fileVersion(change.before);
        if ((await currentText(file)).version !== expected) continue;
        if (change.after === null) await rm(file, { force: true });
        else await atomicTextWrite(file, change.after, expected);
      }
      throw error;
    }
    this.changed(project.id);
  }

  private async enumerate(project: Project, requested?: string, limit = 4000, writableOnly = false): Promise<{ files: string[]; truncated: boolean }> {
    const roots = requested ? [await this.resolvePath(project, requested)] : project.folders.filter(folder => !writableOnly || folder.access === 'write').map(folder => folder.path);
    const found: string[] = [];
    const visited = new Set<string>();
    let examined = 0;
    let truncated = false;
    const visit = async (candidate: string, depth: number): Promise<void> => {
      if (isSensitivePath(candidate)) return;
      if (depth > 12 || examined >= limit) { truncated = true; return; }
      examined++;
      let canonical: string;
      try { canonical = await this.resolvePath(project, candidate); } catch { return; }
      // Explicit writable descendants are visited as roots even when their
      // readonly ancestor is skipped. Keep the full project for permission checks.
      if (writableOnly && !(await this.writable(project, canonical))) return;
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const info = await stat(canonical);
      if (info.isFile()) { found.push(canonical); return; }
      if (!info.isDirectory()) return;
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (examined >= limit) { truncated = true; break; }
        if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
        await visit(path.join(canonical, entry.name), depth + 1);
      }
    };
    for (const root of roots) await visit(root, 0);
    return { files: found, truncated };
  }

  async walk(project: Project, requested?: string, limit = 4000): Promise<string[]> { return (await this.enumerate(project, requested, limit)).files; }
  async walkDetailed(project: Project, requested?: string, limit = 4000): Promise<{ files: string[]; truncated: boolean }> { return this.enumerate(project, requested, Math.max(1, Math.min(20000, limit))); }

  private async snapshot(project: Project): Promise<{ files: Map<string, string>; knownPaths: Set<string>; truncated: boolean; skipped: number }> {
    const scan = await this.enumerate(project, undefined, 4000, true);
    const files = new Map<string, string>();
    const knownPaths = new Set(scan.files);
    let bytes = 0;
    let skipped = 0;
    for (const file of scan.files) {
      if (!(await this.writable(project, file))) continue;
      try {
        const content = await readTextFile(file);
        const size = Buffer.byteLength(content);
        if (bytes + size > 32 * 1024 * 1024) { skipped++; continue; }
        files.set(file, content);
        bytes += size;
      } catch { skipped++; }
    }
    return { files, knownPaths, truncated: scan.truncated, skipped };
  }

  /** Capture shell edits as well as tool edits; never claim complete coverage after a bounded scan. */
  async trackCommand(project: Project, sessionId: string, action: () => Promise<string>, explicitCheckpointId?: string): Promise<string> {
    return this.exclusive(project, async () => {
      const privateRoot = await this.privateDirectory();
      await restoreBackgroundTaint(privateRoot);
      const capture = beginSnapshot(project, privateRoot);
      const notice = '[Command changes were not added to task undo: a background process or an unverified detached child may write in overlapping folders. После фоновой команды снимки команд отключены для этих папок, включая перезапуск, чтобы не приписать чужие правки задаче. File-tool checkpoints remain available.]';
      try {
        if (capture.ambiguous()) {
          try { return `${await action()}\n\n${notice}`; }
          catch (error) { throw new Error(`${(error as Error).message}\n${notice}`); }
        }
        const before = await this.snapshot(project);
        const checkpointId = await this.changeCheckpoint(project, sessionId, explicitCheckpointId);
        let output = '';
        let failure: Error | undefined;
        try { output = await action(); } catch (error) { failure = error as Error; }
        const after = await this.snapshot(project);
        if (capture.ambiguous()) {
          if (failure) throw new Error(`${failure.message}\n${notice}`);
          return `${output}\n\n${notice}`;
        }
        const changes: FileChange[] = [];
        let skipped = before.skipped + after.skipped;
        for (const [file, original] of before.files) {
          let current: string | null = null;
          try {
            const canonical = await this.resolvePath(project, file, true);
            if (canonical !== file) { skipped++; continue; }
            current = await readTextFile(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped++; continue; }
          }
          if (original !== current) changes.push({ id: randomUUID(), projectId: project.id, path: file, before: original, after: current, sessionId, createdAt: new Date().toISOString() });
        }
        if (!before.truncated) for (const [file, content] of after.files) {
          if (!before.knownPaths.has(file)) changes.push({ id: randomUUID(), projectId: project.id, path: file, before: null, after: content, sessionId, createdAt: new Date().toISOString() });
        }
        if (changes.length) {
          const grouped = changes.map(change => ({ ...change, checkpointId, beforeVersion: change.before === null ? null : fileVersion(change.before), afterVersion: change.after === null ? null : fileVersion(change.after) }));
          await this.store.addChanges(grouped); this.changed(project.id);
        }
        const coverage = `Recorded ${changes.length} text file changes. Snapshots cover permitted writable text files up to 2 MiB each, 32 MiB total and 4000 scanned entries; dependency/build/credential paths are excluded.${skipped ? ` ${skipped} file reads were skipped (binary, oversized, inaccessible or total budget).` : ''}${before.truncated || after.truncated ? ' Directory scan limit was reached; coverage is incomplete and new files may be untracked.' : ''} Снимки показывают изменения за время команды; перед откатом проверьте diff, параллельные внешние правки могут попасть в снимок.`;
        if (failure) throw new Error(`${failure.message}\n${coverage}`);
        return `${output}\n\n${coverage}`;
      } finally { capture.release(); }
    });
  }

  async search(project: Project, query: string, requested?: string, maxResults = 60, contextLines?: number, options: SearchOptions = {}): Promise<string> {
    if (!query || query.length > 1000) throw new Error('Supply a nonempty search string up to 1000 characters.');
    const maximum = Math.max(1, Math.min(200, maxResults));
    if (options.regex !== undefined || options.glob !== undefined || options.ignoreCase !== undefined) {
      const scan = await this.walkDetailed(project, requested);
      const roots = requested ? [await this.resolvePath(project, requested)] : project.folders.map(folder => folder.path);
      const text = await ripgrepSearch(scan.files, roots, query, maximum, contextLines, options,
        async file => readTextFile(await this.resolvePath(project, file), 512 * 1024));
      return text + (scan.truncated ? '\n[File scan limit reached; narrow path. Results are incomplete.]' : '');
    }
    if (contextLines !== undefined) {
      const scan = await this.walkDetailed(project, requested);
      const text = await searchExcerpts(scan.files, query, maximum, contextLines, async file => readTextFile(await this.resolvePath(project, file), 512 * 1024));
      return text + (scan.truncated ? '\n[File scan limit reached; narrow path. Results are incomplete.]' : '');
    }
    const results: string[] = [];
    const needle = query.toLowerCase();
    for (const file of await this.walk(project, requested)) {
      try {
        const text = await readTextFile(await this.resolvePath(project, file), 512 * 1024);
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].toLowerCase().includes(needle)) results.push(`${file}:${index + 1}: ${lines[index].slice(0, 500)}`);
          if (results.length >= maximum) return `${results.join('\n')}\n[Result limit reached]`;
        }
      } catch { /* Binary, large and inaccessible files are not searched. */ }
    }
    return results.join('\n') || 'No matching text found in permitted files.';
  }

  async rules(project: Project): Promise<RuleDocument[]> {
    const documents: RuleDocument[] = [{ path: `project:${project.id}`, content: project.instructions, version: fileVersion(project.instructions), scope: 'Project settings', writable: true }];
    const files = await this.walk(project, undefined, 2500);
    const agents = files.filter(file => path.basename(file) === 'AGENTS.md').slice(0, 80);
    for (const root of project.folders) {
      const rule = path.join(root.path, 'AGENTS.md');
      if (!agents.includes(rule)) agents.unshift(rule);
    }
    for (const file of [...new Set(agents)]) {
      try { await this.resolvePath(project, file); const content = await readTextFile(file, 128 * 1024); documents.push({ path: file, content, version: fileVersion(content), scope: path.dirname(file), writable: await this.writable(project, file) }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') documents.push({ path: file, content: '', scope: path.dirname(file), writable: await this.writable(project, file) });
      }
    }
    return documents;
  }
}
