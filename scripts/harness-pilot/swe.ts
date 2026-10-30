import { promises as fs } from 'node:fs';
import path from 'node:path';
import { benchmarkSandbox } from './isolated-process';
import { benchmarkTemp, option, shellQuote } from './platform';

export const sweRuntime = path.resolve(option('--swe-runtime') ?? path.join(benchmarkTemp, 'workbench-swe-runtime'));
export const swePython = `${sweRuntime}/venv/bin/python`;
export const sweReadRoots = [`${sweRuntime}/python`, `${sweRuntime}/venv`];
export interface SweCase { testFiles: string[]; failToPass: string[]; passToPass: string[]; developmentTests?: string[] }
type Execute = (exe: string, args: string[], cwd: string, env: Record<string, string>, timeout?: number) => Promise<{ code: number | null; output: string }>;
export function sweCommand(task: SweCase): string {
  if (task.testFiles.some(file => !/^sympy\/[a-zA-Z0-9_/]+\.py$/.test(file) || !file.includes('/tests/'))) throw new Error('Unsafe SWE test path');
  return `${shellQuote(swePython)} -B .bench_verify.py`;
}
export async function swePrepareDevelopment(project: string, task: SweCase) {
  sweCommand(task);
  task = { ...task, passToPass: task.developmentTests ?? task.passToPass };
  if (!task.passToPass.length || task.passToPass.some(name => !/^test_\w+$/.test(name) || task.failToPass.includes(name))) throw new Error('Invalid development test selection');
  // Only public baseline tests and PASS_TO_PASS names enter the agent workspace.
  // The original FAIL_TO_PASS assertions can require precisely the behavior the issue changes.
  await fs.writeFile(path.join(project, '.bench_verify.py'), `import sys\nimport sympy\nfrom sympy.utilities.runtests import SymPyTests\nselected = set(${JSON.stringify(task.passToPass)})\nseen = set()\ndef matches(self, function):\n    name = function.__name__\n    if name in selected:\n        seen.add(name)\n        return True\n    return False\nSymPyTests.matches = matches\npassed = sympy.test(*${JSON.stringify(task.testFiles)}, verbose=True, subprocess=False)\nmissing = selected - seen\nif missing:\n    print('Missing development tests:', sorted(missing))\nsys.exit(0 if passed and not missing else 1)\n`);
}
export function sweImplementation(file: string): boolean {
  return /^sympy\/[a-zA-Z0-9_/]+\.py$/.test(file) && !file.split('/').some(part => part === 'tests' || part.startsWith('test_') || part === 'conftest.py');
}
export function sweResults(output: string): Record<string, string> {
  return Object.fromEntries([...output.matchAll(/^(test_\S+)\s+(ok|F|E|X|s|f)(?:\s|$)/gm)].map(match => [match[1], match[2]]));
}
export async function sweGrade(source: string, project: string, location: string, before: Record<string,string>, after: Record<string,string>, task: SweCase, testPatch: string, execute: Execute) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  const unexpected = changed.filter(file => !sweImplementation(file));
  await fs.cp(source, location, { recursive: true });
  for (const file of changed.filter(sweImplementation)) {
    if (!after[file]) { await fs.rm(path.join(location, file), { force: true }); continue; }
    const candidate = path.join(project, file), entry = await fs.lstat(candidate);
    if (!entry.isFile() || entry.isSymbolicLink() || !(await fs.realpath(candidate)).startsWith(await fs.realpath(project) + path.sep))
      throw new Error('SWE solution is not a scoped regular file');
    await fs.mkdir(path.dirname(path.join(location,file)), { recursive: true });
    await fs.copyFile(candidate, path.join(location,file));
  }
  const patch = await fs.readFile(testPatch, 'utf8');
  const patchedPaths = patch.split('\n').filter(line => /^(---|\+\+\+) [ab]\//.test(line)).map(line => line.slice(6));
  if (!patchedPaths.length || patchedPaths.some(file => !task.testFiles.includes(file))) throw new Error('Test patch escaped its frozen test files');
  const applied = await execute('/usr/bin/patch', ['--batch', '-p1', '-i', testPatch], location, { PATH: '/usr/bin:/bin' });
  if (applied.code !== 0) throw new Error('Cannot apply frozen SWE test patch');
  const scratch = path.join(location, '.scratch'); await fs.mkdir(scratch);
  const sandbox = await benchmarkSandbox({ roots: [{ path: location, access: 'write' }, ...sweReadRoots.map(path => ({ path, access: 'read' as const }))], temporary: scratch, internet: false }, swePython, ['-B', 'bin/test', '-v', ...task.testFiles]);
  let result;
  try { result = await execute(sandbox.executable, sandbox.args, location,
    { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, 120_000); }
  finally { await sandbox.cleanup(); }
  const tests = sweResults(result.output), required = [...task.failToPass, ...task.passToPass];
  const missingRequired = required.filter(name => tests[name] !== 'ok');
  return { ...result, passed: result.code === 0 && unexpected.length === 0 && missingRequired.length === 0,
    unexpected, changed, requiredTests: required.length, missingRequired, testResults: tests };
}
