import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export function isValidId(id: unknown): id is string { return typeof id === 'string' && identifier.test(id); }
export function validId(id: string): string {
  if (!isValidId(id)) throw new Error('Invalid identifier.');
  return id;
}
export function ignoreMissing(error: unknown): void { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

/** Replaces a private file through an exclusive 0o600 temporary file. `durable` flushes the data before the rename. */
export async function writeAtomic(file: string, data: string | Uint8Array, durable = false, prefix = path.basename(file)): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${prefix}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); if (durable) await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { await handle.close(); }
}
