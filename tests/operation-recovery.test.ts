import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationStore } from '../src/backend/operations';
import { accessScope } from '../src/shared/task-evidence';
import type { ChatMessage, ToolContext } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-operations-')));
  const messages: ChatMessage[] = []; let approvals = 0;
  const approve = async () => { approvals++; return true; };
  const store = new OperationStore(directory, approve, async () => messages);
  const context: ToolContext = { project: { id: 'p', name: 'P', folders: [{ path: directory, access: 'write' }], commandPolicy: 'ask', internet: false, instructions: '', createdAt: '', updatedAt: '' }, sessionId: 's', runId: 'run', signal: new AbortController().signal };
  t.after(() => rm(directory, { recursive: true, force: true })); return { directory, store, context, messages, approve, approvals: () => approvals };
}
test('confirmed receipt replays after restart and never repeats the actual effect', async t => {
  const { directory, store, context, messages, approve } = await fixture(t);
  const call = { id: 'create', name: 'mcp_fixture_create', arguments: { value: 1 } }; let effects = 0;
  const first = await store.begin(call, context); if (!first.cachedResult) effects++;
  await store.finish(first.operation.id, { text: 'record-123' });
  const restarted = new OperationStore(directory, approve, async () => messages); await restarted.recover();
  const next = await restarted.begin(call, context); if (!next.cachedResult) effects++;
  assert.equal(effects, 1); assert.equal(next.cachedResult?.text, 'record-123');
  assert.equal((await restarted.recoveredResult(call, context))?.text, 'record-123');
  await assert.rejects(restarted.begin({ ...call, arguments: { value: 2 } }, context), /different arguments/);
});
test('a crash before receipt persistence blocks identical effects under a new call ID', async t => {
  const { directory, store, context, messages, approve } = await fixture(t);
  const call = { id: 'create', name: 'mcp_fixture_create', arguments: { value: 1 } };
  const started = await store.begin(call, context);
  const restarted = new OperationStore(directory, approve, async () => messages); await restarted.recover();
  assert.equal(JSON.parse((await restarted.inspect(started.operation.id, context)).text).status, 'uncertain');
  await assert.rejects(restarted.begin({ ...call, id: 'retry' }, context), /uncertain external effect/);
  await assert.rejects(restarted.inspect(started.operation.id, { ...context, sessionId: 'other' }), /unavailable/);
});
test('provider call ID reuse in a new assistant turn is a new deliberate action, while replay uses the original identity', async t => {
  const { store, context } = await fixture(t);
  const call = { id: 'provider-reused', name: 'write_file', arguments: { path: 'file.txt', content: 'same' } };
  const first = await store.begin(call, { ...context, assistantMessageId: 'assistant-1' }); await store.finish(first.operation.id, { text: 'saved' });
  assert.ok((await store.begin(call, { ...context, assistantMessageId: 'assistant-1' })).cachedResult);
  const next = await store.begin(call, { ...context, assistantMessageId: 'assistant-2' });
  assert.equal(next.cachedResult, undefined); assert.notEqual(next.operation.id, first.operation.id);
});
test('fresh readback reconciles an existing effect; retry release requires explicit authorization', async t => {
  const { store, context, messages, approvals } = await fixture(t);
  const call = { id: 'write', name: 'write_file', arguments: { path: 'file.txt', content: 'fixture' } };
  const started = await store.begin(call, context); await store.finish(started.operation.id, { text: 'interrupted', error: true });
  await assert.rejects(store.reconcile(started.operation.id, 'not-executed', 'invented', context), /successful fresh/);
  messages.push({ id: 'observed', role: 'tool', toolName: 'read_file', toolCallId: 'read', content: 'Observed state', createdAt: new Date().toISOString(), accessScope: accessScope(context.project) });
  await store.reconcile(started.operation.id, 'not-executed', 'read', context); assert.equal(approvals(), 1);
  const retry = await store.begin({ ...call, id: 'retry' }, context); assert.equal(retry.operation.status, 'running');
});
test('declined reconciliation preserves the uncertainty guard even in Bypass', async t => {
  const { directory, context, messages } = await fixture(t);
  const store = new OperationStore(directory, async () => false, async () => messages);
  const call = { id: 'write', name: 'write_file', arguments: {} }, started = await store.begin(call, context); await store.finish(started.operation.id, { text: 'interrupted', error: true });
  messages.push({ id: 'observed', role: 'tool', toolName: 'read_file', toolCallId: 'read', content: 'State', createdAt: new Date().toISOString(), accessScope: accessScope(context.project) });
  await assert.rejects(store.reconcile(started.operation.id, 'not-executed', 'read', { ...context, mode: 'bypass' }), /declined/);
  assert.equal(JSON.parse((await store.inspect(started.operation.id, context)).text).status, 'uncertain');
});

test('finalization and tool discovery receipts cannot reconcile an uncertain effect', async t => {
  const { store, context, messages, approvals } = await fixture(t);
  const started = await store.begin({ id: 'write', name: 'write_file', arguments: {} }, context);
  await store.finish(started.operation.id, { text: 'interrupted', error: true });
  for (const name of ['finish_task', 'load_workspace_tools', 'record_task_note', 'check_completion']) {
    messages.push({ id: name, role: 'tool', toolName: name, toolCallId: name, content: 'Success', createdAt: new Date().toISOString(), accessScope: accessScope(context.project) });
    await assert.rejects(store.reconcile(started.operation.id, 'confirmed', name, context), /successful fresh/);
  }
  assert.equal(approvals(), 0);
  assert.equal(JSON.parse((await store.inspect(started.operation.id, context)).text).status, 'uncertain');
});

test('observed nonzero command exits replay a failed receipt and permit deliberate retry', async t => {
  const { store, context } = await fixture(t);
  const call = { id: 'command', name: 'run_command', arguments: { command: 'exit 1' } };
  const first = await store.begin(call, context);
  const receipt = { text: 'Exit 1', error: true, commandExit: { code: 1 } };
  assert.equal((await store.finish(first.operation.id, receipt)).status, 'failed');
  assert.deepEqual((await store.begin(call, context)).cachedResult, receipt);
  assert.deepEqual(await store.recoveredResult(call, context), receipt);
  assert.equal((await store.begin({ ...call, id: 'retry' }, context)).operation.status, 'running');
});

test('an error string or non-command receipt cannot declare a known failed execution', async t => {
  const { store, context } = await fixture(t);
  for (const name of ['run_command', 'mcp_fixture_create']) {
    const first = await store.begin({ id: name, name, arguments: {} }, context);
    const receipt = name === 'run_command' ? { text: 'Exit 1', error: true } : { text: 'Exit 1', error: true, commandExit: { code: 1 } };
    assert.equal((await store.finish(first.operation.id, receipt)).status, 'uncertain');
  }
});
