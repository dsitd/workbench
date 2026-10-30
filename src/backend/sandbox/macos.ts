import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isWithin } from '../access';

let sandboxProbe: Promise<boolean> | undefined;
export async function macSandboxAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  sandboxProbe ??= (async () => {
    try { await access('/usr/bin/sandbox-exec', constants.X_OK); } catch { return false; }
    return new Promise<boolean>(resolve => {
      // A present executable does not prove sandbox_apply is permitted in this
      // host environment. Probe an inert command without reading user files.
      const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny file-write*)', '/usr/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 3000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    });
  })();
  const available = await sandboxProbe;
  // A transient failure (for example a probe timeout under load) must not disable
  // commands until restart; only a successful probe is cached.
  if (!available) sandboxProbe = undefined;
  return available;
}

function quote(value: string): string { return JSON.stringify(value); }

export function sandboxProfile(roots: { path: string; access: 'read' | 'write' }[], temporary: string, internet: boolean, privateRoot?: string, skillRoots: string[] = [], metadataReadRoots: string[] = []): string {
  // Broad system reads are needed for executable loaders and SDKs; credential paths
  // are explicitly denied after allow rules, including those inside project roots.
  const caseInsensitive = (word: string) => [...word].map(character => /[a-z]/i.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character).join('');
  const protectedPattern = `(^|/)(\\.${caseInsensitive('env')}([._-][^/]*)?|${['ssh', 'aws', 'gnupg', 'git', 'codex', 'agents', 'npmrc', 'pypirc', 'netrc', 'git-credentials'].map(name => `\\.${caseInsensitive(name)}`).join('|')}|${caseInsensitive('Keychains')}|${caseInsensitive('credentials')}([^/]*)?|${caseInsensitive('secret')}[sS]?([^/]*)?|${caseInsensitive('auth')}\\.${caseInsensitive('json')}|${caseInsensitive('id')}_(rsa|ed25519|ecdsa|dsa)(\\.${caseInsensitive('pub')})?|[^/]*\\.(${['pem', 'key', 'p12', 'pfx', 'crt', 'cer', 'keystore'].map(caseInsensitive).join('|')}))(/|$)`;
  return [
    '(version 1)', '(deny default)',
    // Apple's minimal loader rules permit dyld/libignition to bootstrap native
    // binaries. They add system loader paths, not project writes or internet.
    '(import "dyld-support.sb")',
    '(allow process-exec)', '(allow process-fork)', '(allow signal (target self))',
    '(allow sysctl-read)', '(allow mach-lookup)', '(allow file-read-metadata)',
    ...['/System', '/Library', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Applications/Xcode.app', '/private/etc', '/dev'].map(root => `(allow file-read* (subpath ${quote(root)}))`),
    '(allow file-write* (literal "/dev/null") (subpath "/dev/fd"))',
    ...roots.map(root => `(allow file-read* (subpath ${quote(root.path)}))`),
    ...roots.filter(root => root.access === 'write').map(root => `(allow file-write* (subpath ${quote(root.path)}))`),
    ...roots.filter(root => root.access === 'read').map(root => {
      const writableChildren = roots.filter(child => child.access === 'write' && child.path.startsWith(`${root.path}/`));
      return writableChildren.length
        ? `(deny file-write* (require-all (subpath ${quote(root.path)}) ${writableChildren.map(child => `(require-not (subpath ${quote(child.path)}))`).join(' ')}))`
        : `(deny file-write* (subpath ${quote(root.path)}))`;
    }),
    `(allow file-read* file-write* (subpath ${quote(temporary)}))`,
    ...(privateRoot ? [
      `(deny file-read* (require-all (subpath ${quote(privateRoot)}) (require-not (subpath ${quote(temporary)})) ${skillRoots.map(root => `(require-not (subpath ${quote(root)}))`).join(' ')}))`,
      `(deny file-write* (require-all (subpath ${quote(privateRoot)}) (require-not (subpath ${quote(temporary)}))))`,
      // Protect ancestor directory renames/deletions without denying unrelated
      // siblings merely because they share a name such as .workbench.
      ...(() => {
        const ancestors: string[] = [];
        let ancestor = path.dirname(privateRoot);
        while (ancestor !== path.dirname(ancestor)) {
          if (roots.some(root => root.access === 'write' && isWithin(root.path, ancestor))) ancestors.push(ancestor);
          ancestor = path.dirname(ancestor);
        }
        return ancestors.map(root => `(deny file-write-unlink (literal ${quote(root)}))`);
      })(),
    ] : []),
    ...(metadataReadRoots.length ? [
      ...metadataReadRoots.map(root => `(allow file-read* (subpath ${quote(root)}))`),
      `(deny file-read* (require-all (regex ${quote(protectedPattern)}) ${metadataReadRoots.map(root => `(require-not (subpath ${quote(root)}))`).join(' ')}))`,
      `(deny file-write* (regex ${quote(protectedPattern)}))`,
    ] : [`(deny file-read* file-write* (regex ${quote(protectedPattern)}))`]),
    // Keychain/credential helper access stays denied; network is project-scoped.
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    ...(internet ? ['(allow network-outbound)', '(allow network-inbound (local ip "localhost:*"))'] : []),
  ].join('\n');
}
