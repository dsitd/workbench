import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GitDiff, GitFileStatus, GitRootStatus, GitStatus, Project } from '../shared/types';
import { isSensitivePath, isWithin } from './access';
import { FileService } from './files';
import { CommandService, redactCommandOutput, sandboxAvailable, sandboxProfile } from './commands';

interface Repository { root: string; git: string; scratch: string; shadow: string; objects: string; privateRoot: string }
const MAX_OUTPUT = 120_000;
async function metadata(file: string, max: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || info.size > max) throw new Error('Git metadata exceeds the supported limit.'); return await handle.readFile(); }
  finally { await handle.close(); }
}
/** Read-only Git over a sanitized metadata view; local config/remotes/hooks are never loaded. */
export class GitService {
  constructor(private files: FileService, _commands?: CommandService) {}
  private async repository(project: Project, requestedRoot: string): Promise<Repository | undefined> {
    const root = await this.files.resolvePath(project, requestedRoot);
    if (!project.folders.some(folder => folder.path === root)) throw new Error('Choose an authorized project root for Git.');
    const git = path.join(root, '.git');
    try { if (!(await lstat(git)).isDirectory() || await realpath(git) !== git) throw new Error('Linked or external Git metadata is unavailable; select the repository root directly.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const privateRoot = await this.files.privateDirectory();
    if (isWithin(privateRoot, git)) throw new Error('Application storage is private.');
    if (!(await sandboxAvailable())) throw new Error('The macOS Git sandbox is unavailable.');
    const scratch = path.join(privateRoot, 'git-scratch', randomUUID());
    const shadow = path.join(scratch, 'repository');
    await mkdir(shadow, { recursive: true, mode: 0o700 });
    try {
      const head = await metadata(path.join(git, 'HEAD'), 1024);
      const headText = head.toString('utf8').trim();
      if (!/^(?:[a-f0-9]{40}|ref: refs\/[A-Za-z0-9_./-]+)$/.test(headText) || headText.includes('..')) throw new Error('Unsupported Git HEAD metadata.');
      await writeFile(path.join(shadow, 'HEAD'), head, { mode: 0o600 });
      // Git may otherwise consult config includes, credential URLs and hooks.
      await writeFile(path.join(shadow, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n', { mode: 0o600 });
      for (const name of ['index', 'packed-refs']) {
        try { await writeFile(path.join(shadow, name), await metadata(path.join(git, name), name === 'index' ? 16 * 1024 * 1024 : 2 * 1024 * 1024), { mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      let count = 0;
      const copyRefs = async (directory: string, destination: string, depth = 0): Promise<void> => {
        if (depth > 12) throw new Error('Git refs exceed the supported depth.');
        await mkdir(destination, { recursive: true, mode: 0o700 });
        let entries; try { if (await realpath(directory) !== directory) throw new Error('Symlinked Git refs are unavailable.'); entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          if (++count > 2000) throw new Error('Git refs exceed the supported count.');
          const source = path.join(directory, entry.name); const target = path.join(destination, entry.name);
          if (entry.isDirectory()) { if (await realpath(source) !== source) throw new Error('Symlinked Git refs are unavailable.'); await copyRefs(source, target, depth + 1); }
          else if (entry.isFile()) { const content = await metadata(source, 1024); if (!/^[a-f0-9]{40}\s*$/.test(content.toString('utf8'))) throw new Error('Unsupported Git ref metadata.'); await writeFile(target, content, { mode: 0o600 }); }
          else throw new Error('Symlinked Git refs are unavailable.');
        }
      };
      await copyRefs(path.join(git, 'refs'), path.join(shadow, 'refs'));
      const objects = path.join(git, 'objects');
      if (await realpath(objects) !== objects) throw new Error('External Git objects are unavailable.');
      await symlink(objects, path.join(shadow, 'objects'));
      return { root, git, scratch, shadow, objects, privateRoot };
    } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
  }
  private async run(project: Project, repo: Repository, args: string[]): Promise<{ text: string; truncated: boolean }> {
    const profile = `${sandboxProfile(project.folders.map(folder => ({ path: folder.path, access: 'read' })), repo.scratch, false, repo.privateRoot, [], [repo.objects])}\n(deny file-read* (literal ${JSON.stringify(path.join(repo.objects, 'info', 'alternates'))}))`;
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/git', '--no-pager', '--git-dir', repo.shadow, '--work-tree', repo.root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '-c', 'status.renames=false', '-c', 'diff.external=', ...args], {
        cwd: repo.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: repo.scratch, TMPDIR: repo.scratch, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat' },
      });
      let stdout = ''; let truncated = false;
      const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
      const timer = setTimeout(kill, 8000);
      child.stdout.on('data', (data: Buffer) => { const chunk = data.toString('utf8'); if (stdout.length + chunk.length > MAX_OUTPUT) truncated = true; stdout += chunk.slice(0, Math.max(0, MAX_OUTPUT - stdout.length)); });
      child.stderr.on('data', () => undefined); // Never expose raw metadata/config errors.
      child.on('error', () => { clearTimeout(timer); kill(); reject(new Error('Git process could not start.')); });
      child.on('close', code => { clearTimeout(timer); kill(); if (code !== 0) reject(new Error('Git read failed or exceeded its time limit. Repository contents were preserved.')); else resolve({ text: stdout, truncated }); });
    });
  }
  private async safePaths(project: Project, repo: Repository): Promise<string[]> {
    const listed = await this.run(project, repo, ['ls-files', '-z', '--cached']);
    if (listed.truncated) throw new Error('Git tracked-file listing exceeds the supported limit.');
    const paths: string[] = [];
    for (const relative of listed.text.split('\0').filter(Boolean)) {
      const absolute = path.resolve(repo.root, relative);
      if (!isWithin(repo.root, absolute) || isSensitivePath(absolute)) continue;
      try { if (await this.files.resolvePath(project, absolute) === absolute) paths.push(relative); } catch { /* Private/escaping paths are omitted. */ }
    }
    if (paths.length > 1500) throw new Error('Git overview is limited to 1500 permitted tracked files.');
    return paths;
  }
  async status(project: Project): Promise<GitStatus> {
    const roots: GitRootStatus[] = [];
    for (const folder of project.folders) {
      let repo: Repository | undefined;
      try {
        repo = await this.repository(project, folder.path);
        if (!repo) { roots.push({ root: folder.path, repository: false, files: [] }); continue; }
        const paths = await this.safePaths(project, repo);
        const headText = (await metadata(path.join(repo.shadow, 'HEAD'), 1024)).toString('utf8').trim();
        const branch = headText.startsWith('ref: refs/heads/') ? headText.slice('ref: refs/heads/'.length) : '(detached)';
        let head: string | undefined;
        try { head = (await this.run(project, repo, ['rev-parse', 'HEAD'])).text.trim(); } catch { /* A repository without commits still has a branch and untracked files. */ }
        const files: GitFileStatus[] = [];
        if (paths.length) {
          const output = await this.run(project, repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...paths.map(file => `:(literal)${file}`)]);
          if (output.truncated) throw new Error('Git status exceeds the supported limit.');
          const entries = output.text.split('\0').filter(Boolean);
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]; const relative = entry.slice(3); const absolute = path.resolve(repo.root, relative);
            if (!isWithin(repo.root, absolute) || isSensitivePath(absolute)) continue;
            await this.files.resolvePath(project, absolute);
            const rename = /[RC]/.test(entry.slice(0, 2));
            files.push({ path: absolute, index: entry[0], worktree: entry[1], ...(rename ? { originalPath: path.resolve(repo.root, entries[++i]) } : {}) });
          }
        }
        const scan = await this.files.walkDetailed(project, repo.root, 5000);
        if (scan.truncated) throw new Error('Git overview scan limit was reached; refresh a smaller project root.');
        const candidates = scan.files.map(file => path.relative(repo!.root, file));
        if (candidates.length > 1500) throw new Error('Git untracked-file overview is limited to 1500 permitted files.');
        if (candidates.length) {
          const untracked = await this.run(project, repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...candidates.map(file => `:(literal)${file}`)]);
          if (untracked.truncated) throw new Error('Git untracked-file listing exceeds the supported limit.');
          for (const relative of untracked.text.split('\0').filter(Boolean)) {
            const absolute = await this.files.resolvePath(project, path.resolve(repo.root, relative));
            files.push({ path: absolute, index: '?', worktree: '?' });
          }
        }
        roots.push({ root: repo.root, repository: true, branch, head, files });
      } catch (error) { roots.push({ root: folder.path, repository: Boolean(repo), files: [], error: (error as Error).message }); }
      finally { if (repo) await rm(repo.scratch, { recursive: true, force: true }); }
    }
    return { roots };
  }
  async diff(project: Project, root: string, requested?: string, staged = false): Promise<GitDiff> {
    const repo = await this.repository(project, root);
    if (!repo) return { root, path: requested, staged, text: 'This folder is not a Git repository.', truncated: false };
    try {
      let paths = await this.safePaths(project, repo);
      if (requested) {
        const file = await this.files.resolvePath(project, path.resolve(repo.root, requested));
        if (!isWithin(repo.root, file)) throw new Error('Git diff path is outside the selected repository.');
        paths = [path.relative(repo.root, file)];
      }
      if (!paths.length) return { root: repo.root, path: requested, staged, text: '', truncated: false };
      const result = await this.run(project, repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', ...(staged ? ['--cached'] : []), '--', ...paths.map(file => `:(literal)${file}`)]);
      return { root: repo.root, path: requested, staged, text: redactCommandOutput(result.text), truncated: result.truncated };
    } finally { await rm(repo.scratch, { recursive: true, force: true }); }
  }
}
