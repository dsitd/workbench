import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { OperationStore } from '../src/backend/operations';
import { PrivateRecords } from '../src/backend/private-records';
import { RunStore } from '../src/backend/runs';
import { evictCheckpoints, MAX_PROJECT_CHECKPOINTS } from '../src/backend/files';
import type { RunRecord, TaskCheckpoint, ToolContext } from '../src/shared/types';

async function temporary(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-growth-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await temporary(t), folder = path.join(root, 'project'); await mkdir(folder);
  const service = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => undefined }); await service.bootstrap();
  const project = await service.createProject({ name: 'Growth', folders: [{ path: folder, access: 'write' }] });
  const session = await service.createSession(project.id, 'demo');
  return { root, folder, data: path.join(root, 'data'), service, project, session, context: { project, sessionId: session.id, signal: new AbortController().signal } as ToolContext };
}
const run = (id: string, projectId: string, sessionId: string): RunRecord => ({ id, projectId, sessionId, modelId: 'demo', status: 'completed', phase: 'final', startedAt: new Date().toISOString(), steps: 0, stepLog: [], usage: {} as RunRecord['usage'], limits: {} as RunRecord['limits'] });
const files = async (directory: string) => (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));

test('begin uses the pending index instead of listing every record, and still blocks uncertain duplicates after restart', async t => {
  const root = await temporary(t);
  const context: ToolContext = { project: { id: 'p', name: 'P', folders: [{ path: root, access: 'write' }], commandPolicy: 'ask', internet: false, instructions: '', createdAt: '', updatedAt: '' }, sessionId: 's', signal: new AbortController().signal };
  const store = new OperationStore(root, async () => true, async () => []);
  const call = { id: 'create', name: 'mcp_fixture_create', arguments: { value: 1 } };
  const done = await store.begin({ id: 'done', name: 'write_file', arguments: {} }, context); await store.finish(done.operation.id, { text: 'ok' });
  const started = await store.begin(call, context);
  const records = (store as unknown as { records: PrivateRecords<never> }).records; let listed = 0; const list = records.list.bind(records);
  records.list = async () => { listed++; return list(); };
  await assert.rejects(store.begin({ ...call, id: 'retry-before-finish' }, context), /uncertain external effect/);
  await store.finish(started.operation.id, { text: 'interrupted', error: true });
  await assert.rejects(store.begin({ ...call, id: 'retry-after-finish' }, context), /uncertain external effect/);
  assert.equal((await store.begin({ id: 'other', name: 'write_file', arguments: { x: 1 } }, context)).operation.status, 'running');
  assert.equal(listed, 0);
  // Restart without recover(): the index is rebuilt lazily once.
  const restarted = new OperationStore(root, async () => true, async () => []);
  await assert.rejects(restarted.begin({ ...call, id: 'after-restart' }, context), /uncertain external effect/);
  assert.equal((await restarted.begin({ id: 'done-again', name: 'write_file', arguments: {} }, context)).operation.status, 'running');
});

test('a corrupt record is skipped by list() and does not break begin or run listing', async t => {
  const root = await temporary(t);
  const context: ToolContext = { project: { id: 'p', name: 'P', folders: [{ path: root, access: 'write' }], commandPolicy: 'ask', internet: false, instructions: '', createdAt: '', updatedAt: '' }, sessionId: 's', signal: new AbortController().signal };
  const first = new OperationStore(root, async () => true, async () => []);
  await first.begin({ id: 'a', name: 'write_file', arguments: { v: 1 } }, context);
  await writeFile(path.join(root, 'operations', 'op_corrupt.json'), '{not json');
  const records = new PrivateRecords<{ id: string }>(path.join(root, 'operations'));
  assert.equal((await records.list()).length, 1); await assert.rejects(records.get('op_corrupt'), /Could not read/);
  const restarted = new OperationStore(root, async () => true, async () => []); await restarted.recover();
  await assert.rejects(restarted.begin({ id: 'b', name: 'write_file', arguments: { v: 1 } }, context), /uncertain external effect/);
  assert.equal((await restarted.begin({ id: 'c', name: 'write_file', arguments: { v: 2 } }, context)).operation.status, 'running');
  const runs = new RunStore(root); await runs.save(run('r1', 'p', 's'));
  await writeFile(path.join(root, 'runs', 'broken.json'), '{');
  const reopened = new RunStore(root);
  assert.deepEqual((await reopened.list('p', 's')).map(value => value.id), ['r1']);
  assert.deepEqual((await reopened.list()).map(value => value.id), ['r1']);
  await reopened.save(run('r2', 'p', 'other'));
  assert.deepEqual((await reopened.list('p', 'other')).map(value => value.id), ['r2']);
  await reopened.recover();
});

test('deleteProject prunes its operation and run records but keeps other projects', async t => {
  const { service, project, session, context, data, folder } = await workspace(t);
  const other = await service.createProject({ name: 'Other', folders: [{ path: folder, access: 'read' }] });
  const otherSession = await service.createSession(other.id, 'demo');
  await service.operations.begin({ id: 'mine', name: 'write_file', arguments: {} }, context);
  await service.operations.begin({ id: 'theirs', name: 'write_file', arguments: {} }, { ...context, project: other, sessionId: otherSession.id });
  await service.saveRun(run('run-mine', project.id, session.id)); await service.saveRun(run('run-theirs', other.id, otherSession.id));
  assert.equal((await files(path.join(data, 'operations'))).length, 2); assert.equal((await service.listRuns()).length, 2);
  await service.deleteProject(project.id);
  assert.equal((await files(path.join(data, 'operations'))).length, 1);
  assert.deepEqual(await files(path.join(data, 'runs')), ['run-theirs.json']);
  assert.deepEqual((await service.listRuns()).map(value => value.id), ['run-theirs']);
  // The pending index forgot the deleted project's operation as well.
  await assert.rejects(service.operations.begin({ id: 'theirs-retry', name: 'write_file', arguments: {} }, { ...context, project: other, sessionId: otherSession.id }), /uncertain external effect/);
});

test('evictCheckpoints drops only the oldest unreferenced, non-latest checkpoints of the project', () => {
  const point = (id: string, projectId = 'p', sessionId = 's'): TaskCheckpoint => ({ id, projectId, sessionId, title: id, createdAt: '' });
  const points = [point('a'), point('b'), point('foreign', 'q'), point('c', 'p', 't'), point('d'), point('e')];
  const kept = evictCheckpoints(points, [{ id: 'x', projectId: 'p', path: 'f', before: null, after: '', createdAt: '', checkpointId: 'a' }], 'p', 3);
  assert.deepEqual(kept.map(value => value.id), ['a', 'foreign', 'c', 'e']); // 'c' and 'e' are latest of their sessions; 'a' owns a change.
  assert.equal(evictCheckpoints(points, [], 'p', 10), points);
});

test('per-project checkpoint cap keeps writes working and preserves undo of surviving changes', async t => {
  const { service, project, session, folder } = await workspace(t);
  await service.files.write(project, 'kept.txt', 'v1', session.id);
  const original = (await service.files.checkpoints(project.id, session.id))[0].id;
  const filler = (count: number, projectId: string, prefix: string) => Array.from({ length: count }, (_, index): TaskCheckpoint => ({ id: `${prefix}-${index}`, projectId, sessionId: `${prefix}-session`, title: 'fill', createdAt: new Date(0).toISOString() }));
  // The former global limit (10 000) is reached by another project; this project must stay writable.
  await service.store.mutate(state => { state.checkpoints = [...state.checkpoints ?? [], ...filler(10_000, 'other-project', 'other'), ...filler(MAX_PROJECT_CHECKPOINTS, project.id, 'old')]; });
  const fresh = await service.createCheckpoint(project, session.id, 'Next task', 'run-next');
  const result = await service.executeTool({ id: 'w', name: 'write_file', arguments: { path: 'second.txt', content: 'two' } }, { project, sessionId: session.id, signal: new AbortController().signal, checkpointId: fresh });
  assert.equal(result.error, undefined, result.text);
  const state = await service.store.read(), own = state.checkpoints!.filter(point => point.projectId === project.id);
  assert.equal(own.length, MAX_PROJECT_CHECKPOINTS);
  assert.ok(own.some(point => point.id === original)); assert.ok(own.some(point => point.id === fresh));
  assert.equal(own.some(point => point.id === 'old-0'), false); assert.ok(own.some(point => point.id === `old-${MAX_PROJECT_CHECKPOINTS - 1}`));
  assert.equal(state.checkpoints!.filter(point => point.projectId === 'other-project').length, 10_000);
  for (const change of state.changes) assert.ok(state.checkpoints!.some(point => point.id === change.checkpointId));
  await service.revertCheckpoint(project.id, original);
  await assert.rejects(readFile(path.join(folder, 'kept.txt')), /ENOENT/);
  await service.revertCheckpoint(project.id, fresh);
  await assert.rejects(readFile(path.join(folder, 'second.txt')), /ENOENT/);
});

test('inspect_image with a path reuses an identical attachment instead of copying it again', async t => {
  const { service, folder, data, context } = await workspace(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3wAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(folder, 'shot.png'), png);
  const inspect = async (id: string) => { const result = await service.executeTool({ id, name: 'inspect_image', arguments: { path: 'shot.png' } }, context); assert.equal(result.error, undefined, result.text); return result.attachmentIds![0]; };
  const [first, second] = [await inspect('one'), await inspect('two')];
  assert.equal(first, second);
  assert.equal((await service.store.read()).attachments.length, 1);
  assert.equal((await readdir(path.join(data, 'attachments'))).length, 1);
  assert.equal(Object.hasOwn(await service.getAttachment(first), 'source'), false);
  const parallel = await Promise.all([inspect('p1'), inspect('p2')]); assert.deepEqual(parallel, [first, first]);
  // Changed bytes at the same path are a new attachment; explicit UI imports still copy.
  await writeFile(path.join(folder, 'shot.png'), Buffer.concat([png, Buffer.from([0])]));
  assert.notEqual(await inspect('three'), first);
  await service.importImages([path.join(folder, 'shot.png')]);
  assert.equal((await service.store.read()).attachments.length, 3);
});
