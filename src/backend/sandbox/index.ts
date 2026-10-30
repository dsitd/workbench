import { macSandboxAvailable, sandboxProfile } from './macos';
import { linuxSandboxAvailable, prepareLinuxSandbox } from './linux';
import type { SandboxLaunch, SandboxOptions } from './types';

export const commandPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const commandLocale = process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8';
export const commandShell = process.platform === 'linux' ? '/bin/bash' : '/bin/zsh';
export const commandShellArgs = process.platform === 'linux' ? ['--noprofile', '--norc', '-c'] : ['-f', '-c'];
export { sandboxProfile } from './macos';
export type { SandboxOptions, SandboxLaunch } from './types';

export async function sandboxAvailable(): Promise<boolean> {
  if (process.platform === 'linux') return linuxSandboxAvailable();
  return process.platform === 'darwin' && await macSandboxAvailable();
}

export async function prepareSandbox(options: SandboxOptions, executable: string, args: string[]): Promise<SandboxLaunch> {
  if (process.platform === 'linux') return prepareLinuxSandbox(options, executable, args);
  if (process.platform !== 'darwin') throw new Error('No supported command sandbox is available.');
  const profile = sandboxProfile(options.roots, options.temporary, options.internet, options.privateRoot, options.skillRoots, options.metadataReadRoots)
    + (options.readFiles ?? []).map(file => `\n(allow file-read* (literal ${JSON.stringify(file)}))`).join('')
    + (options.deniedFiles ?? []).map(file => `\n(deny file-read* (literal ${JSON.stringify(file)}))`).join('')
    + (options.localhostPort ? `\n(allow network-outbound (remote ip "localhost:${options.localhostPort}"))` : '');
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, ...args], cleanup: async () => {} };
}
