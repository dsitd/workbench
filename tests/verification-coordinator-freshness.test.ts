import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { RunCoordinator } from '../src/main/run-coordinator';
import { AgentRuntime } from '../src/agent';
import type { CredentialVault } from '../src/main/credentials';
import type { CommandProcess, RunRecord, VerificationResult } from '../src/shared/types';
import { fixtureModel, harnessFixture, reply, tool } from './agent-fixture';

async function coordinatorFixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-verification-freshness-')));
  const folder = path.join(root, 'project'); await mkdir(folder);
  const workspace = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => undefined });
  await workspace.bootstrap();
  const settings = await workspace.getSettings();
  await workspace.saveSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: false } });
  const model = await workspace.saveModel(fixtureModel);
  const created = await workspace.createProject({ name: 'Verification fixture', folders: [{ path: folder, access: 'write' }] });
  const project = await workspace.saveProject({ ...created, verificationCommand: 'fixture-verification' });
  const session = await workspace.createSession(project.id, model.id);
  const run: RunRecord = { id: 'legacy-run', projectId: project.id, sessionId: session.id, modelId: model.id,
    kind: 'agent', status: 'completed', phase: 'final', startedAt: new Date().toISOString(), steps: 1, stepLog: [],
    usage: { inputTokens: 10, outputTokens: 5, tokenSource: 'reported', costSource: 'unknown' }, limits: {} };
  await workspace.saveRun(run);
  const vault = { resolve: async () => { throw new Error('Paid API credentials must not be resolved by verification tests.'); } } as unknown as CredentialVault;
  const coordinator = new RunCoordinator(workspace, vault, () => undefined);
  t.after(async () => { coordinator.stopAll(); await workspace.commands.close(); await rm(root, { recursive: true, force: true }); });
  return { folder, workspace, project, session, run, coordinator };
}

function processResult(f: Awaited<ReturnType<typeof coordinatorFixture>>, passed: boolean): CommandProcess {
  return { id: 'fixture-process', projectId: f.project.id, sessionId: f.session.id, command: 'fixture-verification', cwd: f.folder,
    background: false, status: passed ? 'completed' : 'failed', output: passed ? 'Fixture check passed' : 'Fixture check failed',
    exitCode: passed ? 0 : 1, startedAt: '', finishedAt: '' };
}

for (const passed of [true, false]) test(`unchanged legacy completed run is verified once across repeated afterRun calls (${passed ? 'passed' : 'failed'})`, async t => {
  const f = await coordinatorFixture(t);
  const command = t.mock.method(f.workspace.commands, 'runDetailed', async () => processResult(f, passed));
  const api = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external API call'); });
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  const initial = (await f.workspace.getRun(f.run.id))!;
  assert.equal(initial.verification?.status, passed ? 'passed' : 'failed');
  assert.equal(initial.verifiedRevision, initial.mutationRevision ?? 0);
  assert.equal(initial.status, 'completed', 'legacy model completion and the separate check outcome remain distinguishable');
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  const repeated = (await f.workspace.getRun(f.run.id))!;
  assert.equal(command.mock.callCount(), 1);
  assert.equal(api.mock.callCount(), 0);
  assert.equal(repeated.verification?.id, initial.verification?.id);
});

test('explicit manual verification reruns a fresh check and subsequent automatic coordination reuses it', async t => {
  const f = await coordinatorFixture(t);
  const command = t.mock.method(f.workspace.commands, 'runDetailed', async () => processResult(f, true));
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  const initial = (await f.workspace.getRun(f.run.id))!;
  const manual = await f.coordinator.verify(f.session.id, f.run.id, new AbortController().signal);
  assert.equal(manual.status, 'passed');
  assert.notEqual(manual.id, initial.verification?.id);
  assert.equal(command.mock.callCount(), 2);
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal(command.mock.callCount(), 2);
  const final = (await f.workspace.getRun(f.run.id))!;
  assert.equal(final.verification?.id, manual.id);
  assert.equal(final.checkpointId, initial.checkpointId);
});

for (const foreignField of ['runId', 'projectId', 'sessionId'] as const) test(`automatic coordination rechecks otherwise fresh cached evidence with a foreign ${foreignField}`, async t => {
  const f = await coordinatorFixture(t);
  const foreign: VerificationResult = { id: 'foreign-cached-result', runId: f.run.id, projectId: f.project.id, sessionId: f.session.id,
    command: f.project.verificationCommand!, cwd: f.folder, status: 'passed', output: 'Unrelated check passed', exitCode: 0,
    startedAt: '', [foreignField]: 'foreign-owner' };
  await f.workspace.saveRun({ ...f.run, mutationRevision: 0, verifiedRevision: 0, verification: foreign });
  const command = t.mock.method(f.workspace.commands, 'runDetailed', async () => processResult(f, true));
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal(command.mock.callCount(), 1, 'foreign evidence must not suppress verification of this task');
  const checked = (await f.workspace.getRun(f.run.id))!;
  assert.notEqual(checked.verification?.id, foreign.id);
  assert.equal(checked.verification?.runId, f.run.id);
  assert.equal(checked.verification?.projectId, f.project.id);
  assert.equal(checked.verification?.sessionId, f.session.id);
  await f.coordinator.afterRun(f.session.id, new AbortController().signal);
  assert.equal(command.mock.callCount(), 1, 'the replacement evidence belongs to this task and can be reused');
});

for (const foreignField of ['projectId', 'sessionId'] as const) test(`in-loop verification refuses to attach evidence from a foreign ${foreignField}`, async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' });
  f.deps.verifyRun = async run => ({ id: 'foreign-result', runId: run.id, projectId: run.projectId, sessionId: run.sessionId,
    command: 'fixture-check', cwd: f.project.folders[0].path, status: 'passed', output: 'Foreign check passed', exitCode: 0,
    startedAt: '', [foreignField]: 'foreign-owner' });
  const runtime = new AgentRuntime(f.deps, { maxSteps: 1,
    fetch: async () => reply('Checking', undefined, 'tool_calls', [tool('verification-call', 'verify_project', {})]) });
  await runtime.run({ sessionId: f.session.id, text: 'Verify focus support', attachmentIds: [] });
  assert.equal(f.lastRun().verification, undefined);
  assert.equal(f.lastRun().verificationHistory, undefined);
  assert.notEqual(f.lastRun().status, 'completed');
  const results = f.messages.filter(message => message.role === 'tool' && message.toolCallId === 'verification-call');
  assert.equal(results.length, 1);
  assert.equal(results[0].error, true);
  assert.match(results[0].content, /не соответствует текущей задаче/);
});

test('a mutation that throws after a side effect invalidates prior evidence and receives exactly one result', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' });
  let checks = 0, sideEffect = false;
  f.deps.verifyRun = async run => ({ id: `check-${++checks}`, runId: run.id, projectId: run.projectId, sessionId: run.sessionId,
    command: 'fixture-check', cwd: f.project.folders[0].path, status: 'passed', output: 'Focus check passed', exitCode: 0, startedAt: '' } satisfies VerificationResult);
  f.deps.executeTool = async () => { sideEffect = true; throw new Error('Fixture write failed after its side effect.'); };
  const responses = [reply('Checking', undefined, 'tool_calls', [tool('initial-check', 'verify_project', {})]),
    reply('Editing', undefined, 'tool_calls', [tool('uncertain-write', 'write_file', { path: 'focus.ts', content: 'updated' })]), reply('Done')];
  const runtime = new AgentRuntime(f.deps, { maxSteps: 6, fetch: async () => {
    const response = responses.shift(); assert.ok(response, 'the run must finish without another model request'); return response;
  } });
  await runtime.run({ sessionId: f.session.id, text: 'Fix focus support', attachmentIds: [] });
  assert.equal(sideEffect, true);
  assert.equal(checks, 2);
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().verifiedRevision, f.lastRun().mutationRevision);
  const results = f.messages.filter(message => message.role === 'tool' && message.toolCallId === 'uncertain-write');
  assert.equal(results.length, 1);
  assert.equal(results[0].error, true);
});
