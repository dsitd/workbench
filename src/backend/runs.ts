import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RunRecord } from '../shared/types';
import { validId } from './storage';

type RunKey = Pick<RunRecord, 'projectId' | 'sessionId' | 'startedAt'>;

/** Run updates never rewrite conversation history. Each run is an atomic private record. */
export class RunStore {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  // id -> owner keys; loaded once inside the queue, then updated by save/remove so filtered lists read only matching files.
  private keys?: Map<string, RunKey>;
  private loading?: Promise<Map<string, RunKey>>;
  // id -> digest of the last record this store wrote; an identical save is skipped.
  private written = new Map<string, string>();
  constructor(dataDir: string) { this.directory = path.join(dataDir, 'runs'); }
  private file(id: string) { return path.join(this.directory, `${validId(id)}.json`); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const pending = this.queue.then(operation); this.queue = pending.catch(() => undefined); return pending; }
  private async read(id: string): Promise<RunRecord | undefined> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')) as RunRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Не удалось прочитать журнал запуска.'); }
  }
  private index(): Promise<Map<string, RunKey>> {
    if (this.keys) return Promise.resolve(this.keys);
    return this.loading ??= this.enqueue(async () => {
      let names: string[] = [];
      try { names = await readdir(this.directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const keys = new Map<string, RunKey>();
      for (const name of names.filter(value => /^[a-zA-Z0-9_-]+\.json$/.test(value))) {
        try { const run = await this.read(name.slice(0, -5)); if (run) keys.set(run.id, { projectId: run.projectId, sessionId: run.sessionId, startedAt: run.startedAt }); } catch { /* corrupt run: skipped */ }
      }
      return this.keys = keys;
    }).finally(() => { this.loading = undefined; });
  }
  async get(id: string): Promise<RunRecord | undefined> { await this.queue; return this.read(id); }
  async save(record: RunRecord): Promise<void> {
    const text = JSON.stringify(record), digest = createHash('sha256').update(text).digest('base64');
    const { id, projectId, sessionId, startedAt } = record, file = this.file(id);
    await this.enqueue(async () => {
      if (this.written.get(id) === digest) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `.run-${randomUUID()}.tmp`);
      try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
      catch (error) { this.written.delete(id); await unlink(temporary).catch(() => undefined); throw error; }
      this.written.set(id, digest);
      this.keys?.set(id, { projectId, sessionId, startedAt });
    });
  }
  async list(projectId?: string, sessionId?: string): Promise<RunRecord[]> {
    if (projectId) validId(projectId); if (sessionId) validId(sessionId);
    const keys = await this.index(); await this.queue;
    const records: RunRecord[] = [];
    for (const [id, key] of [...keys]) if ((!projectId || key.projectId === projectId) && (!sessionId || key.sessionId === sessionId)) {
      try { const run = await this.read(id); if (run) records.push(run); } catch { /* corrupt run: skipped */ }
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  /** Removes run records of a deleted project. */
  async removeProject(projectId: string): Promise<number> {
    validId(projectId); await this.index();
    return this.enqueue(async () => {
      let removed = 0;
      for (const [id, key] of [...this.keys!]) if (key.projectId === projectId) {
        await unlink(this.file(id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        this.keys!.delete(id); this.written.delete(id); removed++;
      }
      return removed;
    });
  }
  async recover(): Promise<void> {
    for (const run of await this.list()) {
      let changed = false;
      if (run.verification?.status === 'running') {
        run.verification.status = 'cancelled'; run.verification.finishedAt = new Date().toISOString();
        run.verification.durationMs = Date.parse(run.verification.finishedAt) - Date.parse(run.verification.startedAt);
        run.verification.output += '\nПроверка прервана при закрытии приложения; запустите её заново.';
        run.phase = 'final'; changed = true;
      }
      if (run.status === 'running') {
        run.status = 'interrupted'; run.phase = 'final'; run.canContinue = run.kind !== 'title';
        run.finishedAt = new Date().toISOString(); run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
        run.error = 'Приложение было закрыто во время задачи. Завершённые шаги сохранены; неопределённые действия не повторяются автоматически.';
        changed = true;
      }
      if (changed) await this.save(run);
    }
  }
}
