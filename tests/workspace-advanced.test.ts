import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceServices, sandboxAvailable } from '../src/backend';
import { FileConflictError, fileVersion } from '../src/backend/files';
import { ProcessManager } from '../src/backend/processes';
import { redactCommandOutput } from '../src/backend/commands';
import { beginBackground } from '../src/backend/snapshot-scopes';
import { beginSnapshot, persistBackgroundTaint } from '../src/backend/snapshot-scopes';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent, CommandProcess } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-advanced-')));
  const projectRoot = path.join(root, 'project'); await mkdir(projectRoot);
  const events: AgentEvent[] = [];
  const services = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: event => { events.push(event); } });
  await services.bootstrap();
  const project = await services.createProject({ name: 'Advanced fixture', folders: [{ path: projectRoot, access: 'write' }], commandPolicy: 'sandbox' });
  const session = await services.createSession(project.id, 'demo');
  t.after(async () => { await services.commands.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projectRoot, services, project, session, events };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const until = Date.now() + 3000;
  while (!await predicate()) { if (Date.now() > until) throw new Error('Fixture did not reach expected state.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('command snapshots skip deep readonly trees but retain explicit writable children and undo', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  const reference = path.join(projectRoot, 'reference'), child = path.join(reference, 'writable');
  await mkdir(path.join(reference, ...Array(15).fill('deep')), { recursive: true });
  await mkdir(child); await writeFile(path.join(child, 'file.txt'), 'before');
  const scoped = await services.saveProject({ ...project, folders: [...project.folders, { path: reference, access: 'read' }, { path: child, access: 'write' }] });
  const result = await services.files.trackCommand(scoped, session.id, async () => {
    await writeFile(path.join(child, 'file.txt'), 'after'); return 'Exit 0';
  });
  assert.doesNotMatch(result, /coverage is incomplete/, 'Read-only traversal must not exhaust the writable snapshot budget');
  const changes = await services.getChanges(project.id);
  assert.equal(changes.length, 1); assert.equal(changes[0].before, 'before');
  await services.revertChange(project.id, changes[0].id);
  assert.equal(await readFile(path.join(child, 'file.txt'), 'utf8'), 'before');
});

test('editor versions reject external edits and supply current content for a reviewable conflict', async t => {
  const { services, project, projectRoot } = await fixture(t);
  await writeFile(path.join(projectRoot, 'editor.txt'), 'first');
  const opened = await services.files.read(project, 'editor.txt');
  assert.equal(opened.version, fileVersion('first'));
  await writeFile(path.join(projectRoot, 'editor.txt'), 'external change');
  await assert.rejects(services.files.write(project, 'editor.txt', 'stale editor change', undefined, { expectedVersion: opened.version }), error => {
    assert.ok(error instanceof FileConflictError);
    assert.deepEqual(error.conflict, { path: opened.path, expectedVersion: opened.version, currentVersion: fileVersion('external change'), currentContent: 'external change' });
    return true;
  });
  assert.equal(await readFile(opened.path, 'utf8'), 'external change');
  await assert.rejects(services.files.write(project, 'editor.txt', 'unexpected overwrite', undefined, { expectedVersion: null }), FileConflictError);
  const latest = await services.files.read(project, 'editor.txt');
  await services.files.write(project, 'editor.txt', 'reviewed change', undefined, { expectedVersion: latest.version });
  assert.equal(await readFile(opened.path, 'utf8'), 'reviewed change');
  await services.files.write(project, 'new.txt', 'new', undefined, { expectedVersion: null });
});

test('read-before-edit observations are scoped to a chat and stale concurrent edits fail', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  const other = await services.createSession(project.id, 'demo');
  await writeFile(path.join(projectRoot, 'shared.txt'), 'one\ntwo');
  await assert.rejects(services.files.write(project, 'shared.txt', 'blind', session.id, { requireRead: true }), /Read this file/);
  await services.files.read(project, 'shared.txt', session.id);
  await assert.rejects(services.files.edit(project, 'shared.txt', 'one', 'ONE', false, other.id, { requireRead: true }), /Read this file/);
  await services.files.read(project, 'shared.txt', other.id);
  const outcomes = await Promise.allSettled([
    services.files.edit(project, 'shared.txt', 'one', 'ONE', false, session.id, { requireRead: true }),
    services.files.edit(project, 'shared.txt', 'two', 'TWO', false, other.id, { requireRead: true }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(await readFile(path.join(projectRoot, 'shared.txt'), 'utf8'), 'ONE\ntwo');
  await services.files.read(project, 'shared.txt', other.id);
  await services.files.edit(project, 'shared.txt', 'two', 'TWO', false, other.id, { requireRead: true });
  assert.equal(await readFile(path.join(projectRoot, 'shared.txt'), 'utf8'), 'ONE\nTWO');
});

test('task checkpoints collapse repeated edits and preflight all files before reverting a group', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await writeFile(path.join(projectRoot, 'a.txt'), 'A0'); await writeFile(path.join(projectRoot, 'b.txt'), 'B0');
  const point = await services.files.createCheckpoint(project, session.id, 'Fixture task', 'fixture-run');
  await services.files.write(project, 'a.txt', 'A1', session.id, { checkpointId: point.id });
  await services.files.write(project, 'a.txt', 'A2', session.id, { checkpointId: point.id });
  await services.files.write(project, 'b.txt', 'B1', session.id, { checkpointId: point.id });
  await services.files.write(project, 'new.txt', 'new', session.id, { checkpointId: point.id });
  const changes = await services.files.changes(project.id);
  assert.ok(changes.every(change => change.checkpointId === point.id));
  assert.equal((await services.files.checkpoints(project.id, session.id))[0].runId, 'fixture-run');
  await writeFile(path.join(projectRoot, 'b.txt'), 'external');
  await assert.rejects(services.files.revertCheckpoint(project, point.id), /preserve newer edits/);
  assert.equal(await readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'A2');
  assert.equal(await readFile(path.join(projectRoot, 'new.txt'), 'utf8'), 'new');
  await writeFile(path.join(projectRoot, 'b.txt'), 'B1');
  await services.files.revertCheckpoint(project, point.id);
  assert.equal(await readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await readFile(path.join(projectRoot, 'b.txt'), 'utf8'), 'B0');
  await assert.rejects(readFile(path.join(projectRoot, 'new.txt')), { code: 'ENOENT' });
  assert.deepEqual(await services.files.changes(project.id), []);
});

test('checkpoint undo refuses intervening other-chat changes and captures foreground command deletions', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  const other = await services.createSession(project.id, 'demo');
  await writeFile(path.join(projectRoot, 'a.txt'), 'A0');
  const point = await services.files.createCheckpoint(project, session.id);
  await services.files.write(project, 'a.txt', 'A1', session.id, { checkpointId: point.id });
  await services.files.write(project, 'a.txt', 'other', other.id);
  await services.files.write(project, 'a.txt', 'A2', session.id, { checkpointId: point.id });
  await assert.rejects(services.files.revertCheckpoint(project, point.id), /intervening edits/);
  assert.equal(await readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'A2');
  const second = await services.files.createCheckpoint(project, session.id, 'Deletion');
  await services.files.trackCommand(project, session.id, async () => { await rm(path.join(projectRoot, 'a.txt')); return 'Exit 0'; }, second.id);
  await services.files.revertCheckpoint(project, second.id);
  assert.equal(await readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'A2');
  const foreignRoot = path.join(projectRoot, 'other'); await mkdir(foreignRoot);
  const foreign = await services.createProject({ name: 'Foreign', folders: [{ path: foreignRoot, access: 'write' }] });
  await assert.rejects(services.files.revertCheckpoint(foreign, second.id), /not found/);
});

test('foreground commands continue but cannot attribute concurrent background edits to task undo', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await writeFile(path.join(projectRoot, 'tracked.txt'), 'before');
  const release = beginBackground([projectRoot]);
  try {
    const result = await services.files.trackCommand(project, session.id, async () => { await writeFile(path.join(projectRoot, 'tracked.txt'), 'during background'); return 'Exit 0'; });
    assert.match(result, /not added to task undo.*background process/);
    assert.deepEqual(await services.files.changes(project.id), []);
  } finally { release(); }
  const captured = await services.files.trackCommand(project, session.id, async () => { await writeFile(path.join(projectRoot, 'tracked.txt'), 'foreground only'); return 'Exit 0'; });
  assert.match(captured, /Recorded 1 text file changes/);
  assert.equal((await services.files.changes(project.id))[0].before, 'during background');
});

test('a background lease starting during capture invalidates overlapping project snapshots', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await writeFile(path.join(projectRoot, 'tracked.txt'), 'before');
  let entered = false; let releaseAction!: () => void;
  const gate = new Promise<void>(resolve => { releaseAction = resolve; });
  const running = services.files.trackCommand(project, session.id, async () => { entered = true; await gate; await writeFile(path.join(projectRoot, 'tracked.txt'), 'ambiguous'); return 'Exit 0'; });
  await waitFor(() => entered);
  const releaseBackground = beginBackground([path.dirname(projectRoot)]);
  try { releaseAction(); const result = await running; assert.match(result, /not added to task undo/); assert.deepEqual(await services.files.changes(project.id), []); }
  finally { releaseBackground(); }
});

test('background write uncertainty persists into a fresh Node process and later command capture stays disabled', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await writeFile(path.join(projectRoot, 'tracked.txt'), 'before');
  await persistBackgroundTaint(services.store.directory, [projectRoot]);
  const persisted = JSON.parse(await readFile(path.join(services.store.directory, 'background-write-roots.json'), 'utf8'));
  assert.deepEqual(persisted, { version: 1, roots: [projectRoot] });
  const modulePath = path.resolve('src/backend/snapshot-scopes.ts');
  const script = `import {restoreBackgroundTaint,beginSnapshot} from ${JSON.stringify(modulePath)}; (async()=>{await restoreBackgroundTaint(${JSON.stringify(services.store.directory)});const capture=beginSnapshot(${JSON.stringify(project)});process.stdout.write(String(capture.ambiguous()));capture.release()})()`;
  const child = await promisify(execFile)(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), '-e', script], { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(child.stdout, 'true');
  const result = await services.files.trackCommand(project, session.id, async () => { await writeFile(path.join(projectRoot, 'tracked.txt'), 'later'); return 'Exit 0'; });
  assert.match(result, /including|включая перезапуск/); assert.deepEqual(await services.files.changes(project.id), []);
  await services.files.write(project, 'tracked.txt', 'file tool', session.id);
  assert.equal((await services.files.changes(project.id)).length, 1);
});

test('durable background uncertainty affects overlapping writable roots and does not taint read-only references', async t => {
  const { services, projectRoot, root } = await fixture(t);
  const unrelated = path.join(root, 'unrelated'); await mkdir(unrelated);
  await persistBackgroundTaint(services.store.directory, [projectRoot]);
  const base = await services.createProject({ name: 'Scope fixture', folders: [{ path: unrelated, access: 'write' }, { path: projectRoot, access: 'read' }] });
  const safe = beginSnapshot(base); assert.equal(safe.ambiguous(), false); safe.release();
  const parent = { ...base, folders: [{ path: root, access: 'write' as const }] };
  const unsafe = beginSnapshot(parent); assert.equal(unsafe.ambiguous(), true); unsafe.release();
});

test('ordinary foreground command capture remains available before any background launch', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  const result = await services.files.trackCommand(project, session.id, async () => { await writeFile(path.join(projectRoot, 'fresh.txt'), 'foreground'); return 'Exit 0'; });
  assert.match(result, /Recorded 1 text file changes/); assert.equal((await services.files.changes(project.id))[0].after, 'foreground');
});

test('process output streams before completion, redacts split credentials and reports structured exit status', async t => {
  const { projectRoot, project, session } = await fixture(t);
  const updates: { process: CommandProcess; delta?: string }[] = [];
  const manager = new ProcessManager((process, delta) => updates.push({ process, delta }), redactCommandOutput);
  t.after(() => manager.close());
  const launched = manager.start({ projectId: project.id, sessionId: session.id, command: 'local fixture', cwd: projectRoot, background: false, executable: '/bin/sh', args: ['-c', "printf 'ready\\n'; printf 'Bearer fixture.'; sleep 0.05; printf 'credential\\n'; sleep 0.15; exit 7"], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3000, signal: new AbortController().signal, cleanup: async () => undefined });
  await waitFor(() => updates.some(update => update.delta?.includes('ready')));
  assert.equal(manager.list(project.id)[0].status, 'running');
  const result = await launched.completion;
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.match(result.output, /Bearer \[credential redacted\]/);
  assert.ok(updates.every(update => !JSON.stringify(update).includes('fixture.credential')));
});

test('streaming never emits protected PEM bodies, including a split header and an unfinished block', async t => {
  const { projectRoot, project, session } = await fixture(t);
  const updates: { process: CommandProcess; delta?: string }[] = [];
  const manager = new ProcessManager((process, delta) => updates.push({ process, delta }), redactCommandOutput); t.after(() => manager.close());
  const launched = manager.start({ projectId: project.id, sessionId: session.id, command: 'synthetic protected block fixture', cwd: projectRoot, background: false, executable: '/bin/sh',
    args: ['-c', "printf 'before\\n-----BEGIN RSA PRI'; sleep 0.02; printf 'VATE KEY-----\\nFIXTURE-NONSECRET-BODY\\n-----END RSA PRIVATE KEY-----\\nafter\\n'; printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'FIXTURE-UNFINISHED-NONSECRET' >&2"],
    env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3000, signal: new AbortController().signal, cleanup: async () => undefined });
  const result = await launched.completion;
  assert.equal(result.status, 'completed'); assert.match(result.output, /before/); assert.match(result.output, /after/); assert.match(result.output, /protected content redacted/);
  for (const text of [result.output, ...updates.map(update => JSON.stringify(update))]) assert.doesNotMatch(text, /FIXTURE-NONSECRET-BODY|FIXTURE-UNFINISHED-NONSECRET|BEGIN RSA|BEGIN CERTIFICATE/);
  assert.equal(redactCommandOutput('-----BEGIN PRIVATE KEY-----\nFIXTURE-NONSECRET'), '[protected content redacted]');
});

test('stopping a background process kills descendants in its process group and does not stop another chat', async t => {
  const { projectRoot, project, session } = await fixture(t);
  const manager = new ProcessManager(() => undefined, redactCommandOutput); t.after(() => manager.close());
  const launch = (sessionId: string, script: string) => manager.start({ projectId: project.id, sessionId, command: 'local background fixture', cwd: projectRoot, background: true, executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, signal: new AbortController().signal, cleanup: async () => undefined });
  const first = launch(session.id, 'sleep 30 & echo $! > grandchild.pid; wait');
  const second = launch('other-fixture-chat', 'sleep 0.5; printf "second completed\\n"');
  await waitFor(async () => { try { return Boolean(await readFile(path.join(projectRoot, 'grandchild.pid'), 'utf8')); } catch { return false; } });
  const pid = Number(await readFile(path.join(projectRoot, 'grandchild.pid'), 'utf8'));
  await assert.rejects(manager.stop('foreign-project', first.process.id), /does not belong/);
  await manager.stopSession(session.id);
  assert.equal((await first.completion).status, 'stopped');
  assert.equal((await second.completion).status, 'completed');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('an exited leader with inherited detached-child pipes completes within a bounded drain and reports uncertainty', async t => {
  const { projectRoot, project, session } = await fixture(t);
  const pidPath = path.join(projectRoot, 'detached.pid'); let recorded = 0; let fixturePid: number | undefined;
  const manager = new ProcessManager(() => undefined, redactCommandOutput);
  t.after(async () => { await manager.close(); try { if (fixturePid) process.kill(fixturePid, 'SIGKILL'); } catch { /* Fixture child already exited. */ } });
  const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(${JSON.stringify(process.execPath)},['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'inherit',env:{PATH:'/usr/bin:/bin'}});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref()`;
  const launched = manager.start({ projectId: project.id, sessionId: session.id, command: 'detached fixture', cwd: projectRoot, background: true, executable: process.execPath, args: ['-e', script], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 2000, signal: new AbortController().signal, unmanagedChild: async () => { recorded++; }, cleanup: async () => undefined });
  const result = await launched.completion;
  fixturePid = Number(await readFile(pidPath, 'utf8'));
  assert.equal(recorded, 1); assert.equal(result.status, 'completed'); assert.match(result.output, /detached child may still be running/);
  assert.ok(Date.now() - new Date(result.startedAt).getTime() < 1500);
});

test('agent stopping a process uses Ask approval with cancellation and preserves other chats', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await services.updateSession(session.id, { mode: 'ask' });
  const manager = (services.commands as unknown as { processes: ProcessManager }).processes;
  const launch = (sessionId: string) => manager.start({ projectId: project.id, sessionId, command: 'safe fixture', cwd: projectRoot, background: true, executable: '/bin/sh', args: ['-c', 'sleep 30'], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, signal: new AbortController().signal, cleanup: async () => undefined });
  const first = launch(session.id); const other = launch('other-chat');
  let approved = 0; let received: AbortSignal | undefined;
  (services.commands as unknown as { callbacks: { approve(request: unknown, signal?: AbortSignal): Promise<boolean> } }).callbacks.approve = async (_request, signal) => { approved++; received = signal; return true; };
  const signal = new AbortController().signal;
  await assert.rejects(services.commands.stopManaged({ project, sessionId: session.id, signal }, other.process.id), /this chat/);
  await services.commands.stopManaged({ project, sessionId: session.id, signal }, first.process.id);
  assert.equal(approved, 1); assert.equal(received, signal); assert.equal((await first.completion).status, 'stopped');
  assert.equal((await services.commands.listProcesses(project.id)).find(item => item.id === other.process.id)!.status, 'running');
  await manager.stop(project.id, other.process.id);
});

test('cancelling a pending process-stop approval keeps the command running and resolves the request', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  await services.updateSession(session.id, { mode: 'ask' });
  const manager = (services.commands as unknown as { processes: ProcessManager }).processes;
  const launched = manager.start({ projectId: project.id, sessionId: session.id, command: 'safe fixture', cwd: projectRoot, background: true, executable: '/bin/sh', args: ['-c', 'sleep 30'], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, signal: new AbortController().signal, cleanup: async () => undefined });
  let pending = false;
  (services.commands as unknown as { callbacks: { approve(request: unknown, signal?: AbortSignal): Promise<boolean> } }).callbacks.approve = async (_request, signal) => {
    assert.ok(signal); pending = true;
    return new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  };
  const controller = new AbortController();
  const stopping = services.commands.stopManaged({ project, sessionId: session.id, signal: controller.signal }, launched.process.id);
  const rejection = assert.rejects(stopping, /declined|cancelled/);
  await waitFor(() => pending); controller.abort(); await rejection;
  assert.equal((await services.commands.listProcesses(project.id))[0].status, 'running');
  await manager.stop(project.id, launched.process.id);
});

test('actual macOS streamed background commands retain Plan, readonly and project scope boundaries', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run in ordinary macOS Terminal for actual command isolation.'); return; }
  const { services, project, session, projectRoot, events } = await fixture(t);
  await services.updateSession(session.id, { mode: 'plan' });
  const context = { project, sessionId: session.id, signal: new AbortController().signal };
  await assert.rejects(services.commands.startBackground(context, 'true'), /Plan mode/);
  await services.updateSession(session.id, { mode: 'bypass' });
  const background = await services.commands.startBackground(context, "printf 'started\\n'; sleep 30");
  await waitFor(() => events.some(event => event.command?.delta?.includes('started')));
  assert.equal(background.background, true);
  await services.commands.stopSession(session.id);
  assert.equal((await services.commands.listProcesses(project.id, session.id))[0].status, 'stopped');
  const readonly = path.join(projectRoot, 'reference'); await mkdir(readonly);
  const current = await services.saveProject({ ...project, folders: [...project.folders, { path: readonly, access: 'read' }] });
  const denied = await services.commands.runDetailed({ ...context, project: current }, "printf 'forbidden' > reference/blocked.txt");
  assert.equal(denied.status, 'failed'); assert.notEqual(denied.exitCode, 0);
  await assert.rejects(readFile(path.join(readonly, 'blocked.txt')), { code: 'ENOENT' });
});

test('run_command preserves observed failure metadata and snapshots partial writes before returning', async t => {
  const { services, project, projectRoot, session } = await fixture(t);
  const file = path.join(projectRoot, 'partial.txt');
  await writeFile(file, 'before');
  const manager = new ProcessManager(() => {}, value => value);
  t.after(() => manager.close());
  t.mock.method(services.commands, 'runDetailed', async () => manager.start({ projectId: project.id, sessionId: session.id, command: 'partial-write fixture', cwd: projectRoot,
    background: false, executable: '/bin/sh', args: ['-c', "printf after > partial.txt; exit 1"], env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3000,
    signal: new AbortController().signal, cleanup: async () => {} }).completion);
  const result = await services.executeTool({ id: 'partial', name: 'run_command', arguments: { command: 'partial-write fixture' } }, { project, sessionId: session.id, signal: new AbortController().signal });
  assert.equal(result.error, true);
  assert.deepEqual(result.commandExit, { code: 1 });
  assert.match(result.text, /Exit 1/);
  const changes = await services.getChanges(project.id);
  assert.ok(changes.some(change => change.path === file && change.before === 'before' && change.after === 'after'));
});
