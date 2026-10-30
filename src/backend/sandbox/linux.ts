import { access, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isSensitivePath, isWithin } from '../access';
import type { SandboxLaunch, SandboxOptions } from './types';

const binary = '/usr/bin/bwrap';
// Do not expose /usr/local/etc or an entire host /etc just to load executables.
const systemDirectories = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/share',
  '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/lib64', '/usr/local/libexec', '/usr/local/share',
  '/bin', '/sbin', '/lib', '/lib64'];
const systemFiles = ['/etc/ld.so.cache', '/etc/localtime', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/alternatives'];
const networkFiles = ['/etc/resolv.conf', '/etc/hosts', '/etc/gai.conf', '/etc/ssl/certs', '/etc/pki/ca-trust'];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

/** Names and stat metadata only: never opens the protected contents being hidden. */
async function hiddenPaths(options: SandboxOptions): Promise<Map<string, boolean>> {
  const hidden = new Map<string, boolean>();
  const visited = new Set<string>();
  const exceptions = [options.temporary, ...(options.skillRoots ?? []), ...(options.metadataReadRoots ?? [])];
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 250_000) throw new Error('Sandbox metadata scan limit exceeded. Select smaller project folders.');
      const file = path.join(directory, entry.name);
      if (exceptions.includes(file)) continue;
      if (file === options.privateRoot || (isSensitivePath(entry.name) && !(options.metadataReadRoots ?? []).some(root => isWithin(root, file))) || entry.isSocket() || entry.isFIFO() || entry.isBlockDevice() || entry.isCharacterDevice()) {
        // Mount destinations must never follow a user symlink while masking it.
        // Refuse that command rather than accidentally mounting over its target.
        if (entry.isSymbolicLink()) throw new Error('A protected path is a symbolic link. Remove it from the command scope before running commands.');
        hidden.set(file, entry.isDirectory());
      } else if (entry.isDirectory()) await walk(file);
    }
  };
  for (const root of options.roots) {
    if (root.path === options.privateRoot) throw new Error('Application storage cannot be a sandbox root.');
    if (!options.privateRoot || !isWithin(options.privateRoot, root.path)) await walk(root.path);
  }
  // A permitted metadata subtree (Git objects) still has its own restrictions.
  for (const root of [...(options.skillRoots ?? []), ...(options.metadataReadRoots ?? [])]) await walk(root);
  for (const file of options.deniedFiles ?? []) {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Denied metadata is a symbolic link.');
      hidden.set(file, info.isDirectory());
    } catch (error) { if (!missing(error)) throw error; }
  }
  return hidden;
}

/** All mounts are explicit. No host home, session bus, host /proc or inherited FDs. */
export async function prepareLinuxSandbox(options: SandboxOptions, executable: string, commandArgs: string[]): Promise<SandboxLaunch> {
  if (options.localhostPort) throw new Error('A Linux benchmark gateway requires a socket relay.');
  const canonical = async (file: string) => {
    if (!path.isAbsolute(file) || await realpath(file) !== file) throw new Error('Sandbox path identity changed. Re-select its canonical path.');
  };
  for (const root of options.roots) await canonical(root.path);
  await canonical(options.temporary);
  if (options.privateRoot) await canonical(options.privateRoot);
  for (const root of [...(options.skillRoots ?? []), ...(options.metadataReadRoots ?? [])]) await canonical(root);
  const hidden = await hiddenPaths(options);
  const stage = await mkdtemp(path.join(await realpath(os.tmpdir()), 'workbench-sandbox-masks-'));
  const cleanup = async () => { await rm(stage, { recursive: true, force: true }); };
  try {
    const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--new-session', '--die-with-parent', '--cap-drop', 'ALL'];
    if (options.internet) args.push('--share-net');
    for (const directory of systemDirectories) {
      if (!(await exists(directory))) continue;
      if ((await lstat(directory)).isSymbolicLink()) args.push('--symlink', await readlink(directory), directory);
      else args.push('--ro-bind', directory, directory);
    }
    for (const file of [...systemFiles, ...(options.internet ? networkFiles : [])]) {
      if (await exists(file)) args.push('--ro-bind', file, file);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
    // A child mount overrides its parent, independently of UI selection order.
    const roots = [...options.roots];
    if (options.privateRoot) {
      // A mount on appdata alone does not prevent renaming its parent directory.
      // Anchor every authorized ancestor without changing its effective rights.
      let ancestor = path.dirname(options.privateRoot);
      while (ancestor !== path.dirname(ancestor)) {
        const owner = options.roots.filter(root => isWithin(root.path, ancestor)).sort((a, b) => b.path.length - a.path.length)[0];
        if (owner && !roots.some(root => root.path === ancestor)) roots.push({ path: ancestor, access: owner.access });
        ancestor = path.dirname(ancestor);
      }
    }
    roots.sort((a, b) => a.path.length - b.path.length);
    for (const root of roots) args.push(root.access === 'write' ? '--bind' : '--ro-bind', root.path, root.path);
    const exceptions = [options.temporary, ...(options.skillRoots ?? []), ...(options.metadataReadRoots ?? [])];
    const masks = new Map<string, string>();
    let index = 0;
    for (const [file, directory] of [...hidden].sort(([a], [b]) => a.length - b.length)) {
      const mask = path.join(stage, String(index++));
      if (directory) {
        await mkdir(mask);
        for (const permitted of exceptions.filter(root => isWithin(file, root))) {
          await mkdir(path.join(mask, path.relative(file, permitted)), { recursive: true });
        }
        // Empty, read-only directory keeps permitted descendants traversable.
        // Ancestor renames also fail because this is a mountpoint.
      } else await writeFile(mask, '', { mode: 0o000 });
      args.push('--ro-bind', mask, file);
      masks.set(file, mask);
    }
    // Restore only the explicit exceptions through hidden appdata/Git parents.
    for (const root of [...(options.skillRoots ?? []), ...(options.metadataReadRoots ?? [])]) args.push('--ro-bind', root, root);
    args.push('--bind', options.temporary, options.temporary);
    for (const [file, mask] of masks) {
      if (exceptions.some(root => isWithin(root, file))) args.push('--ro-bind', mask, file);
    }
    // Denials inside an exception must be applied last (e.g. Git alternates).
    for (const file of options.deniedFiles ?? []) {
      if (!(await exists(file))) continue;
      const mask = path.join(stage, String(index++));
      await writeFile(mask, '', { mode: 0o000 });
      args.push('--ro-bind', mask, file);
    }
    for (const file of options.readFiles ?? []) {
      await canonical(file);
      if (isSensitivePath(file) || options.privateRoot && isWithin(options.privateRoot, file)) throw new Error('Protected executable cannot be exposed to a sandbox.');
      args.push('--ro-bind', file, file);
    }
    // None of the mount sources may be altered after inspection. Canonicalize
    // again immediately before returning the launch plan; no permissive fallback.
    for (const root of options.roots) await canonical(root.path);
    return { executable: binary, args: [...args, '--', executable, ...commandArgs], cleanup };
  } catch (error) { await cleanup(); throw error; }
}

let probe: Promise<boolean> | undefined;
export async function linuxSandboxAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  probe ??= (async () => {
    try { await access(binary, constants.X_OK); } catch { return false; }
    const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), 'workbench-sandbox-probe-'));
    let launch: SandboxLaunch | undefined;
    try {
      launch = await prepareLinuxSandbox({ roots: [], temporary: scratch, internet: false }, '/bin/true', []);
      return await new Promise<boolean>(resolve => {
        const child = spawn(launch!.executable, launch!.args, { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 3000);
        child.once('error', () => { clearTimeout(timer); resolve(false); });
        child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
      });
    } catch { return false; }
    finally { await launch?.cleanup(); await rm(scratch, { recursive: true, force: true }); }
  })();
  const available = await probe;
  if (!available) probe = undefined;
  return available;
}
