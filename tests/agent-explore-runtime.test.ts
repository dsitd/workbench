import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { harnessFixture, reply, tool } from './agent-fixture';

const task = { sessionId: 's', text: 'Investigate the task runner and report findings.', attachmentIds: [] };
const explore = () => tool('parent-explore', 'explore_code', { task: 'Read README.md and explain the task runner.' });

test('parent runtime accounts delegated requests in its own journal and only persists the outer explore result', async () => {
  const f = harnessFixture({ inputPricePerMillion: 1, outputPricePerMillion: 2 });
  let requests = 0, executed = 0;
  f.deps.executeTool = async (call, context) => {
    executed++; assert.equal(call.id, 'child-read'); assert.equal(context.readOnly, true);
    return { text: 'Task runner source observed' };
  };
  await new AgentRuntime(f.deps, { fetch: async () => {
    const number = ++requests, usage = { prompt_tokens: number * 100, completion_tokens: number * 10, cost: number / 10000 };
    if (number === 1) return reply('', usage, 'tool_calls', [explore()]);
    if (number === 2) return reply('', usage, 'tool_calls', [tool('child-read')]);
    return reply(number === 3 ? 'The runner is described in README.md.' : 'Investigation completed.', usage);
  } }).run(task);
  const run = f.lastRun();
  assert.equal(run.status, 'completed'); assert.equal(requests, 4); assert.equal(executed, 1); assert.equal(run.steps, 4);
  assert.deepEqual(run.stepLog.map(step => step.index), [1, 2, 3, 4]);
  assert.deepEqual(run.stepLog.map(step => step.kind), ['agent', 'explore', 'explore', 'agent']);
  assert.deepEqual(run.stepLog.filter(step => step.kind === 'agent').map(step => step.assistantMessageId),
    f.messages.filter(message => message.role === 'assistant').map(message => message.id));
  assert.ok(run.stepLog.filter(step => step.kind === 'explore').every(step => step.assistantMessageId === undefined));
  assert.equal(run.usage.inputTokens, 1000); assert.equal(run.usage.outputTokens, 100); assert.ok(Math.abs(run.usage.costUsd! - 0.001) < 1e-12);
  assert.equal(f.messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(f.messages.find(message => message.role === 'tool')?.toolCallId, 'parent-explore');
  assert.equal(f.messages.some(message => message.toolCallId === 'child-read' || message.toolCalls?.some(call => call.id === 'child-read')), false);
});

test('delegation shares the parent step cap and never gets an independent run budget', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 2 } }); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? reply('', undefined, 'tool_calls', [explore()]) : reply('Delegated findings.') }).run(task);
  assert.equal(requests, 2); assert.equal(f.lastRun().steps, 2); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'steps');
  assert.equal(f.messages.filter(message => message.toolCallId === 'parent-explore').length, 1);
});

test('an over-budget child charge rejects a sibling parent write and preserves both announced result IDs', async () => {
  for (const reason of ['cost', 'tokens'] as const) {
    const f = harnessFixture({ inputPricePerMillion: 0.01, outputPricePerMillion: 0.02 },
      { runLimits: reason === 'cost' ? { maxCostUsd: 0.01 } : { maxTokens: 10000 } });
    let requests = 0, writes = 0;
    f.deps.executeTool = async call => { if (call.name === 'write_file') writes++; return { text: 'Unexpected mutation' }; };
    await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1
      ? reply('', { prompt_tokens: 10, completion_tokens: 10, cost: 0.0001 }, 'tool_calls', [explore(), tool('parent-write', 'write_file', { path: 'README.md', content: 'changed' })])
      : reply('Delegated findings.', { prompt_tokens: reason === 'tokens' ? 10000 : 10, completion_tokens: 10, cost: reason === 'cost' ? 1 : 0.0001 }) }).run(task);
    assert.equal(requests, 2); assert.equal(writes, 0); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, reason);
    const results = f.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.toolCallId), ['parent-explore', 'parent-write']); assert.equal(results[1].error, true);
    if (reason === 'cost') assert.ok(Math.abs(f.lastRun().usage.costUsd! - 1.0001) < 1e-12);
  }
});

test('submitted child failure preserves unknown-cost subtotal in the parent run exactly once', async () => {
  const f = harnessFixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    if (requests === 1) return reply('', { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }, 'tool_calls', [explore()]);
    if (requests === 2) throw new Error('Opaque transport failure');
    return reply('The investigation request failed.', { prompt_tokens: 100, completion_tokens: 10, cost: 0.003 });
  } }).run(task);
  const run = f.lastRun(); assert.equal(requests, 3); assert.equal(run.steps, 3); assert.equal(run.usage.unknownCostCalls, 1);
  assert.equal(run.usage.costSource, 'unknown'); assert.ok(Math.abs(run.usage.costUsd! - 0.004) < 1e-12);
  assert.equal(f.messages.filter(message => message.toolCallId === 'parent-explore').length, 1);
  assert.equal(JSON.stringify(f.messages).includes('Opaque'), false);
});
