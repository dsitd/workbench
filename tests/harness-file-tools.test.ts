import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { applyTextEdits } from '../src/backend/batch-edit';
import { ripgrepSearch } from '../src/backend/ripgrep-search';
import { appSettings } from '../src/backend/settings';
import { defaultAppSettings } from '../src/shared/runs';
import { normalizeToolArguments, nativeStrictSchema } from '../src/shared/tool-schema';
import { toolDefinitions } from '../src/backend/tools';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'); await mkdir(directory);
  const host = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => {} }); await host.bootstrap();
  const project = await host.createProject({ name: 'Fixture', folders: [{ path: directory, access: 'write' }] });
  const session = await host.createSession(project.id, 'demo');
  const context = { project, sessionId: session.id, signal: new AbortController().signal };
  const call = (name: string, args: Record<string, unknown>) => host.executeTool({ id: 'fixture', name, arguments: args }, context);
  return { root, directory, host, context, call, project, session };
}

test('batch replacements all match original content; literals, deletions, adjacent replacements', () => {
  assert.equal(applyTextEdits('alpha beta', [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: '$&' }]), 'beta $&');
  assert.equal(applyTextEdits('abc', [{ oldText: 'ab', newText: '' }, { oldText: 'c', newText: 'd' }]), 'd');
  assert.throws(() => applyTextEdits('abc', [{ oldText: 'ab', newText: 'x' }, { oldText: 'bc', newText: 'y' }]), /overlap/);
  assert.throws(() => applyTextEdits('aa', [{ oldText: 'a', newText: 'b' }]), /more than once/);
  assert.throws(() => applyTextEdits('a', [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }]), /not found/);
  assert.equal(applyTextEdits('a a', [{ oldText: 'a', newText: 'b', replaceAll: true }]), 'b b');
});

test('batch edit is atomic, creates one snapshot, and enforces read/version/argument gates', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'code.txt'); await writeFile(file, 'alpha beta');
  const args = { path: 'code.txt', edits: [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: 'gamma' }] };
  assert.equal((await f.call('edit_file', args)).error, true);
  await f.call('read_file', { path: 'code.txt' });
  assert.equal((await f.call('edit_file', { ...args, oldText: 'alpha', newText: 'x' })).error, true);
  assert.equal((await f.call('edit_file', { path: 'code.txt', edits: [...args.edits, { oldText: 'missing', newText: 'z' }] })).error, true);
  assert.equal(await readFile(file, 'utf8'), 'alpha beta'); assert.equal((await f.host.files.changes(f.project.id)).length, 0);
  assert.equal((await f.call('edit_file', args)).error, undefined);
  assert.equal(await readFile(file, 'utf8'), 'beta gamma'); assert.equal((await f.host.files.changes(f.project.id)).length, 1);
  await writeFile(file, 'external');
  assert.equal((await f.call('edit_file', { path: 'code.txt', edits: [{ oldText: 'external', newText: 'lost' }] })).error, true);
  assert.equal(await readFile(file, 'utf8'), 'external');
});

test('batch edits keep native strict optional-null normalization', () => {
  const definition = toolDefinitions.find(tool => tool.name === 'edit_file')!;
  assert.ok(nativeStrictSchema('https://api.openai.com/v1', definition));
  assert.deepEqual(normalizeToolArguments(definition, { path: 'a', oldText: null, newText: null, replaceAll: null, edits: [{ oldText: 'a', newText: 'b', replaceAll: null }] }), { path: 'a', edits: [{ oldText: 'a', newText: 'b' }] });
});

test('ripgrep regex, literal, case, glob, context and invalid patterns use real bundled binary', async t => {
  const f = await fixture(t); await mkdir(path.join(f.directory, 'src'));
  await writeFile(path.join(f.directory, 'src', 'a.ts'), 'before\nAlpha42\nalpha43\na.*b\nafter\n');
  await writeFile(path.join(f.directory, 'src', 'b.py'), 'Alpha99');
  const search = (args: Record<string, unknown>) => f.call('search_files', args);
  const result = await search({ query: '^Alpha[0-9]+$', regex: true, ignoreCase: false, glob: '**/*.ts', contextLines: 1 });
  assert.equal(result.error, undefined, result.text); assert.match(result.text, /a.ts:2: Alpha42/); assert.match(result.text, /a.ts-1- before/); assert.doesNotMatch(result.text, /Alpha99|a.ts:3:/);
  assert.match((await search({ query: 'alpha', ignoreCase: false })).text, /alpha43/);
  assert.doesNotMatch((await search({ query: 'alpha', ignoreCase: false })).text, /Alpha42/);
  assert.match((await search({ query: 'a.*b', regex: false })).text, /a\.\*b/);
  assert.doesNotMatch((await search({ query: 'Alpha', glob: '!**/*.py' })).text, /Alpha99/);
  assert.match((await search({ query: 'Alpha', glob: '/src/*.ts' })).text, /Alpha42/);
  assert.equal((await search({ query: '[', regex: true })).error, true);
  const limited = await search({ query: 'alpha', regex: true, maxResults: 1 }); assert.match(limited.text, /limit reached/);
});

test('rich search cannot traverse secrets, private state, escaping symlinks, binaries and preserves nested read-only access', async t => {
  const f = await fixture(t); await writeFile(path.join(f.directory, 'ok.txt'), 'needle');
  await writeFile(path.join(f.directory, '.env'), 'ARTIFICIAL_FIXTURE=needle');
  await writeFile(path.join(f.root, 'outside.txt'), 'outside needle');
  await symlink(path.join(f.root, 'outside.txt'), path.join(f.directory, 'escape.txt'));
  await symlink(path.join(f.root, 'state'), path.join(f.directory, 'state'));
  await writeFile(path.join(f.directory, 'binary.bin'), Buffer.from('needle\0'));
  const denied = path.join(f.directory, 'denied'); await mkdir(denied); await writeFile(path.join(denied, 'hidden.txt'), 'denied needle');
  f.context.project = await f.host.saveProject({ ...f.project, folders: [...f.project.folders, { path: denied, access: 'read' }] });
  const result = await f.call('search_files', { query: 'needle', regex: true, glob: '**/*' });
  assert.equal(result.error, undefined, result.text); assert.match(result.text, /ok.txt/);
  assert.doesNotMatch(result.text, /ARTIFICIAL|outside|escape|binary|state\//);
  assert.match(result.text, /hidden.txt/);
  await f.call('read_file', { path: 'denied/hidden.txt' });
  assert.equal((await f.call('edit_file', { path: 'denied/hidden.txt', edits: [{ oldText: 'needle', newText: 'changed' }] })).error, true);
  assert.equal((await f.call('search_files', { path: '../outside.txt', query: 'needle', regex: true })).error, true);
});

test('rich search checks cancellation and handles filenames as data', async t => {
  const f = await fixture(t); const file = path.join(f.directory, '- odd name.ts'); await writeFile(file, 'foo');
  assert.match((await f.call('search_files', { query: 'foo', regex: true })).text, /- odd name.ts:1:/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ripgrepSearch([file], [f.directory], 'foo', 2, 0, { signal: controller.signal }, async () => 'foo'));
});

test('execution settings round-trip and reject invalid modes', () => {
  const settings = appSettings({ ...defaultAppSettings, toolExecution: 'sequential', completionPolicy: 'natural', modelCompaction: false });
  assert.equal(settings.toolExecution, 'sequential'); assert.equal(settings.completionPolicy, 'natural'); assert.equal(settings.modelCompaction, false);
  for (const patch of [{ toolExecution: 'all' }, { completionPolicy: 'skip' }, { modelCompaction: 'yes' }]) assert.throws(() => appSettings({ ...defaultAppSettings, ...patch } as any));
});
