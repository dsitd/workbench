import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { fileVersion } from '../src/backend/files';
import { defaultAppSettings, defaultRunLimits } from '../src/shared/runs';
import type { RunRecord } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-features-')));
  const projectRoot = path.join(root, 'project'); const readonly = path.join(projectRoot, 'reference'); const outside = path.join(root, 'outside');
  await mkdir(readonly, { recursive: true }); await mkdir(outside);
  const services = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => undefined }); await services.bootstrap();
  const project = await services.createProject({ name: 'Feature fixture', folders: [{ path: projectRoot, access: 'write' }, { path: readonly, access: 'read' }] });
  const session = await services.createSession(project.id, 'demo');
  t.after(async () => { await services.commands.close(); await rm(root, { recursive: true, force: true }); });
  return { root, services, project, projectRoot, readonly, outside, session };
}
function run(projectId: string, sessionId: string, id: string, kind: 'agent' | 'title' = 'agent'): RunRecord {
  return { id, projectId, sessionId, modelId: 'demo', kind, status: 'running', phase: 'tools', startedAt: new Date().toISOString(), steps: 1,
    stepLog: [{ index: 1, startedAt: new Date().toISOString(), durationMs: 20, toolNames: ['read_file'], errors: [], inputTokens: 10, outputTokens: 5, retries: 0 }],
    usage: { inputTokens: 10, outputTokens: 5, tokenSource: 'reported', costSource: 'api', costUsd: 0 }, limits: defaultRunLimits,
    checkpoint: { userMessageId: 'fixture-message' } };
}
const persistedShape = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('settings default safely, persist explicit overrides and reject invalid updates atomically', async t => {
  const { services } = await fixture(t);
  assert.deepEqual(persistedShape(await services.getSettings()), defaultAppSettings);
  const saved = await services.saveSettings({ autoTitle: { enabled: false, model: 'fixture-title-model' }, contextBudgetTokens: 12_000, runLimits: { maxSteps: 0, maxTokens: 30_000, maxCostUsd: 0.3, maxDurationMs: 20_000 } });
  for (const input of [
    { ...saved, runLimits: { maxSteps: -1 } }, { ...saved, runLimits: { maxCostUsd: Number.NaN } },
    { ...saved, contextBudgetTokens: 3999 }, { ...saved, autoTitle: { enabled: true, model: ' ' } },
    { ...saved, autoTitle: { ...saved.autoTitle, credentialModelId: 'missing-model' } },
  ]) await assert.rejects(services.saveSettings(input));
  assert.deepEqual(await services.getSettings(), saved);
  const reopened = new WorkspaceServices(services.store.directory, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  assert.deepEqual(await reopened.getSettings(), saved);
});

test('legacy bootstrap adds settings and title provenance while preserving messages and manual names', async t => {
  const { services, project, session } = await fixture(t);
  const manual = await services.createSession(project.id, 'demo');
  await services.updateSession(manual.id, { title: 'User supplied title' });
  await services.appendMessage(session.id, { id: 'fixture-message', role: 'user', content: 'Preserved history', createdAt: new Date().toISOString() });
  await services.store.mutate(state => { delete state.settings; for (const value of state.sessions) { delete value.titleSource; delete value.titleAttempted; } });
  const reopened = new WorkspaceServices(services.store.directory, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  assert.deepEqual(persistedShape(await reopened.getSettings()), defaultAppSettings);
  assert.equal((await reopened.getSession(session.id)).titleSource, 'default'); assert.equal((await reopened.getSession(manual.id)).titleSource, 'manual');
  await reopened.automaticTitle(manual.id, 'Would overwrite user');
  assert.equal((await reopened.getSession(manual.id)).title, 'User supplied title');
  await reopened.automaticTitle(session.id, 'Generated fixture title');
  assert.equal((await reopened.getSession(session.id)).titleSource, 'automatic');
  assert.equal((await reopened.getMessages(session.id))[0].content, 'Preserved history');
});

test('project rules expose optimistic conflicts for file and project instruction edits', async t => {
  const { services, project, projectRoot, readonly } = await fixture(t);
  await writeFile(path.join(projectRoot, 'AGENTS.md'), 'initial rule');
  await writeFile(path.join(readonly, 'AGENTS.md'), 'reference rule');
  const first = (await services.getRules(project.id)).find(rule => rule.path === path.join(projectRoot, 'AGENTS.md'))!;
  assert.equal(first.version, fileVersion('initial rule'));
  await services.saveRule(project.id, first.path, 'reviewed rule', first.version);
  const stale = await services.saveRule(project.id, first.path, 'stale rule', first.version);
  assert.ok('ok' in stale && !stale.ok); if ('ok' in stale && !stale.ok) assert.equal(stale.conflict.currentContent, 'reviewed rule');
  assert.equal(await readFile(first.path, 'utf8'), 'reviewed rule');
  await assert.rejects(services.saveRule(project.id, path.join(readonly, 'AGENTS.md'), 'forbidden'), /read-only/);
  const document = (await services.getRules(project.id)).find(rule => rule.path === `project:${project.id}`)!;
  await services.saveRule(project.id, document.path, 'current instruction', document.version);
  const staleProject = await services.saveRule(project.id, document.path, 'stale instruction', document.version);
  assert.ok('ok' in staleProject && !staleProject.ok);
  assert.equal((await services.getProject(project.id)).instructions, 'current instruction');
});

test('rule discovery skips acceptance and release trees and observes external rule edits without a cache', async t => {
  const { services, project, projectRoot } = await fixture(t);
  for (const directory of ['.workbench/acceptance', 'release/fixture', 'source/nested']) {
    await mkdir(path.join(projectRoot, directory), { recursive: true });
    await writeFile(path.join(projectRoot, directory, 'AGENTS.md'), `fixture ${directory}`);
  }
  const first = await services.getRules(project.id);
  assert.ok(first.some(document => document.path === path.join(projectRoot, 'source/nested/AGENTS.md')));
  assert.ok(first.every(document => !document.path.includes('/.workbench/') && !document.path.includes('/release/')));
  await writeFile(path.join(projectRoot, 'source/nested/AGENTS.md'), 'external updated rule');
  const updated = await services.getRules(project.id);
  assert.equal(updated.find(document => document.path === path.join(projectRoot, 'source/nested/AGENTS.md'))!.content, 'external updated rule');
});

test('pins and @file references select bounded fragments and reject private, secret and escaping paths', async t => {
  const { services, project, projectRoot, outside, session } = await fixture(t);
  await writeFile(path.join(projectRoot, 'notes.txt'), 'one\ntwo\nthree\nfour');
  await writeFile(path.join(projectRoot, 'with space.txt'), 'alpha\nbeta\ngamma');
  await writeFile(path.join(projectRoot, '.env'), 'PLACEHOLDER=not-a-real-secret');
  await writeFile(path.join(outside, 'external.txt'), 'outside fixture');
  await symlink(outside, path.join(projectRoot, 'escape'));
  const pins = await services.setContextPins(project.id, [{ id: 'fixture-pin', path: 'notes.txt', startLine: 2, endLine: 3 }]);
  await services.saveProjectMemory(project.id, 'Use the established local data format.');
  const current = await services.getProject(project.id);
  const context = await services.getProjectContext(current, '@file:notes.txt#L2-L3 @file("with space.txt#L1-L2")', new AbortController().signal, session.id);
  assert.equal(context.pins.length, 2); assert.equal(context.pins[0].content, 'two\nthree'); assert.equal(context.pins[1].content, 'alpha\nbeta');
  assert.match(context.pins[0].source, /sha256:/);
  assert.equal(current.memory, 'Use the established local data format.');
  for (const file of ['.env', path.join(services.store.directory, 'workspace.json'), 'escape/external.txt']) {
    await assert.rejects(services.setContextPins(project.id, [{ id: 'denied', path: file }]));
    await assert.rejects(services.getProjectContext(current, `@file("${file}")`, new AbortController().signal, session.id));
  }
  await assert.rejects(services.setContextPins(project.id, [{ id: 'bad-range', path: 'notes.txt', startLine: 3, endLine: 1 }]));
  await assert.rejects(services.setContextPins(project.id, Array.from({ length: 33 }, (_, i) => ({ id: `pin-${i}`, path: 'notes.txt' }))));
  assert.deepEqual((await services.getProject(project.id)).pins, pins);
});

test('persistent run records recover interrupted tasks without rewriting history or completed runs', async t => {
  const { services, session, project } = await fixture(t);
  await services.appendMessage(session.id, { id: 'fixture-message', role: 'user', content: 'Original task', createdAt: new Date().toISOString() });
  const running = run(project.id, session.id, 'running-fixture');
  await services.saveRun(running); running.stepLog[0].toolNames.push('mutated-after-save');
  const completed = { ...run(project.id, session.id, 'completed-fixture'), status: 'completed' as const, phase: 'final' as const, canContinue: false };
  await services.saveRun(completed); await services.saveRun(run(project.id, session.id, 'title-fixture', 'title'));
  await services.bootstrap(); assert.equal((await services.getRun('running-fixture'))!.status, 'running');
  const reopened = new WorkspaceServices(services.store.directory, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  const recovered = (await reopened.getRun('running-fixture'))!;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.canContinue, true); assert.equal(recovered.phase, 'final');
  assert.deepEqual(recovered.stepLog[0].toolNames, ['read_file']);
  assert.equal((await reopened.getRun('title-fixture'))!.canContinue, false);
  assert.deepEqual(await reopened.getRun('completed-fixture'), completed);
  assert.equal((await reopened.getMessages(session.id))[0].content, 'Original task');
  assert.equal((await reopened.listRuns(project.id, session.id)).length, 3);
  await assert.rejects(reopened.saveRun({ ...run('foreign-project', session.id, 'foreign-run') }), /another project/);
  assert.equal(await reopened.getRun('foreign-run'), undefined);
});

test('recovery cancels an interrupted verification while preserving the completed model answer', async t => {
  const { services, session, project } = await fixture(t);
  const completed = { ...run(project.id, session.id, 'verification-recovery'), status: 'completed' as const, phase: 'verification' as const,
    verification: { id: 'verification-fixture', projectId: project.id, sessionId: session.id, command: 'fixture check', cwd: project.folders[0].path,
      status: 'running' as const, output: 'partial fixture output', startedAt: new Date().toISOString() } };
  await services.saveRun(completed);
  const reopened = new WorkspaceServices(services.store.directory, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  const recovered = (await reopened.getRun(completed.id))!;
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.phase, 'final');
  assert.equal(recovered.verification!.status, 'cancelled'); assert.match(recovered.verification!.output, /partial fixture output/);
  assert.ok(recovered.verification!.finishedAt); assert.ok(recovered.verification!.durationMs! >= 0);
  assert.deepEqual(recovered.stepLog, completed.stepLog); assert.deepEqual(recovered.usage, completed.usage);
});
