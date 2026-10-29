import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileService, fileVersion, readTextFile } from '../src/backend/files';
import { ProjectIndexService } from '../src/backend/project-index';
import { projectContext } from '../src/backend/project-context';
import { StateStore } from '../src/backend/storage';
import type { Project } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-context-index-')));
  const privateRoot = path.join(root, 'app-state'); await mkdir(privateRoot);
  const files = new FileService(new StateStore(privateRoot), () => {});
  const project: Project = { id: 'fixture', name: 'Synthetic map', folders: [{ path: root, access: 'write' }], internet: false, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' };
  const reads: string[] = [];
  const index = new ProjectIndexService(files, async (file, limit) => { reads.push(file); return readTextFile(file, limit); });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, privateRoot, files, project, index, reads };
}
const signal = () => new AbortController().signal;

test('unchanged symbols are reused while an external same-size replacement refreshes the index', async t => {
  const { root, project, index, reads } = await fixture(t);
  const source = path.join(root, 'source.ts');
  await writeFile(source, 'export class First {}');
  assert.deepEqual((await index.build(project)).files[0].symbols, ['First']);
  assert.deepEqual((await index.build(project)).files[0].symbols, ['First']);
  assert.deepEqual(reads, [source]);
  const replacement = path.join(root, 'replacement.tmp');
  await writeFile(replacement, 'export class Later {}'); await rename(replacement, source);
  assert.deepEqual((await index.build(project)).files[0].symbols, ['Later']);
  assert.deepEqual(reads, [source, source]);
  await rm(source);
  assert.equal((await index.build(project)).files.length, 0);
});

test('cached symbols and active-path hints do not grant access after project scope changes', async t => {
  const { root, privateRoot, project, index, reads } = await fixture(t);
  const oldSource = path.join(root, 'source.ts'), allowed = path.join(root, 'allowed');
  await mkdir(allowed); await writeFile(oldSource, 'export class Scoped {}');
  await index.build(project);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-map-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'escape.ts'), 'export class Escape {}');
  await symlink(path.join(outside, 'escape.ts'), path.join(allowed, 'escape.ts'));
  await writeFile(path.join(privateRoot, 'private.ts'), 'export class Private {}');
  await writeFile(path.join(allowed, '.env'), 'PLACEHOLDER=not-a-real-secret');
  const scoped = { ...project, folders: [{ path: allowed, access: 'read' as const }] };
  const map = await index.build(scoped, [oldSource, path.join(privateRoot, 'private.ts'), 'escape.ts', '.env']);
  assert.deepEqual(map.files, []);
  assert.deepEqual(reads, [oldSource]);
  assert.equal((await index.build(project)).files.find(file => file.path === oldSource)!.symbols[0], 'Scoped');
  assert.deepEqual(reads, [oldSource, oldSource]);
});

test('an active permitted source is included even when the bounded scan omitted it', async t => {
  const { root, files, project, reads } = await fixture(t);
  const active = path.join(root, 'active.ts'); await writeFile(active, 'export function CurrentTask() {}');
  const original = files.walkDetailed.bind(files);
  files.walkDetailed = async () => ({ files: [], truncated: true });
  const index = new ProjectIndexService(files, async (file, limit) => { reads.push(file); return readTextFile(file, limit); });
  const map = await index.build(project, ['active.ts']);
  files.walkDetailed = original;
  assert.equal(map.truncated, true);
  assert.deepEqual(map.files.map(file => file.path), [active]);
  assert.deepEqual(map.files[0].symbols, ['CurrentTask']);
});

test('zero-match queries produce an empty map while symbols and recent paths select relevant files', async t => {
  const { root, files, project, index } = await fixture(t);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'README.md'), '# Synthetic fixture');
  await writeFile(path.join(root, 'src/api.ts'), 'export function LoadCustomer() {}');
  await writeFile(path.join(root, 'src/other.ts'), 'export class Unrelated {}');
  await writeFile(path.join(root, 'docs/guide.md'), 'Guide');
  assert.deepEqual((await projectContext(files, index, project, 'zzzzzz unmatched', signal())).map!.files, []);
  const symbols = await projectContext(files, index, project, 'LoadCustomer', signal());
  assert.deepEqual(symbols.map!.files.map(file => file.relativePath), ['src/api.ts']);
  const active = await projectContext(files, index, project, 'zzzzzz unmatched', signal(), undefined, ['src/api.ts']);
  assert.deepEqual(active.map!.files.map(file => file.relativePath), ['src/api.ts']);
  const directory = await projectContext(files, index, project, 'zzzzzz unmatched', signal(), undefined, ['docs']);
  assert.deepEqual(directory.map!.files.map(file => file.relativePath), ['docs/guide.md']);
  const rootCwd = await projectContext(files, index, project, 'zzzzzz unmatched', signal(), undefined, [root]);
  assert.deepEqual(rootCwd.map!.files, []);
  const overview = await projectContext(files, index, project, 'Explain project structure', signal());
  assert.ok(overview.map!.files.some(file => file.relativePath === 'README.md'));
  assert.ok(!overview.map!.files.some(file => file.relativePath === 'src/other.ts'));
});

test('canonical duplicate pins collapse and every request reports the current file version', async t => {
  const { root, files, project, index } = await fixture(t);
  const source = path.join(root, 'api.ts'); await writeFile(source, 'first\nsecond\nthird');
  const pinned = { ...project, pins: [{ id: 'pin', path: 'api.ts', startLine: 2, endLine: 2 }] };
  const first = await projectContext(files, index, pinned, `@file:"${source}#L2"`, signal());
  assert.equal(first.pins.length, 1);
  assert.equal(first.pins[0].content, 'second');
  assert.match(first.pins[0].source, new RegExp(fileVersion('first\nsecond\nthird')));
  await writeFile(source, 'first\nchanged\nthird');
  const second = await projectContext(files, index, pinned, 'inspect api', signal());
  assert.equal(second.pins[0].content, 'changed');
  assert.notEqual(second.pins[0].source, first.pins[0].source);
});

test('explicit protected references still fail before any index source read', async t => {
  const { root, files, project, index, reads } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'PLACEHOLDER=not-a-real-secret');
  await assert.rejects(projectContext(files, index, project, '@file:.env', signal()), /credential or protected/);
  assert.deepEqual(reads, []);
});
