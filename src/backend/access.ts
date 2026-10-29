import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project, ProjectFolder } from '../shared/types';

const protectedParts = new Set(['.ssh', '.aws', '.gnupg', '.git', '.codex', '.agents', 'keychains']);
const protectedFiles = /^(?:\.env(?:[._-].*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|crt|cer|keystore))$/i;

/** Deny known credential containers before opening them, even inside a writable root. */
export function isSensitivePath(value: string): boolean {
  return value.split(/[\\/]/).some(part => protectedParts.has(part.toLowerCase()) || protectedFiles.test(part));
}
export function assertNonSensitive(value: string): void {
  if (isSensitivePath(value)) throw new Error('Access to credential or protected files is blocked.');
}
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function normalizeFolders(folders: ProjectFolder[]): Promise<ProjectFolder[]> {
  if (!Array.isArray(folders) || !folders.length) throw new Error('Select at least one project folder.');
  const result: ProjectFolder[] = [];
  for (const folder of folders) {
    if (!folder || typeof folder.path !== 'string' || !path.isAbsolute(folder.path)) throw new Error('Project folders must use absolute paths.');
    if (!['read', 'write'].includes(folder.access)) throw new Error('Invalid folder access mode.');
    assertNonSensitive(folder.path);
    const canonical = await realpath(folder.path);
    assertNonSensitive(canonical);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Project folder must be a directory.');
    const existing = result.find(value => value.path === canonical);
    if (existing) { if (folder.access === 'write') existing.access = 'write'; }
    else result.push({ path: canonical, access: folder.access });
  }
  return result;
}

/** Canonicalize the nearest existing ancestor for new files, so symlink escapes fail. */
async function canonicalTarget(value: string): Promise<string> {
  let ancestor = value;
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
      return path.join(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function permittedPath(project: Project, requested: string, write = false): Promise<string> {
  if (typeof requested !== 'string' || requested.includes('\0') || requested.length > 4096) throw new Error('Invalid file path.');
  const absolute = path.resolve(project.folders[0]?.path ?? '/', requested);
  assertNonSensitive(absolute);
  const lexicalRoots = project.folders.filter(folder => isWithin(folder.path, absolute)).sort((a, b) => b.path.length - a.path.length);
  if (write && lexicalRoots.length && lexicalRoots[0].access !== 'write') throw new Error('File is inside an explicitly read-only project folder.');
  const canonical = await canonicalTarget(absolute);
  assertNonSensitive(canonical);
  const roots = await Promise.all(project.folders.map(async folder => {
    const anchored = await realpath(folder.path);
    if (anchored !== folder.path) throw new Error('Project folder identity changed. Re-select its path before using it.');
    return { ...folder, path: anchored };
  }));
  const canonicalRoots = roots.filter(folder => isWithin(folder.path, canonical)).sort((a, b) => b.path.length - a.path.length);
  if (!canonicalRoots.length) throw new Error(lexicalRoots.length ? 'Symbolic link leaves the permitted project folder.' : write ? 'File is outside writable project folders.' : 'File is outside project folders.');
  if (write && canonicalRoots[0].access !== 'write') throw new Error('File is inside an explicitly read-only project folder.');
  return canonical;
}

export async function canWrite(project: Project, file: string): Promise<boolean> {
  try { await permittedPath(project, file, true); return true; } catch { return false; }
}
