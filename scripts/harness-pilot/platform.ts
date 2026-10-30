import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { commandPath } from '../../src/backend/sandbox';

export function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function executable(name: string, override?: string): string {
  const candidates = override ? [path.resolve(override)] : (process.env.PATH ?? commandPath).split(path.delimiter).map(dir => path.join(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* next */ }
  }
  throw new Error(`Install ${name} or pass --${name === 'python3' ? 'python' : name} /absolute/path`);
}

export const benchmarkTemp = realpathSync(process.platform === 'darwin' ? '/private/tmp' : '/tmp');
export const nodeExecutable = executable('node', option('--node') ?? (process.versions.electron ? undefined : process.execPath));
export const pythonExecutable = executable('python3', option('--python'));
export const piDependencies = path.resolve(option('--pi-dir') ?? path.join(benchmarkTemp, 'workbench-pilot-public-pi-1.1.0'));
export const benchmarkPath = [...new Set([path.dirname(nodeExecutable), path.dirname(pythonExecutable), ...commandPath.split(':')])].join(':');
export const runtimeRoots = [...new Set([nodeExecutable, pythonExecutable].map(file => path.dirname(path.dirname(file))))]
  .filter(root => !['/', '/usr', '/usr/local'].includes(root) && !(process.platform === 'darwin' && ['/opt/homebrew/', '/Library/', '/System/'].some(prefix => root.startsWith(prefix)))).map(path => ({ path, access: 'read' as const }));
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;

export async function ready(): Promise<void> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) throw new Error('Benchmarks require Node.js 22.12 or newer.');
  if (process.versions.electron) {
    const { app } = await import('electron');
    app.setName('Workbench');
    await app.whenReady();
  }
}

/** Resolves inside the parent gateway only. Never prints or forwards credentials to children. */
export async function credentialResolver(dry: boolean): Promise<() => Promise<string | undefined>> {
  if (dry) return async () => undefined;
  const variable = option('--credential-env');
  if (variable) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new Error('Invalid credential environment variable name');
    return async () => process.env[variable];
  }
  if (!process.versions.electron) throw new Error('For a live Node benchmark pass --credential-env VARIABLE_NAME, or run the bundle with Electron to use the Workbench vault.');
  const { app } = await import('electron');
  const { CredentialVault } = await import('../../src/main/credentials');
  const vault = new CredentialVault(app.getPath('userData'));
  await vault.initialize();
  return () => vault.resolve({ id: 'openrouter-claude-sonnet-55', apiKeyEnv: '' } as any);
}

export async function finish(code: number): Promise<void> {
  if (process.versions.electron) (await import('electron')).app.exit(code);
  else process.exitCode = code;
}
