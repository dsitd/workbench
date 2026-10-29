import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validId } from './storage';

/** Durable private records. Serialize dependent read/write transactions in the owning service. */
export class PrivateRecords<T extends { id: string }> {
  constructor(readonly directory: string) {}
  async get(id: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(path.join(this.directory, `${validId(id)}.json`), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Could not read a private task record.'); }
  }
  async save(record: T): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.record-${randomUUID()}.tmp`);
    const destination = path.join(this.directory, `${validId(record.id)}.json`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async remove(id: string): Promise<void> { await unlink(path.join(this.directory, `${validId(id)}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  /** One unreadable record must not hide or break the others; `get` still reports it to its own reader. */
  async list(): Promise<T[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: T[] = [];
    for (const name of names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
      try { const record = await this.get(name.slice(0, -5)); if (record) records.push(record); } catch { /* corrupt or unreadable record: skipped */ }
    }
    return records;
  }
}
