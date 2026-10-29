import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { assertNonSensitive, isSensitivePath, isWithin } from './access';
import { readTextFile } from './files';
import { downloadPublic } from './network';
import { requireItem, StateStore, validId } from './storage';
import type { Skill, SkillInput, SkillSource } from '../shared/types';

const MAX_FILES = 2500;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
type PackageFiles = Map<string, Uint8Array>;

export function validateArchivePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Unsafe archive path.');
  const parts = value.split('/');
  if (parts.some(part => part === '..' || part === '.' || part.includes(':'))) throw new Error('Archive path traversal is blocked.');
  return parts.filter(Boolean).join('/');
}

export function decodeSkillArchive(buffer: Uint8Array): PackageFiles {
  if (buffer.length > 35 * 1024 * 1024) throw new Error('Compressed skill archive is too large.');
  let count = 0;
  let total = 0;
  const decoded = unzipSync(buffer, { filter: file => {
    validateArchivePath(file.name);
    count++;
    total += file.originalSize;
    if (count > MAX_FILES || total > MAX_TOTAL || file.originalSize > MAX_FILE) throw new Error('Skill archive exceeds installation limits.');
    return !file.name.endsWith('/') && !isSensitivePath(file.name);
  } });
  const result: PackageFiles = new Map();
  for (const [filename, content] of Object.entries(decoded)) {
    const safe = validateArchivePath(filename);
    if (result.has(safe)) throw new Error('Duplicate archive paths are blocked.');
    result.set(safe, content);
  }
  return result;
}

async function collectLocal(directory: string): Promise<PackageFiles> {
  // User-selected existing skill folders often live under ~/.codex or ~/.agents.
  // Trust only these ancestor container names for this explicit import operation.
  const checkSource = (value: string) => assertNonSensitive(value.split(path.sep).filter(part => !['.codex', '.agents'].includes(part)).join(path.sep));
  checkSource(directory);
  const root = await realpath(directory);
  checkSource(root);
  if (!(await stat(root)).isDirectory()) throw new Error('Skill source must be a directory.');
  const files: PackageFiles = new Map();
  let total = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 14) throw new Error('Skill source directory is too deeply nested.');
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (isSensitivePath(path.relative(root, filename)) || ['node_modules', '.git', '.DS_Store', '__MACOSX'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Skill directories must not contain symbolic links.');
      if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_FILES) throw new Error('Skill source contains too many files.');
      const canonical = await realpath(filename);
      if (!isWithin(root, canonical)) throw new Error('Skill source leaves its directory.');
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        total += info.size;
        if (info.size > MAX_FILE || total > MAX_TOTAL) throw new Error('Skill source exceeds installation size limits.');
        files.set(path.relative(root, filename).split(path.sep).join('/'), await handle.readFile());
      } finally { await handle.close(); }
    }
  };
  await visit(root, 0);
  return files;
}

function parseMetadata(content: string, fallback: string): { name: string; description: string } {
  if (Buffer.byteLength(content) > 128 * 1024) throw new Error('SKILL.md must be at most 128 KiB.');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? '';
  const field = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(frontmatter);
    if (!match) return '';
    let value = match[1].trim();
    if (['|', '>', '|-', '>-'].includes(value)) {
      const remainder = frontmatter.slice((match.index ?? 0) + match[0].length);
      value = remainder.split('\n').slice(1).filter(line => /^\s+/.test(line)).map(line => line.trim()).join(' ');
    }
    return value.replace(/^['"]|['"]$/g, '').slice(0, name === 'name' ? 120 : 2000);
  };
  return { name: field('name') || fallback, description: field('description') || content.split('\n').find(line => line.trim() && !/^#|^---/.test(line.trim()))?.slice(0, 300) || 'Local skill' };
}

function parseGithub(source: SkillSource): { owner: string; repository: string; ref: string; folder: string } {
  const location = source.location?.trim() ?? '';
  let owner = '';
  let repository = '';
  let ref = source.ref || 'HEAD';
  let folder = source.folder || '';
  if (/^https:\/\//i.test(location)) {
    const url = new URL(location);
    if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('Use a public github.com repository URL without credentials.');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    [owner, repository] = parts;
    if (parts[2] === 'tree') { ref = source.ref || parts[3] || 'HEAD'; folder = source.folder || parts.slice(4).join('/'); }
    else if (parts.length > 2) throw new Error('Use a repository URL or a GitHub tree URL.');
  } else [owner, repository] = location.split('/');
  repository = repository?.replace(/\.git$/, '') ?? '';
  if (!/^[\w.-]+$/.test(owner ?? '') || !/^[\w.-]+$/.test(repository) || !ref || ref.length > 150) throw new Error('Invalid GitHub repository or ref.');
  if (folder) folder = validateArchivePath(folder.replace(/\/$/, ''));
  return { owner, repository, ref, folder };
}

export class SkillService {
  constructor(private store: StateStore) {}

  async list(projectId?: string): Promise<Skill[]> {
    return (await this.store.read()).skills.filter(skill => !projectId || !skill.projectId || skill.projectId === projectId);
  }

  async create(input: SkillInput): Promise<Skill> {
    if (!input.name?.trim() || input.name.length > 120) throw new Error('Skill name must contain 1–120 characters.');
    if (typeof input.description !== 'string' || input.description.length > 2000) throw new Error('Skill description must be at most 2000 characters.');
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 120 * 1024) throw new Error('Skill content must be at most 120 KiB.');
    if (input.projectId) requireItem((await this.store.read()).projects, validId(input.projectId), 'Project');
    const id = randomUUID();
    const directory = path.join(this.store.directory, 'skills', input.projectId ? `project-${input.projectId}` : 'global', id);
    const body = input.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const content = `---\nname: ${JSON.stringify(input.name.trim())}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n\n${body}`;
    const skill: Skill = { id, name: input.name.trim(), description: input.description.trim(), source: 'Created locally', projectId: input.projectId, enabled: true, installedAt: new Date().toISOString(), path: directory };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'SKILL.md'), content, { flag: 'wx', mode: 0o600 });
    try { await this.store.mutate(state => { state.skills.push(skill); }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return skill;
  }

  async save(id: string, content: string): Promise<Skill> {
    if (typeof content !== 'string') throw new Error('Skill content must be text.');
    const existing = requireItem((await this.store.read()).skills, validId(id), 'Skill');
    const metadata = parseMetadata(content, existing.name);
    const directory = await this.directory(id);
    const handle = await open(path.join(directory, 'SKILL.md'), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    return this.store.mutate(state => { const skill = requireItem(state.skills, id, 'Skill'); Object.assign(skill, metadata); return skill; });
  }

  async install(source: SkillSource, projectId?: string): Promise<Skill[]> {
    if (projectId) { validId(projectId); requireItem((await this.store.read()).projects, projectId, 'Project'); }
    let files: PackageFiles;
    let origin: string;
    if (source.kind === 'folder') {
      if (!source.location || !path.isAbsolute(source.location)) throw new Error('Choose an absolute local skill directory.');
      files = await collectLocal(source.location);
      origin = source.location;
    } else if (source.kind === 'github') {
      const github = parseGithub(source);
      const archive = await downloadPublic(`https://codeload.github.com/${github.owner}/${github.repository}/zip/${encodeURIComponent(github.ref)}`, { maxBytes: 35 * 1024 * 1024, timeoutMs: 30_000 });
      const decoded = decodeSkillArchive(archive.body);
      files = new Map();
      for (const [name, bytes] of decoded) {
        const relative = name.split('/').slice(1).join('/');
        if (!relative || (github.folder && relative !== github.folder && !relative.startsWith(`${github.folder}/`))) continue;
        files.set(github.folder ? relative.slice(github.folder.length + 1) : relative, bytes);
      }
      origin = `https://github.com/${github.owner}/${github.repository}/tree/${encodeURIComponent(github.ref)}${github.folder ? `/${github.folder}` : ''}`;
    } else throw new Error('Unknown skill installation source.');
    const candidates = [...files.keys()].filter(filename => path.posix.basename(filename) === 'SKILL.md');
    if (!candidates.length) throw new Error('No SKILL.md found in the selected directory.');
    if (candidates.length > 100) throw new Error('Select a subdirectory containing at most 100 skills.');
    const installed: Skill[] = [];
    try {
      for (const document of candidates) {
        const prefix = path.posix.dirname(document) === '.' ? '' : `${path.posix.dirname(document)}/`;
        const metadata = parseMetadata(Buffer.from(files.get(document)!).toString('utf8'), path.posix.basename(path.posix.dirname(document)) || 'skill');
        const id = randomUUID();
        const directory = path.join(this.store.directory, 'skills', projectId ? `project-${projectId}` : 'global', id);
        const skill: Skill = { id, ...metadata, source: origin, projectId, enabled: true, installedAt: new Date().toISOString(), path: directory };
        installed.push(skill);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (const [filename, bytes] of files) {
          if (prefix && !filename.startsWith(prefix)) continue;
          const relative = filename.slice(prefix.length);
          if (!relative || isSensitivePath(relative)) continue;
          const target = path.join(directory, validateArchivePath(relative));
          if (!isWithin(directory, target)) throw new Error('Skill path traversal is blocked.');
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        }
      }
      await this.store.mutate(state => { state.skills.push(...installed); });
      return installed;
    } catch (error) { await Promise.all(installed.map(skill => rm(skill.path, { recursive: true, force: true }))); throw error; }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Skill state must be boolean.');
    await this.store.mutate(state => { requireItem(state.skills, validId(id), 'Skill').enabled = enabled; });
  }

  private async directory(id: string): Promise<string> {
    const skill = requireItem((await this.store.read()).skills, validId(id), 'Skill');
    const canonical = await realpath(skill.path);
    const root = await realpath(path.join(this.store.directory, 'skills'));
    if (!isWithin(root, canonical)) throw new Error('Invalid installed skill path.');
    return canonical;
  }

  async read(id: string): Promise<string> { return readTextFile(path.join(await this.directory(id), 'SKILL.md'), 128 * 1024); }

  async readResource(projectId: string, nameOrId: string, requested: string): Promise<string> {
    if (typeof nameOrId !== 'string' || typeof requested !== 'string') throw new Error('Supply skill and relative resource path.');
    const skill = (await this.list(projectId)).find(value => value.enabled && (value.id === nameOrId || value.name === nameOrId));
    if (!skill) throw new Error('Enabled skill not found for this project.');
    const relative = validateArchivePath(requested);
    assertNonSensitive(relative);
    const directory = await this.directory(skill.id);
    const target = await realpath(path.join(directory, relative));
    if (!isWithin(directory, target)) throw new Error('Skill resource leaves its installed directory.');
    assertNonSensitive(target);
    return readTextFile(target, 512 * 1024);
  }

  async readRoots(projectId: string): Promise<string[]> {
    const roots: string[] = [];
    for (const skill of (await this.list(projectId)).filter(value => value.enabled)) {
      // A skill folder removed outside the app must not disable every command in the project.
      try { roots.push(await this.directory(skill.id)); } catch (error) { if (!missing(error)) throw error; }
    }
    return roots;
  }

  async remove(id: string): Promise<void> {
    try { await rm(await this.directory(id), { recursive: true, force: true }); }
    catch (error) { if (!missing(error)) throw error; }
    await this.store.mutate(state => { state.skills = state.skills.filter(skill => skill.id !== id); });
  }

  async export(id: string): Promise<string> {
    const files = await collectLocal(await this.directory(id));
    const directory = path.join(this.store.directory, 'exports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `skill-${validId(id)}-${Date.now()}.zip`);
    await writeFile(target, zipSync(Object.fromEntries(files), { level: 6 }), { mode: 0o600, flag: 'wx' });
    return target;
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
