import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager } from '../src/backend/processes';
import { WorkspaceServices, sandboxAvailable } from '../src/backend';
import { parseTypeScriptDiagnostics } from '../src/backend/diagnostics';
import type { CommandProcess, ToolContext } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-diagnostics-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project $() `literal`');
  const compiler = path.join(projectPath, 'node_modules', 'typescript', 'bin', 'tsc');
  await mkdir(path.dirname(compiler), { recursive: true });
  await writeFile(compiler, '// A fixture compiler; not executed by unit tests.');
  const config = path.join(projectPath, "tsconfig ' literal.json");
  await writeFile(config, '{"compilerOptions":{"composite":true,"incremental":true}}');
  const services = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => {} });
  await services.bootstrap();
  const project = await services.createProject({ name: 'Fixture', folders: [{ path: projectPath, access: 'write' }] });
  const session = await services.createSession(project.id, 'demo');
  const context: ToolContext = { project, sessionId: session.id, signal: new AbortController().signal };
  const process: CommandProcess = { id: 'process', projectId: project.id, sessionId: session.id, command: '', cwd: projectPath, background: false, status: 'completed', output: 'Exit 0\n', startedAt: '', exitCode: 0 };
  return { root, projectPath, compiler, config, services, context, process };
}
const diagnosticsCall = (arguments_: Record<string, unknown>) => ({ id: 'diagnostics', name: 'typescript_diagnostics', arguments: arguments_ });

test('TypeScript output becomes diagnostics with locations, multiline details and global errors', () => {
  const result = parseTypeScriptDiagnostics('Exit 2\nsrc/a(file).ts(3,8): error TS2322: Type string is not assignable.\n  Additional detail.\nerror TS18003: No inputs.\n', '/project');
  assert.deepEqual(result, [
    { file: '/project/src/a(file).ts', line: 3, column: 8, code: 'TS2322', severity: 'error', message: 'Type string is not assignable.\n  Additional detail.' },
    { code: 'TS18003', severity: 'error', message: 'No inputs.' },
  ]);
});

test('diagnostics use the local sandboxed compiler, quote paths literally and confine incremental metadata to scratch', async t => {
  const f = await fixture(t); let launched = 0;
  f.services.commands.runDetailed = async (context, command, cwd, timeout) => {
    launched++; assert.equal(context.sessionId, f.context.sessionId); assert.equal(cwd, f.projectPath); assert.equal(timeout, 1200);
    assert.ok(command.startsWith(`node '${f.compiler}'`));
    assert.ok(command.includes(`--project '${f.config.replace(/'/g, `'"'"'`)}'`));
    assert.match(command, /--noEmit --incremental true --tsBuildInfoFile "\$TMPDIR\/typescript-diagnostics\.tsbuildinfo" --pretty false$/);
    assert.doesNotMatch(command, /--composite|--declaration/);
    assert.doesNotMatch(command, /npx|npm|tsc --build/);
    return { ...f.process, status: 'failed', exitCode: 2, output: 'Exit 2\nsrc/a.ts(4,2): error TS2304: Cannot find name missing.\nsrc/b.ts(1,1): error TS2322: Wrong type.\n' };
  };
  const result = await f.services.executeTool(diagnosticsCall({ path: f.config, timeoutMs: 1200, maxDiagnostics: 1 }), f.context);
  assert.equal(launched, 1); assert.equal(result.error, undefined);
  const report = JSON.parse(result.text);
  assert.equal(report.status, 'diagnostics'); assert.equal(report.configPath, f.config); assert.equal(report.total, 2); assert.equal(report.truncated, true);
  assert.deepEqual(report.diagnostics, [{ file: path.join(f.projectPath, 'src/a.ts'), line: 4, column: 2, code: 'TS2304', severity: 'error', message: 'Cannot find name missing.' }]);
});

test('diagnostics reject unsafe paths, compiler symlink escapes, Plan calls and invalid limits before launching', async t => {
  const f = await fixture(t); let launched = 0;
  f.services.commands.runDetailed = async () => { launched++; return f.process; };
  for (const args of [{ path: path.join(f.root, 'outside.json') }, { path: '.env' }, { path: f.config, timeoutMs: 120001 }, { path: f.config, maxDiagnostics: 0 }]) {
    const result = await f.services.executeTool(diagnosticsCall(args), f.context); assert.equal(result.error, true);
  }
  await f.services.updateSession(f.context.sessionId, { mode: 'plan' });
  const plan = await f.services.executeTool(diagnosticsCall({ path: f.config }), f.context); assert.equal(plan.error, true); assert.match(plan.text, /Plan mode/);
  await f.services.updateSession(f.context.sessionId, { mode: 'auto-edit' });
  const outside = path.join(f.root, 'outside-tsc'); await writeFile(outside, ''); await rm(f.compiler); await symlink(outside, f.compiler);
  const escape = await f.services.executeTool(diagnosticsCall({ path: f.config }), f.context); assert.equal(escape.error, true); assert.match(escape.text, /Symbolic link/);
  assert.equal(launched, 0);
});

test('diagnostics report empty success, execution failures, stops and output truncation distinctly', async t => {
  const f = await fixture(t);
  for (const [process, expectedStatus, error] of [
    [f.process, 'passed', undefined],
    [{ ...f.process, status: 'failed', exitCode: 127, output: 'Exit 127\nnode: command not found\n' }, 'failed', true],
    [{ ...f.process, status: 'stopped', output: 'Cancelled\n' }, 'stopped', true],
    [{ ...f.process, status: 'failed', exitCode: 2, output: 'Timed out\nsrc.ts(1,1): error TS2322: Wrong type.\n' }, 'failed', true],
    [{ ...f.process, output: 'Exit 0\n[Output truncated at 100000 characters]' }, 'failed', true],
  ] as const) {
    f.services.commands.runDetailed = async () => process as CommandProcess;
    const result = await f.services.executeTool(diagnosticsCall({ path: f.config }), f.context);
    assert.equal(JSON.parse(result.text).status, expectedStatus); assert.equal(result.error, error);
  }
  f.services.commands.runDetailed = async () => { throw new Error('The macOS command sandbox is unavailable.'); };
  const unavailable = await f.services.executeTool(diagnosticsCall({ path: f.config }), f.context);
  assert.equal(unavailable.error, true); assert.match(unavailable.text, /sandbox is unavailable/);
});

test('missing compiler does not invoke an installer or attempt a command', async t => {
  const f = await fixture(t); await rm(f.compiler);
  let launched = false; f.services.commands.runDetailed = async () => { launched = true; return f.process; };
  const result = await f.services.executeTool(diagnosticsCall({ path: f.config }), f.context);
  assert.equal(result.error, true); assert.match(result.text, /local TypeScript compiler was not found/); assert.equal(launched, false);
});

test('local composite compiler fixture preserves implied declarations and writes metadata only to disposable scratch', async t => {
  const f = await fixture(t);
  await rm(path.join(f.projectPath, 'node_modules'), { recursive: true });
  const dependencyRoot = await realpath(path.join(process.cwd(), 'node_modules', 'typescript'));
  await mkdir(path.join(f.projectPath, 'node_modules'));
  await symlink(dependencyRoot, path.join(f.projectPath, 'node_modules', 'typescript'));
  const project = await f.services.saveProject({ ...f.context.project, folders: [...f.context.project.folders, { path: dependencyRoot, access: 'read' }] });
  const scratch = path.join(f.root, 'scratch'); await mkdir(scratch);
  const manager = new ProcessManager(() => {}, value => value);
  t.after(() => manager.close());
  // This fixture executes only the installed compiler over disposable files. It tests CLI semantics;
  // production sandbox isolation is exercised by the separate acceptance test below.
  f.services.commands.runDetailed = async (context, command, cwd, timeout) => manager.start({
    projectId: project.id, sessionId: context.sessionId, command, cwd: cwd!, background: false,
    executable: '/bin/sh', args: ['-c', command],
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: scratch, HOME: scratch },
    timeoutMs: timeout!, signal: context.signal, cleanup: async () => {},
  }).completion;
  await writeFile(f.config, JSON.stringify({ compilerOptions: { composite: true, declarationMap: true, outDir: 'generated',
    tsBuildInfoFile: './metadata/forbidden.tsbuildinfo' }, include: ['src.ts'] }));
  const source = path.join(f.projectPath, 'src.ts');
  await writeFile(source, 'export const value: string = 1;');
  const invalid = await f.services.executeTool(diagnosticsCall({ path: f.config }), { ...f.context, project });
  assert.equal(invalid.error, undefined); const errors = JSON.parse(invalid.text);
  assert.equal(errors.status, 'diagnostics'); assert.ok(errors.diagnostics.some((item: { code: string }) => item.code === 'TS2322'));
  assert.equal(errors.diagnostics.some((item: { code: string }) => item.code === 'TS5069'), false);
  await writeFile(source, 'export const value: string = "valid";');
  const valid = await f.services.executeTool(diagnosticsCall({ path: f.config }), { ...f.context, project });
  assert.equal(valid.error, undefined); assert.equal(JSON.parse(valid.text).status, 'passed');
  const entries = await f.services.files.list(project, f.projectPath);
  assert.equal(entries.some(entry => ['generated', 'metadata'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')), false);
  assert.equal((await f.services.files.list({ ...project, folders: [...project.folders, { path: scratch, access: 'read' }] }, scratch)).some(entry => entry.name === 'typescript-diagnostics.tsbuildinfo'), true);
});

test('real sandboxed TypeScript diagnostics cannot create project output files', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run in ordinary macOS Terminal for real sandboxed compiler acceptance.'); return; }
  const f = await fixture(t);
  await rm(path.join(f.projectPath, 'node_modules'), { recursive: true });
  const dependencyRoot = await realpath(path.join(process.cwd(), 'node_modules', 'typescript'));
  await mkdir(path.join(f.projectPath, 'node_modules'));
  await symlink(dependencyRoot, path.join(f.projectPath, 'node_modules', 'typescript'));
  const project = await f.services.saveProject({ ...f.context.project, folders: [...f.context.project.folders, { path: dependencyRoot, access: 'read' }] });
  await writeFile(f.config, '{"compilerOptions":{"composite":true,"incremental":true,"declaration":true,"outDir":"generated"},"include":["src.ts"]}');
  await writeFile(path.join(f.projectPath, 'src.ts'), 'const value: string = 1;');
  const result = await f.services.executeTool(diagnosticsCall({ path: f.config }), { ...f.context, project });
  assert.equal(result.error, undefined); const report = JSON.parse(result.text); assert.equal(report.status, 'diagnostics'); assert.ok(report.diagnostics.some((item: { code: string }) => item.code === 'TS2322'));
  const entries = await f.services.files.list(project, f.projectPath);
  assert.equal(entries.some(entry => entry.name === 'generated' || entry.name.endsWith('.tsbuildinfo')), false);
});
