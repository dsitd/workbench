import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { harnessFixture, reply, tool } from './agent-fixture';
import type { VerificationResult } from '../src/shared/types';
import { OperationPendingError } from '../src/shared/task-evidence';

test('automatically loaded operation helpers remain stable after reconciliation', async () => {
  const f = harnessFixture();
  f.deps.tools.push(...['get_operation', 'reconcile_operation'].map(name => ({ name, description: name, permission: 'read' as const, parameters: { type: 'object' } })));
  f.deps.beginOperation = async () => { throw new OperationPendingError({ id: 'pending', toolName: 'write_file', toolCallId: 'prior', status: 'uncertain' }); };
  f.deps.operationStates = async () => [{ id: 'pending', toolName: 'write_file', toolCallId: 'prior', status: 'confirmed' }];
  const catalogs: string[][] = [];
  await new AgentRuntime(f.deps, { maxSteps: 3, fetch: async (_url, init) => {
    catalogs.push(JSON.parse(String(init?.body)).tools.map((entry: any) => entry.function.name));
    return catalogs.length === 1 ? reply('', undefined, 'tool_calls', [tool('write', 'write_file', {})]) : reply('Check pending criterion');
  } }).run({ sessionId: 's', text: 'Acceptance criteria:\nA separate artifact was inspected', attachmentIds: [] });
  assert.equal(catalogs[0].includes('get_operation'), false);
  assert.equal(catalogs[1].includes('get_operation'), true);
  assert.equal(catalogs[2].includes('get_operation'), true, 'Do not remove schemas merely because the operation was reconciled');
  assert.notEqual(f.lastRun().status, 'completed', 'Stable tool metadata must not waive unfinished acceptance');
});

function fixture(failFirst = false) {
  const f = harnessFixture({}, {}, { verificationCommand: 'check' });
  let checks = 0;
  f.deps.verifyRun = async run => {
    const failed = failFirst && checks === 0; checks++;
    return { runId: run.id, projectId: 'p', sessionId: 's', command: 'check', cwd: f.project.folders[0].path,
      status: failed ? 'failed' : 'passed', exitCode: failed ? 1 : 0, output: failed ? 'Repair needed' : 'ok' } as VerificationResult;
  };
  return { ...f, checks: () => checks };
}

test('finish_task hands off to the existing verification gate without another model call', async () => {
  const f = fixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++requests === 1) return reply('', undefined, 'tool_calls', [tool('write', 'write_file', { path: 'a.txt', content: 'changed' })]);
    if (requests === 2) return reply('', undefined, 'tool_calls', [tool('finish', 'finish_task', { summary: 'Implemented the requested change.' })]);
    throw new Error('No extra model round-trip should be necessary');
  } }).run({ sessionId: 's', text: 'Implement this change and run configured checks.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().verification?.status, 'passed');
  assert.equal(requests, 2); assert.equal(f.checks(), 1);
  assert.equal(f.messages.at(-1)?.content, 'Implemented the requested change.');
  assert.equal(f.messages.filter(m => m.toolCallId === 'finish').length, 1);
});

test('finish_task cannot bypass a failed check, and its summary is withheld until acceptance', async () => {
  const f = fixture(true); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++requests === 1) return reply('', undefined, 'tool_calls', [tool('first', 'finish_task', { summary: 'Premature summary' })]);
    if (requests === 2) return reply('', undefined, 'tool_calls', [tool('repair', 'write_file', { path: 'a.txt', content: 'fixed' })]);
    if (requests === 3) return reply('', undefined, 'tool_calls', [tool('last', 'finish_task', { summary: 'Repaired and checked.' })]);
    throw new Error('Unexpected request');
  } }).run({ sessionId: 's', text: 'Implement and verify.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed'); assert.equal(f.checks(), 2);
  assert.equal(f.messages.some(m => m.role === 'assistant' && m.content === 'Premature summary'), false);
  assert.equal(f.messages.at(-1)?.content, 'Repaired and checked.');
});

test('a finalization request is not evidence for an unmet explicit criterion', async () => {
  const f = fixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool(`finish-${++requests}`, 'finish_task', { summary: 'Done' })]) })
    .run({ sessionId: 's', text: 'Acceptance criteria:\nA separate artifact was inspected', attachmentIds: [] });
  assert.notEqual(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().acceptanceCriteria?.[0].evidence, undefined);
  assert.equal(f.lastRun().toolObservations?.some(item => item.toolName === 'finish_task'), false);
});

test('finish_task in a mixed batch is rejected while every other call still gets a result', async () => {
  const f = fixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1
    ? reply('', undefined, 'tool_calls', [tool('finish', 'finish_task', { summary: 'Premature' }), tool('write', 'write_file', { path: 'a.txt', content: 'changed' })])
    : reply('Final answer') }).run({ sessionId: 's', text: 'Implement the change.', attachmentIds: [] });
  assert.equal(f.messages.find(m => m.toolCallId === 'finish')?.error, true);
  for (const id of ['finish','write']) assert.equal(f.messages.filter(m => m.toolCallId === id).length, 1);
  assert.equal(f.messages.some(m => m.role === 'assistant' && m.content === 'Premature'), false);
});

test('finish_task rechecks mutations after a previous passing verification', async () => {
  const f = fixture(); let requests = 0;
  const calls = [tool('check', 'verify_project', {}), tool('edit', 'write_file', { path: 'a.txt', content: 'changed' }), tool('finish', 'finish_task', { summary: 'Checked the final version.' })];
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [calls[requests++]]) })
    .run({ sessionId: 's', text: 'Implement and verify.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed'); assert.equal(f.checks(), 2);
  assert.equal(f.lastRun().verifiedRevision, f.lastRun().mutationRevision);
});

test('finish_task cannot bypass an uncertain operation or a failed completion hook', async () => {
  for (const blocker of ['operation', 'hook']) {
    const f = fixture(); let requests = 0;
    f.deps.beginOperation = async () => { throw new OperationPendingError({ id: 'pending', toolName: 'write_file', toolCallId: 'prior', status: 'uncertain' }); };
    await new AgentRuntime(f.deps, {
      hooks: blocker === 'hook' ? [{ beforeComplete: () => { throw new Error('Acceptance hook failed'); } }] : [],
      fetch: async () => reply('', undefined, 'tool_calls', [blocker === 'operation' && ++requests === 1
        ? tool('edit', 'write_file', { path: 'a.txt', content: 'changed' })
        : tool(`finish-${requests++}`, 'finish_task', { summary: 'Not accepted yet.' })]),
    }).run({ sessionId: 's', text: 'Implement and verify.', attachmentIds: [] });
    assert.notEqual(f.lastRun().status, 'completed', blocker);
    assert.equal(f.messages.some(m => m.role === 'assistant' && m.content === 'Not accepted yet.'), false, blocker);
  }
});

test('a reconciled operation is no longer presented to the model as uncertain on the next step', async () => {
  const f = harnessFixture();
  f.deps.tools.push(...['get_operation', 'reconcile_operation'].map(name => ({ name, description: name, permission: 'read' as const, parameters: { type: 'object' } })));
  let status: 'uncertain' | 'confirmed' = 'uncertain';
  f.deps.beginOperation = async () => { throw new OperationPendingError({ id: 'pending', toolName: 'write_file', toolCallId: 'prior', status: 'uncertain' }); };
  f.deps.operationStates = async () => [{ id: 'pending', toolName: 'write_file', toolCallId: 'prior', status }];
  f.deps.executeTool = async call => { if (call.name === 'reconcile_operation') status = 'confirmed'; return { text: 'Observed state' }; };
  const bodies: string[] = [];
  await new AgentRuntime(f.deps, { maxSteps: 4, fetch: async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? reply('', undefined, 'tool_calls', [tool('write', 'write_file', {})])
      : bodies.length === 2 ? reply('', undefined, 'tool_calls', [tool('rec', 'reconcile_operation', { operationId: 'pending', outcome: 'confirmed', evidenceToolCallId: 'x' })])
      : reply('Done');
  } }).run({ sessionId: 's', text: 'Do the task', attachmentIds: [] });
  assert.match(bodies[1], /uncertainOperations/, 'the pending operation is shown while it is uncertain');
  assert.doesNotMatch(bodies[2], /uncertainOperations/, 'stale journal status must not survive a reconciliation');
  assert.equal(f.lastRun().operations?.[0]?.status, 'confirmed');
});
