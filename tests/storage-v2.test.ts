import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { RunStore } from '../src/backend/runs';
import { backupName } from '../src/backend/storage';
import type { ChatMessage, FileChange, RunRecord, Session, TaskCheckpoint } from '../src/shared/types';

const callbacks = { approve: async () => true, emit: () => undefined };
const version = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const message = (id: string, content = id): ChatMessage => ({ id, role: 'user', content, createdAt: '2026-10-01T10:00:00.000Z' });
const exists = (file: string) => stat(file).then(() => true, () => false);
async function temporary(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-storage-v2-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

/** A workspace.json exactly as layout v1 stored it: all chats and full change snapshots inline. */
async function legacy(t: { after(callback: () => Promise<void>): void }) {
  const root = await temporary(t), folder = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(folder); await mkdir(data, { mode: 0o700 });
  const at = '2026-10-01T10:00:00.000Z', projectId = 'legacy-project';
  const session = (id: string, title: string): Session => ({ id, projectId, title, modelId: 'demo', status: 'idle', summary: '', mode: 'ask', reasoningEffort: 'auto', titleSource: 'manual', createdAt: at, updatedAt: at });
  const scope = JSON.stringify({ folders: [folder] });
  const messages: Record<string, ChatMessage[]> = {
    'chat-a': [
      { ...message('a1', 'Fix the bug'), accessScope: scope },
      { id: 'a2', role: 'assistant', content: '', createdAt: at, toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'a.txt', content: 'two\n' } }], accessScope: scope },
      { id: 'a3', role: 'tool', content: 'Wrote a.txt', toolCallId: 'call-1', toolName: 'write_file', createdAt: at, accessScope: scope },
      { id: 'a4', role: 'assistant', content: 'Готово:\nстрока   "кавычки" \\ конец', createdAt: at, accessScope: scope },
    ],
    'chat-b': [{ ...message('b1', 'Other chat'), accessScope: scope }],
    'deleted-chat': [message('ghost')],
  };
  const changes: FileChange[] = [
    { id: 'change-a', projectId, path: path.join(folder, 'a.txt'), before: 'one\n', after: 'two\n', createdAt: at, sessionId: 'chat-a', checkpointId: 'cp-1', beforeVersion: version('one\n'), afterVersion: version('two\n') } as FileChange,
    { id: 'change-b', projectId, path: path.join(folder, 'b.txt'), before: null, after: 'created', createdAt: at, sessionId: 'chat-a', checkpointId: 'cp-1', beforeVersion: null, afterVersion: version('created') } as FileChange,
    { id: 'change-c', projectId, path: path.join(folder, 'c.txt'), before: 'old', after: 'current', createdAt: at, sessionId: 'chat-b' },
  ];
  const checkpoints: TaskCheckpoint[] = [{ id: 'cp-1', projectId, sessionId: 'chat-a', title: 'Task', createdAt: at }];
  const state = {
    version: 1, projects: [{ id: projectId, name: 'Legacy', folders: [{ path: folder, access: 'write' }], internet: false, commandPolicy: 'ask', instructions: '', createdAt: at, updatedAt: at }],
    sessions: [session('chat-a', 'A'), session('chat-b', 'B'), session('chat-empty', 'Empty')],
    models: [{ id: 'demo', name: 'Demo', kind: 'demo', baseUrl: '', model: 'local-demo', apiKeyEnv: '', contextWindow: 32000, maxOutputTokens: 4000, vision: false, enabled: true }],
    modelPresetsInitialized: true, modelPresetsRevision: 2, flashDefaultInitialized: true, skills: [], mcpServers: [], attachments: [],
    messages, changes, runs: [], checkpoints, settings: undefined,
  };
  const original = JSON.stringify(state, null, 2);
  await writeFile(path.join(data, 'workspace.json'), original, { mode: 0o600 });
  await Promise.all([writeFile(path.join(folder, 'a.txt'), 'two\n'), writeFile(path.join(folder, 'b.txt'), 'created'), writeFile(path.join(folder, 'c.txt'), 'current')]);
  return { root, folder, data, projectId, original, messages, changes, sessions: state.sessions };
}

async function expectMigrated(service: WorkspaceServices, fixture: Awaited<ReturnType<typeof legacy>>) {
  const { data, projectId, original, messages, changes, sessions } = fixture;
  for (const id of ['chat-a', 'chat-b']) assert.deepEqual(await service.getMessages(id), messages[id]);
  assert.deepEqual(await service.getMessages('chat-empty'), []);
  assert.deepEqual(await service.getChanges(projectId), [...changes].reverse());
  assert.deepEqual((await service.listSessions(projectId)).sort((a, b) => a.id.localeCompare(b.id)), sessions);
  assert.deepEqual((await service.listCheckpoints(projectId)).map(point => point.id), ['cp-1']);
  const stored = await readFile(path.join(data, 'workspace.json'), 'utf8'), parsed = JSON.parse(stored);
  assert.equal(parsed.version, 2); assert.equal(Object.hasOwn(parsed, 'messages'), false); assert.ok(!stored.includes('\n'));
  for (const change of parsed.changes) assert.ok(!Object.hasOwn(change, 'before') && !Object.hasOwn(change, 'after'));
  assert.ok(!stored.includes('Fix the bug') && !stored.includes('created"'));
  assert.equal(await readFile(path.join(data, backupName), 'utf8'), original);
  assert.deepEqual((await readdir(path.join(data, 'messages'))).sort(), ['chat-a.jsonl', 'chat-b.jsonl']);
  assert.deepEqual((await readdir(path.join(data, 'changes'))).sort(), ['change-a.json', 'change-b.json', 'change-c.json']);
  for (const file of [backupName, 'messages/chat-a.jsonl', 'changes/change-a.json']) assert.equal((await stat(path.join(data, file))).mode & 0o077, 0);
}

test('v1 workspace migrates to v2 with a backup and identical history, changes and undo', async t => {
  const fixture = await legacy(t);
  const service = new WorkspaceServices(fixture.data, callbacks); await service.bootstrap();
  await expectMigrated(service, fixture);
  // The deleted chat's history is not migrated but remains in the untouched backup.
  assert.match(await readFile(path.join(fixture.data, backupName), 'utf8'), /ghost/);
  const reopened = new WorkspaceServices(fixture.data, callbacks); await reopened.bootstrap();
  await expectMigrated(reopened, fixture);
  await reopened.revertChange(fixture.projectId, 'change-c');
  assert.equal(await readFile(path.join(fixture.folder, 'c.txt'), 'utf8'), 'old');
  await reopened.revertCheckpoint(fixture.projectId, 'cp-1');
  assert.equal(await readFile(path.join(fixture.folder, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await exists(path.join(fixture.folder, 'b.txt')), false);
  assert.deepEqual(await reopened.getChanges(fixture.projectId), []);
  assert.deepEqual(await readdir(path.join(fixture.data, 'changes')), []);
  await reopened.appendMessage('chat-a', message('a5', 'After migration'));
  assert.deepEqual((await new WorkspaceServices(fixture.data, callbacks).getMessages('chat-a')).map(item => item.id), ['a1', 'a2', 'a3', 'a4', 'a5']);
});

test('an interrupted migration leaves v1 authoritative and the next start redoes it; an existing backup is never replaced', async t => {
  const fixture = await legacy(t);
  const messages = path.join(fixture.data, 'messages'), obstacle = path.join(fixture.data, 'changes', 'change-b.json');
  // Leftovers of an earlier crashed attempt: a torn log, and a stale log for a chat that has no v1 history.
  await mkdir(messages, { mode: 0o700 }); await writeFile(path.join(messages, 'chat-a.jsonl'), '{"id":"a1","ro');
  await writeFile(path.join(messages, 'chat-empty.jsonl'), `${JSON.stringify(message('stale'))}\n`);
  // A directory where a change body must go makes the migration fail after the backup and logs are written.
  await mkdir(obstacle, { recursive: true }); await writeFile(path.join(obstacle, 'keep'), 'x');
  await assert.rejects(new WorkspaceServices(fixture.data, callbacks).bootstrap());
  assert.equal(await readFile(path.join(fixture.data, 'workspace.json'), 'utf8'), fixture.original);
  assert.equal(await readFile(path.join(fixture.data, backupName), 'utf8'), fixture.original);
  await rm(obstacle, { recursive: true });
  const service = new WorkspaceServices(fixture.data, callbacks); await service.bootstrap();
  await expectMigrated(service, fixture);
  assert.ok((await readdir(fixture.data)).every(name => !name.endsWith('.tmp')));

  const second = await legacy(t);
  await writeFile(path.join(second.data, backupName), 'an older backup', { mode: 0o600 });
  await new WorkspaceServices(second.data, callbacks).bootstrap();
  assert.equal(await readFile(path.join(second.data, backupName), 'utf8'), 'an older backup');
  const copies = (await readdir(second.data)).filter(name => /^workspace\.v1\.[0-9a-f]{16}\.backup\.json$/.test(name));
  assert.equal(copies.length, 1); assert.equal(await readFile(path.join(second.data, copies[0]), 'utf8'), second.original);
  assert.deepEqual(await new WorkspaceServices(second.data, callbacks).getMessages('chat-a'), second.messages['chat-a']);
});

test('unknown or malformed workspace versions are rejected without touching data', async t => {
  for (const content of [JSON.stringify({ version: 3, projects: [], sessions: [] }), JSON.stringify({ version: 1, projects: [], sessions: [] }), JSON.stringify({ version: 1, projects: [], sessions: [], messages: {}, changes: [{ id: '../escape' }] })]) {
    const data = path.join(await temporary(t), 'data'); await mkdir(data);
    await writeFile(path.join(data, 'workspace.json'), content);
    await assert.rejects(new WorkspaceServices(data, callbacks).bootstrap(), /Unsupported workspace database\. Existing data was preserved\./);
    assert.equal(await readFile(path.join(data, 'workspace.json'), 'utf8'), content);
    assert.deepEqual(await readdir(data), ['workspace.json']);
  }
});

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await temporary(t), folder = path.join(root, 'project'), data = path.join(root, 'data'); await mkdir(folder);
  const service = new WorkspaceServices(data, callbacks); await service.bootstrap();
  const project = await service.createProject({ name: 'Logs', folders: [{ path: folder, access: 'write' }] });
  const session = await service.createSession(project.id, 'demo');
  return { root, folder, data, service, project, session, log: (id: string) => path.join(data, 'messages', `${id}.jsonl`) };
}
const reopen = async (data: string) => { const service = new WorkspaceServices(data, callbacks); await service.bootstrap(); return service; };
const ids = async (service: WorkspaceServices, sessionId: string) => (await service.getMessages(sessionId)).map(item => item.id);

test('a torn final JSONL line is ignored and repaired by the next append', async t => {
  const { service, session, data, log } = await workspace(t);
  await service.appendMessage(session.id, message('m1')); await service.appendMessage(session.id, message('m2'));
  await appendFile(log(session.id), '{"id":"m3","role":"user","cont');
  const reopened = await reopen(data);
  assert.deepEqual(await ids(reopened, session.id), ['m1', 'm2']);
  await reopened.appendMessage(session.id, message('m3'));
  assert.deepEqual(await ids(await reopen(data), session.id), ['m1', 'm2', 'm3']);
  // A complete record whose newline was lost is kept, and the next record starts on its own line.
  await writeFile(log(session.id), (await readFile(log(session.id), 'utf8')).trimEnd());
  const unterminated = await reopen(data);
  assert.deepEqual(await ids(unterminated, session.id), ['m1', 'm2', 'm3']);
  await unterminated.appendMessage(session.id, message('m4'));
  assert.deepEqual(await ids(await reopen(data), session.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal((await readFile(log(session.id), 'utf8')).split('\n').length, 5);
});

test('damage in the middle of a log is reported for that chat only and is not overwritten', async t => {
  const { service, session, project, data, log } = await workspace(t);
  const other = await service.createSession(project.id, 'demo');
  for (const id of ['m1', 'm2', 'm3']) await service.appendMessage(session.id, message(id));
  await service.appendMessage(other.id, message('o1'));
  const lines = (await readFile(log(session.id), 'utf8')).split('\n'); lines.splice(1, 1, '{"id":"m2","role":');
  const damaged = lines.join('\n'); await writeFile(log(session.id), damaged);
  const reopened = await reopen(data);
  await assert.rejects(reopened.getMessages(session.id), /damaged at line 2/);
  await assert.rejects(reopened.appendMessage(session.id, message('m4')), /damaged at line 2/);
  assert.equal(await readFile(log(session.id), 'utf8'), damaged);
  assert.deepEqual(await ids(reopened, other.id), ['o1']);
  await reopened.appendMessage(other.id, message('o2'));
});

test('duplicate messages are rejected before and after reload; returned history is a copy', async t => {
  const { service, session, data } = await workspace(t);
  await service.appendMessage(session.id, message('same'));
  await assert.rejects(service.appendMessage(session.id, message('same', 'again')), /Message already exists/);
  const reopened = await reopen(data);
  await assert.rejects(reopened.appendMessage(session.id, message('same', 'again')), /Message already exists/);
  const history = await reopened.getMessages(session.id);
  assert.equal(history.length, 1); assert.equal(typeof history[0].accessScope, 'string');
  history[0].content = 'mutated'; history.push(message('injected'));
  assert.deepEqual(await reopened.getMessages(session.id), [{ ...message('same'), accessScope: history[0].accessScope }]);
  await assert.rejects(reopened.appendMessage('missing-session', message('x')), /Session not found/);
  await assert.rejects(reopened.getMessages('missing-session'), /Session not found/);
});

test('appending to one chat neither rewrites nor serializes another chat history', async t => {
  const { service, session, project, data, log } = await workspace(t);
  const other = await service.createSession(project.id, 'demo'), filler = 'x'.repeat(20_000);
  for (let index = 0; index < 50; index++) await service.appendMessage(session.id, message(`big-${index}`, `${filler}${index}`));
  await service.getMessages(session.id);
  const before = await stat(log(session.id));
  const stringify = JSON.stringify; let serialized = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { const text = stringify(...args); serialized += text?.length ?? 0; return text; }) as typeof JSON.stringify;
  try { await service.appendMessage(other.id, message('small')); } finally { JSON.stringify = stringify; }
  assert.ok(serialized < 100_000, `serialized ${serialized} characters`);
  const after = await stat(log(session.id));
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
  assert.ok(!(await readFile(path.join(data, 'workspace.json'), 'utf8')).includes(filler));
  // Concurrent appends keep per-chat order.
  await Promise.all(Array.from({ length: 15 }, (_, index) => [service.appendMessage(session.id, message(`a${index}`)), service.appendMessage(other.id, message(`b${index}`))]).flat());
  const expected = (prefix: string) => Array.from({ length: 15 }, (_, index) => `${prefix}${index}`);
  assert.deepEqual((await ids(await reopen(data), session.id)).slice(50), expected('a'));
  assert.deepEqual((await ids(await reopen(data), other.id)).slice(1), expected('b'));
});

test('deleting a project removes its chat logs and change bodies but keeps other projects', async t => {
  const { service, session, project, data, log, root } = await workspace(t);
  await service.appendMessage(session.id, message('mine'));
  await service.files.write(project, 'tracked.txt', 'content', session.id);
  const [change] = await service.getChanges(project.id);
  assert.equal(change.after, 'content');
  const body = path.join(data, 'changes', `${change.id}.json`); assert.ok(await exists(body));
  const otherFolder = path.join(root, 'other'); await mkdir(otherFolder);
  const otherProject = await service.createProject({ name: 'Other', folders: [{ path: otherFolder, access: 'write' }] });
  const otherSession = await service.createSession(otherProject.id, 'demo');
  await service.appendMessage(otherSession.id, message('theirs'));
  await service.files.write(otherProject, 'kept.txt', 'kept', otherSession.id);
  await service.deleteProject(project.id);
  assert.equal(await exists(log(session.id)), false); assert.equal(await exists(body), false);
  assert.deepEqual(await ids(service, otherSession.id), ['theirs']);
  assert.equal((await service.getChanges(otherProject.id)).length, 1);
  assert.equal((await readdir(path.join(data, 'changes'))).length, 1);
});

test('startup collects old unreferenced logs and bodies left by an interrupted cleanup', async t => {
  const { service, session, project, data, log } = await workspace(t);
  await service.appendMessage(session.id, message('kept'));
  await service.files.write(project, 'kept.txt', 'kept', session.id);
  const changes = path.join(data, 'changes'), old = new Date(Date.now() - 3_600_000);
  for (const file of [log('removed-chat'), path.join(changes, 'removed-change.json'), path.join(changes, '.removed-change.json-1.tmp')]) await writeFile(file, '{}\n');
  // Age alone never removes a referenced file; a recent unreferenced body may still be awaiting its metadata commit.
  for (const file of [log(session.id), log('removed-chat'), ...(await readdir(changes)).map(name => path.join(changes, name))]) await utimes(file, old, old);
  await writeFile(path.join(changes, 'recent-change.json'), '{}');
  const reopened = await reopen(data);
  assert.deepEqual((await readdir(path.join(data, 'messages'))), [`${session.id}.jsonl`]);
  const left = await readdir(changes);
  assert.equal(left.length, 2); assert.ok(left.includes('recent-change.json'));
  assert.equal((await reopened.getChanges(project.id))[0].after, 'kept');
  assert.deepEqual(await ids(reopened, session.id), ['kept']);
});

test('RunStore skips rewriting an identical record and stores compact JSON', async t => {
  const root = await temporary(t), runs = new RunStore(root), file = path.join(root, 'runs', 'run-1.json');
  const record: RunRecord = { id: 'run-1', projectId: 'p', sessionId: 's', modelId: 'demo', status: 'running', phase: 'final', startedAt: new Date().toISOString(), steps: 0, stepLog: [], usage: {} as RunRecord['usage'], limits: {} as RunRecord['limits'] };
  await runs.save(record); const first = await stat(file);
  await runs.save(structuredClone(record));
  assert.equal((await stat(file)).ino, first.ino);
  await runs.save({ ...record, steps: 1 });
  assert.notEqual((await stat(file)).ino, first.ino);
  assert.ok(!(await readFile(file, 'utf8')).includes('\n'));
  assert.equal((await runs.get('run-1'))!.steps, 1);
  await runs.removeProject('p'); await runs.save({ ...record, steps: 1 });
  assert.equal((await runs.get('run-1'))!.steps, 1);
});
