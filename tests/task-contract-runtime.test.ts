import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { completionResult, executeTaskTool } from '../src/agent/task-contract';
import { harnessFixture, reply, tool } from './agent-fixture';
import { OperationPendingError } from '../src/shared/task-evidence';

test('explicit user criteria prevent a text-only false completion and retain paired feedback', async () => {
  const fixture = harnessFixture();
  const runtime = new AgentRuntime(fixture.deps, { fetch: async () => reply('Claimed done'), maxSteps: 8 });
  await runtime.run({ sessionId: 's', text: 'Acceptance criteria:\n- The requested file exists', attachmentIds: [] });
  assert.equal(fixture.lastRun().status, 'error'); assert.equal(fixture.lastRun().acceptanceCriteria?.length, 1);
  const declarations = fixture.messages.flatMap(message => message.toolCalls ?? []).filter(call => call.name === 'check_completion');
  assert.equal(declarations.length, 3);
  for (const call of declarations) assert.equal(fixture.messages.filter(message => message.role === 'tool' && message.toolCallId === call.id).length, 1);
});
test('matching fresh observations satisfy a registered criterion; a generic completion claim does not', async () => {
  const fixture = harnessFixture(); let request = 0;
  fixture.deps.executeTool = async () => ({ text: 'Observed requested content' });
  const runtime = new AgentRuntime(fixture.deps, { fetch: async () => {
    if (request++ === 0) return reply('', undefined, 'tool_calls', [loadCriteria()]);
    if (request === 2) return reply('', undefined, 'tool_calls', [
      tool('criteria', 'set_task_criteria', { criteria: [{ id: 'content', text: 'Check the requested content', sourceQuote: 'requested content', toolName: 'read_file', expectedText: 'Observed requested content' }] }),
      tool('read', 'read_file', { path: 'file.txt' }), tool('evidence', 'record_task_evidence', { criterionId: 'content', toolCallId: 'read' }),
    ]);
    return reply('Verified the requested content');
  } });
  await runtime.run({ sessionId: 's', text: 'Inspect requested content', attachmentIds: [] });
  assert.equal(fixture.lastRun().status, 'completed'); assert.equal(completionResult(fixture.lastRun()).error, false);
  assert.equal(fixture.lastRun().acceptanceCriteria?.[0].evidence?.toolCallId, 'read');
  const narrowed = structuredClone(fixture.lastRun()); narrowed.evidenceScope = 'changed';
  assert.equal(completionResult(narrowed).error, true);
});
test('later mutations stale evidence; failed or invented observations cannot satisfy a criterion', async () => {
  const fixture = harnessFixture(); let request = 0;
  fixture.deps.executeTool = async call => ({ text: call.name === 'read_file' ? 'Observed requested content' : 'saved' });
  const runtime = new AgentRuntime(fixture.deps, { fetch: async () => {
    if (request++ === 0) return reply('', undefined, 'tool_calls', [loadCriteria()]);
    return request === 2 ? reply('', undefined, 'tool_calls', [
    tool('criteria', 'set_task_criteria', { criteria: [{ id: 'content', text: 'Check requested content', sourceQuote: 'requested content', toolName: 'read_file', expectedText: 'Observed requested content' }] }),
    tool('read', 'read_file', { path: 'file.txt' }), tool('evidence', 'record_task_evidence', { criterionId: 'content', toolCallId: 'read' }), tool('write', 'write_file', { path: 'file.txt', content: 'changed' }),
    ]) : reply('Done');
  } });
  await runtime.run({ sessionId: 's', text: 'Change requested content', attachmentIds: [] });
  const run = fixture.lastRun(); assert.equal(run.status, 'error'); assert.equal(completionResult(run).error, true);
  assert.throws(() => executeTaskTool(toolCall('record_task_evidence', { criterionId: 'content', toolCallId: 'invented' }), run, fixture.messages), /успешный/);
  assert.throws(() => executeTaskTool(toolCall('set_task_criteria', { criteria: [{ id: 'content', text: 'weaker', sourceQuote: 'requested content' }] }), run, fixture.messages), /переписать/);
});
test('task note schemas load on demand and sourced notes appear in the next bounded context', async () => {
  const fixture = harnessFixture(); let request = 0, nextRequest = '';
  const runtime = new AgentRuntime(fixture.deps, { fetch: async (_url, init) => {
    if (request++ === 0) {
      assert.doesNotMatch(String(init?.body), /"name":"record_task_note"/);
      return reply('', undefined, 'tool_calls', [tool('load', 'load_task_tools', { names: ['record_task_note'] })]);
    }
    if (request === 2) return reply('', undefined, 'tool_calls', [tool('note', 'record_task_note', { text: 'Sourced decision for continuation', kind: 'decision', sourceMessageIds: [fixture.messages[0].id] })]);
    nextRequest = String(init?.body); return reply('Done');
  } });
  await runtime.run({ sessionId: 's', text: 'Inspect the project', attachmentIds: [] });
  assert.equal(fixture.lastRun().status, 'completed'); assert.equal(request, 3); assert.match(nextRequest, /Sourced decision for continuation/);
});
function loadCriteria() { return tool('load', 'load_task_tools', { names: ['set_task_criteria', 'record_task_evidence'] }); }
test('an uncertain earlier effect blocks a new run from claiming completion after a rejected duplicate', async () => {
  const fixture = harnessFixture(); let step = 0, executions = 0;
  fixture.deps.beginOperation = async () => { throw new OperationPendingError({ id: 'op-existing', toolName: 'write_file', toolCallId: 'prior-call', status: 'uncertain' }); };
  fixture.deps.executeTool = async () => { executions++; return { text: 'unexpected' }; };
  await new AgentRuntime(fixture.deps, { fetch: async () => step++ === 0 ? reply('', undefined, 'tool_calls', [tool('retry', 'write_file', { path: 'file.txt', content: 'same' })]) : reply('Done') }).run({ sessionId: 's', text: 'Write the file', attachmentIds: [] });
  assert.equal(executions, 0); assert.equal(fixture.lastRun().status, 'error'); assert.equal(fixture.lastRun().operations?.[0].status, 'uncertain');
  assert.match(fixture.messages.find(message => message.toolCallId === 'retry')!.content, /op-existing/);
});
test('resume restores a saved receipt or uncertain operation even when the run journal missed its operation entry', async () => {
  for (const status of ['confirmed', 'failed', 'uncertain'] as const) {
    const fixture = harnessFixture({ baseUrl: 'https://api.openai.com/v1' }); let executions = 0;
    fixture.deps.tools[1] = { name: 'write_file', permission: 'write', description: 'Fixture', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, label: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } };
    fixture.messages.push({ id: 'u', role: 'user', content: 'Write the file', createdAt: '' }, { id: 'a', role: 'assistant', content: '', createdAt: '', toolCalls: [{ id: 'effect', name: 'write_file', arguments: { path: 'file.txt', content: 'same', label: null } }] });
    fixture.runs.set('parent', { id: 'parent', projectId: 'p', sessionId: 's', modelId: 'm', status: 'interrupted', phase: 'final', startedAt: '', steps: 1, stepLog: [], limits: {}, canContinue: true, mutationRevision: 1, checkpoint: { userMessageId: 'u', assistantMessageId: 'a', pendingToolCallIds: ['effect'] }, usage: { inputTokens: 0, outputTokens: 0, tokenSource: 'reported', costSource: 'unknown' } });
    fixture.deps.recoverOperation = async (call, context) => {
      assert.equal(context.assistantMessageId, 'a'); assert.equal(call.arguments.label, undefined);
      return { id: 'op-recovered', projectId: 'p', sessionId: 's', toolCallId: 'effect', toolName: 'write_file', fingerprint: 'fixture', scope: 'fixture', status, startedAt: '', updatedAt: '' };
    };
    fixture.deps.recoverToolResult = async () => status !== 'uncertain' ? { text: 'Durable saved receipt', error: status === 'failed' } : undefined;
    fixture.deps.executeTool = async () => { executions++; return { text: 'unexpected' }; };
    await new AgentRuntime(fixture.deps, { fetch: async () => reply('Done') }).resume('s', 'parent');
    assert.equal(executions, 0); assert.equal(fixture.lastRun().status, status !== 'uncertain' ? 'completed' : 'error');
    const recovered = fixture.messages.filter(message => message.toolCallId === 'effect');
    assert.equal(recovered.length, 1); assert.equal(Boolean(recovered[0].error), status !== 'confirmed');
    assert.equal(fixture.lastRun().operations?.[0].status, status);
  }
});
function toolCall(name: string, arguments_: Record<string, unknown>) { return { id: 'direct', name, arguments: arguments_ }; }

test('unbound user criteria reject unrelated observations and legacy unbound evidence', async () => {
  const { initialCriteria, observeTaskTool } = await import('../src/agent/task-contract');
  const fixture = harnessFixture();
  await new AgentRuntime(fixture.deps, { fetch: async () => reply('Done') }).run({ sessionId: 's', text: 'Acceptance criteria:\nThe requested migration is applied', attachmentIds: [] });
  const run = fixture.lastRun();
  run.acceptanceCriteria = initialCriteria(fixture.messages[0]);
  const observed = { id: 'unrelated', role: 'tool' as const, toolName: 'read_file', toolCallId: 'read-readme', content: 'Unrelated README text', createdAt: '' };
  observeTaskTool(run, observed);
  assert.throws(() => executeTaskTool(toolCall('record_task_evidence', { criterionId: 'criterion_1', toolCallId: 'read-readme' }), run, [...fixture.messages, observed]), /toolName.*expectedText/);
  run.acceptanceCriteria[0].evidence = { toolCallId: 'read-readme', messageId: 'unrelated', revision: run.mutationRevision ?? 0, scope: run.evidenceScope, recordedAt: '' };
  assert.equal(completionResult(run).error, true);
});
