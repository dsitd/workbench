import { isWithin } from './access';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types';

interface Scope { roots: string[]; ambiguous: boolean }
const backgrounds = new Set<Scope>();
const captures = new Set<Scope>();
const durableRoots = new Set<string>();
const uncertainStores = new Set<string>();
const records = new Map<string, { roots: string[]; ready: Promise<void>; queue: Promise<void> }>();
const overlap = (first: string[], second: string[]) => first.some(root => second.some(other => isWithin(root, other) || isWithin(other, root)));
const markRoots = (roots: string[]) => {
  for (const root of roots) durableRoots.add(root);
  for (const capture of captures) if (overlap(capture.roots, roots)) capture.ambiguous = true;
};
/** Background programs can create detached sessions. Retain uncertainty across
 * restarts rather than attributing a possible daemon's writes to another task. */
export async function restoreBackgroundTaint(privateRoot: string): Promise<void> {
  let record = records.get(privateRoot);
  if (!record) {
    record = { roots: [], ready: Promise.resolve(), queue: Promise.resolve() };
    records.set(privateRoot, record);
    const current = record;
    current.ready = (async () => {
      let handle;
      try {
        handle = await open(path.join(privateRoot, 'background-write-roots.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1_048_576) throw new Error('Invalid background write record.');
        const value = JSON.parse(await handle.readFile('utf8')) as { version?: unknown; roots?: unknown };
        if (value.version !== 1 || !Array.isArray(value.roots) || value.roots.length > 4096 || value.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096)) throw new Error('Invalid background write record.');
        current.roots = [...new Set(value.roots as string[])]; markRoots(current.roots);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') uncertainStores.add(privateRoot); }
      finally { await handle?.close(); }
    })();
  }
  await record.ready;
}
export async function persistBackgroundTaint(privateRoot: string, roots: string[]): Promise<void> {
  await restoreBackgroundTaint(privateRoot);
  const record = records.get(privateRoot)!;
  const mutation = record.queue.then(async () => {
    if (uncertainStores.has(privateRoot)) throw new Error('Background commands are disabled because their persistent write history could not be verified.');
    const updated = [...new Set([...record.roots, ...roots])];
    if (updated.length > 4096) throw new Error('Too many recorded background write folders.');
    const text = JSON.stringify({ version: 1, roots: updated });
    if (Buffer.byteLength(text) > 1_048_576) throw new Error('Background write folder history exceeds its storage limit.');
    const target = path.join(privateRoot, 'background-write-roots.json');
    const temporary = path.join(privateRoot, `.background-write-roots-${randomUUID()}.tmp`);
    try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    record.roots = updated; markRoots(roots);
  });
  record.queue = mutation.catch(() => undefined); await mutation;
}
export function beginSnapshot(project: Project, privateRoot?: string): { ambiguous(): boolean; release(): void } {
  const roots = project.folders.filter(folder => folder.access === 'write').map(folder => folder.path);
  const capture = { roots, ambiguous: Boolean(privateRoot && uncertainStores.has(privateRoot)) || overlap(roots, [...durableRoots]) || [...backgrounds].some(scope => overlap(roots, scope.roots)) };
  captures.add(capture);
  return { ambiguous: () => capture.ambiguous, release: () => { captures.delete(capture); } };
}
export function beginBackground(roots: string[]): () => void {
  const scope = { roots, ambiguous: false };
  backgrounds.add(scope);
  for (const capture of captures) if (overlap(capture.roots, roots)) capture.ambiguous = true;
  return () => { backgrounds.delete(scope); };
}
