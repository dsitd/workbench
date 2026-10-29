import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceServices } from '../src/backend';
import { RunCoordinator } from '../src/main/run-coordinator';
import type { CredentialVault } from '../src/main/credentials';
import type { AgentEvent, RunRecord, CommandProcess } from '../src/shared/types';
import { fixtureModel, reply } from './agent-fixture';
import { modelCredentialSource } from '../src/shared/model-credentials';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-coordinator-fixture-')));
  const folder = path.join(root, 'project'); await mkdir(folder);
  const events: AgentEvent[] = [];
  const workspace = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: event => events.push(event) });
  await workspace.bootstrap();
  const model = await workspace.saveModel(fixtureModel);
  const project = await workspace.createProject({ name: 'Fixture', folders: [{ path: folder, access: 'write' }] });
  const session = await workspace.createSession(project.id, model.id);
  await workspace.appendMessage(session.id, { id: 'fixture-user', role: 'user', content: 'Fix a selected image bug', createdAt: '' });
  await workspace.appendMessage(session.id, { id: 'fixture-assistant', role: 'assistant', content: 'Selected image handling changed.', createdAt: '' });
  const run: RunRecord = { id: 'fixture-run', projectId: project.id, sessionId: session.id, modelId: model.id, kind: 'agent', status: 'completed', phase: 'final', startedAt: new Date().toISOString(), steps: 1, stepLog: [], usage: { inputTokens: 10, outputTokens: 5, tokenSource: 'reported', costSource: 'unknown' }, limits: {} };
  await workspace.saveRun(run);
  let resolutions = 0;
  const vault = { resolve: async (selected: typeof model) => { resolutions++; assert.equal(selected.id, model.id); return 'artificial-coordinator-fixture-value'; } } as unknown as CredentialVault;
  const coordinator = new RunCoordinator(workspace, vault, event => events.push(event));
  t.after(async () => { coordinator.stopAll(); await workspace.commands.close(); await rm(root, { recursive: true, force: true }); });
  return { root, folder, workspace, project, session, model, run, coordinator, events, resolutions: () => resolutions };
}

test('auto title is attempted once, records its actual usage, and never stores the artificial credential', async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body)); assert.equal(body.model, 'google/gemini-2.5-flash-lite'); assert.equal(body.max_tokens, 128); assert.deepEqual(body.reasoning, { enabled: false });
    return reply('Исправление изображений', { prompt_tokens: 100, completion_tokens: 5, cost: 0.000012 });
  });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(f.resolutions(), 1);
  const session = await f.workspace.getSession(f.session.id); assert.equal(session.title, 'Исправление изображений'); assert.equal(session.titleSource, 'automatic'); assert.equal(session.titleAttempted, true);
  const titles = (await f.workspace.listRuns(f.project.id, f.session.id)).filter(run => run.kind === 'title'); assert.equal(titles.length, 1); assert.equal(titles[0].usage.costUsd, 0.000012); assert.equal(titles[0].usage.costSource, 'api');
  assert.ok(!JSON.stringify([titles, f.events]).includes('artificial-coordinator-fixture-value'));
});

test('automatic naming cannot overwrite a manual title changed during its in-flight API request', async t => {
  const f = await fixture(t); let entered!: () => void, release!: () => void;
  const begun = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { entered(); await gate; return reply('Automatic result', { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 }); });
  const pending = f.coordinator.afterRun(f.session.id, new AbortController().signal); await begun;
  await f.workspace.updateSession(f.session.id, { title: 'Мой ручной заголовок', titleSource: 'manual' }); release(); await pending;
  const session = await f.workspace.getSession(f.session.id); assert.equal(session.title, 'Мой ручной заголовок'); assert.equal(session.titleSource, 'manual');
});

test('disabled titles and foreign API origins never resolve or transmit a key', async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
  const settings = await f.workspace.getSettings(); await f.workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: false } });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal); assert.equal(calls, 0); assert.equal(f.resolutions(), 0);
  await f.workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: true, credentialModelId: f.model.id } });
  await f.workspace.saveModel({ ...f.model, baseUrl: 'https://openrouter.ai.evil.example/api/v1' });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal); assert.equal(calls, 0); assert.equal(f.resolutions(), 0);
});

test('Responses profiles can name a chat using a validated shared key and the bounded chat title endpoint', async t => {
  const f = await fixture(t);
  const shared = await f.workspace.saveModel({ ...f.model, id: 'responses-fixture', kind: 'openai-responses', credentialModelId: f.model.id });
  await f.workspace.updateSession(f.session.id, { modelId: shared.id });
  const vault = { resolve: async (selected: typeof f.model, models: typeof f.model[]) => {
    assert.equal(selected.id, shared.id); assert.equal(modelCredentialSource(selected, models).id, f.model.id);
    return 'artificial-shared-coordinator-value';
  } } as unknown as CredentialVault;
  const coordinator = new RunCoordinator(f.workspace, vault, () => undefined);
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(JSON.parse(String(init.body)).model, 'google/gemini-2.5-flash-lite');
    return reply('Название общей модели', { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 });
  });
  await coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal((await f.workspace.getSession(f.session.id)).title, 'Название общей модели');
});

test('truncated title records failure and its billed usage without changing the session title', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => reply('Incomplete', { prompt_tokens: 20, completion_tokens: 128, cost: 0.00008 }, 'length'));
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  const title = (await f.workspace.listRuns(f.project.id, f.session.id)).find(run => run.kind === 'title')!;
  assert.equal(title.status, 'error'); assert.equal(title.usage.outputTokens, 128); assert.equal(title.usage.costUsd, 0.00008); assert.equal(title.usage.costSource, 'api');
  assert.equal((await f.workspace.getSession(f.session.id)).title, 'Новый чат'); assert.ok(!JSON.stringify(title).includes('Incomplete'));
});

test('Luna title helper uses Responses without reasoning and records actual API cost', async t => {
  const f = await fixture(t); const settings = await f.workspace.getSettings();
  await f.workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, model: 'openai/gpt-6-luna', credentialModelId: f.model.id } });
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(String(url), 'https://openrouter.ai/api/v1/responses');
    assert.equal(body.model, 'openai/gpt-6-luna'); assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.max_output_tokens, 128); assert.equal(body.tools.length, 0);
    assert.equal(body.prompt_cache_options, undefined);
    return new Response(JSON.stringify({ id: 'resp-title', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Название чата от Luna' }] }], usage: { input_tokens: 50, output_tokens: 6, cost: 0.000008 } }), { headers: { 'content-type': 'application/json' } });
  });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal((await f.workspace.getSession(f.session.id)).title, 'Название чата от Luna');
  const run = (await f.workspace.listRuns(f.project.id, f.session.id)).find(value => value.kind === 'title')!;
  assert.equal(run.status, 'completed'); assert.equal(run.usage.costUsd, 0.000008); assert.equal(run.usage.costSource, 'api');
});

test('read-only run never adopts unrelated historical manual changes lacking a checkpoint', async t => {
  const f = await fixture(t); const settings = await f.workspace.getSettings(); await f.workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: false } });
  await writeFile(path.join(f.folder, 'manual.txt'), 'old'); await f.workspace.writeFile(f.project.id, 'manual.txt', 'manual update');
  const changes = await f.workspace.getChanges(f.project.id); assert.ok(changes.length); assert.equal(changes[0].checkpointId, undefined);
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.deepEqual((await f.workspace.getRun(f.run.id))!.changedFiles, []);
});

test('verification failure stays distinct from model completion and has its own task checkpoint', async t => {
  const f = await fixture(t); const settings = await f.workspace.getSettings(); await f.workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: false } });
  await f.workspace.saveProject({ ...f.project, verificationCommand: 'fixture-verification' });
  const file = path.join(f.folder, 'generated.txt');
  const runDetailed = t.mock.method(f.workspace.commands, 'runDetailed', async (context: { checkpointId?: string; runId?: string; sessionId: string }) => {
    assert.ok(context.checkpointId); assert.equal(context.runId, f.run.id); assert.equal(context.sessionId, f.session.id);
    await writeFile(file, 'Verification side effect');
    return { id: 'fixture-process', projectId: f.project.id, sessionId: f.session.id, command: 'fixture-verification', cwd: f.folder, background: false, status: 'failed', output: 'Fixture test failed', exitCode: 1, startedAt: '', finishedAt: '', durationMs: 1 } as CommandProcess;
  });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  const run = (await f.workspace.getRun(f.run.id))!;
  assert.equal(runDetailed.mock.callCount(), 1); assert.equal(run.status, 'completed'); assert.equal(run.verification!.status, 'failed'); assert.equal(run.verification!.exitCode, 1);
  assert.equal(run.phase, 'final'); assert.ok(run.checkpointId); assert.deepEqual(run.changedFiles, [file]);
  assert.equal((await f.workspace.listCheckpoints(f.project.id, f.session.id))[0].runId, run.id);
});

test('Plan skips automatic verification and a stopped coordinator does not start naming', async t => {
  const f = await fixture(t); await f.workspace.updateSession(f.session.id, { mode: 'plan' }); await f.workspace.saveProject({ ...f.project, verificationCommand: 'fixture-verification' });
  const command = t.mock.method(f.workspace.commands, 'runDetailed', async () => { throw new Error('Plan must not execute'); });
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
  const signal = f.coordinator.begin(f.session.id); f.coordinator.stop(f.session.id); await f.coordinator.afterRun(f.session.id, signal); f.coordinator.end(f.session.id);
  assert.equal(command.mock.callCount(), 0); assert.equal(calls, 0); assert.equal(f.resolutions(), 0);
});
