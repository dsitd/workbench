import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { aggregateUsage, responseUsage, resolveLimits } from '../src/agent/journal';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply, tool } from './agent-fixture';

const task = { sessionId: 's', text: 'Read the selected README and finish.', attachmentIds: [] };

test('configured defaults allow more than the old 24 steps and persist every tool checkpoint', async () => {
  const f = harnessFixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++requests <= 25 ? reply('', { prompt_tokens: 10, completion_tokens: 5 }, 'tool_calls', [tool(`c${requests}`, 'read_file', { path: `section${requests}.md` })]) : reply('Finished', { prompt_tokens: 10, completion_tokens: 5 }) }).run(task);
  const run = f.lastRun();
  assert.equal(requests, 26); assert.equal(run.status, 'completed'); assert.equal(run.steps, 26);
  assert.equal(run.limits.maxSteps, 80); assert.equal(run.usage.inputTokens, 260); assert.equal(run.usage.tokenSource, 'reported');
  assert.equal(run.stepLog.length, 26); assert.ok(f.saved.some(item => item.checkpoint?.pendingToolCallIds?.length === 1));
  assert.deepEqual(run.checkpoint?.pendingToolCallIds, []); assert.ok(f.events.some(event => event.type === 'run'));
});

test('session limits override project/global and a one-step tool run finishes paired as limited', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 1 } }, { runLimits: { maxSteps: 2, maxTokens: 20000 } });
  f.deps.getSettings = async () => ({ ...defaultAppSettings, runLimits: { maxSteps: 3, maxTokens: 10000, maxCostUsd: 1, maxDurationMs: 20000 } });
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool()]) }).run(task);
  const run = f.lastRun(); assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'steps'); assert.equal(run.canContinue, true);
  assert.equal(run.limits.maxSteps, 1); assert.equal(run.limits.maxTokens, 20000);
  assert.equal(f.messages.filter(item => item.role === 'tool').length, 1); assert.deepEqual(run.checkpoint?.pendingToolCallIds, []);
  assert.match(f.messages.at(-1)!.content, /лимит 1 шагов/);
  assert.throws(() => resolveLimits(undefined, f.project, { ...f.session, runLimits: { maxSteps: -1 } }, {}), /бюджет/);
});

test('reserves input and output budget before making an unaffordable API request', async () => {
  for (const configuration of [{ maxTokens: 1000 }, { maxCostUsd: 0.001 }]) {
    const f = harnessFixture({ inputPricePerMillion: 2, outputPricePerMillion: 10 }, { runLimits: configuration }); let requests = 0;
    await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply(); } }).run(task);
    assert.equal(requests, 0); assert.equal(f.lastRun().status, 'limited');
    assert.equal(f.lastRun().limitReason, 'maxTokens' in configuration ? 'tokens' : 'cost');
  }
});

test('reported cost exhaustion prevents every announced side effect and pairs all tool IDs', async () => {
  const f = harnessFixture({ inputPricePerMillion: 1, outputPricePerMillion: 1 }, { runLimits: { maxCostUsd: 0.01 } }); let executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Unexpected' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('', { prompt_tokens: 20, completion_tokens: 10, cost: 0.02 }, 'tool_calls', [tool('one'), tool('two')]) }).run(task);
  assert.equal(executions, 0); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'cost');
  assert.equal(f.lastRun().usage.costUsd, 0.02); assert.equal(f.lastRun().usage.costSource, 'api');
  assert.deepEqual(f.messages.filter(item => item.role === 'tool').map(item => [item.toolCallId, item.error]), [['one', true], ['two', true]]);
});

test('usage distinguishes provider totals, estimates, mixed and unknown costs without NaN', async () => {
  const f = harnessFixture({ inputPricePerMillion: 1, outputPricePerMillion: 2 }); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? reply('', { prompt_tokens: 10, completion_tokens: 5, cost: 0.003 }, 'tool_calls', [tool()]) : reply('Done') }).run(task);
  assert.equal(f.lastRun().usage.tokenSource, 'mixed'); assert.equal(f.lastRun().usage.costSource, 'mixed'); assert.ok(f.lastRun().usage.costUsd! > 0.003);
  const unknown = responseUsage({ ...f.model, inputPricePerMillion: undefined, outputPricePerMillion: undefined }, { content: 'Reply', toolCalls: [], usage: { inputTokens: NaN, outputTokens: -1, costUsd: Infinity } }, 10);
  assert.equal(unknown.tokenSource, 'estimated'); assert.equal(unknown.costSource, 'unknown'); assert.equal(unknown.costUsd, undefined);
  assert.ok(Number.isFinite(unknown.inputTokens + unknown.outputTokens));
  const mixed = aggregateUsage(f.lastRun().usage, unknown); assert.equal(mixed.costSource, 'unknown'); assert.ok(Number.isFinite(mixed.costUsd));
});

test('output truncation preserves text and usage, never executes partial JSON, and is incomplete', async () => {
  const f = harnessFixture(); let executed = 0; f.deps.executeTool = async () => { executed++; return { text: 'Unexpected' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('Useful partial answer', { prompt_tokens: 10, completion_tokens: 30, cost: 0.001 }, 'length', [{ id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }]) }).run(task);
  assert.equal(executed, 0); assert.equal(f.session.status, 'error'); assert.equal(f.lastRun().status, 'incomplete'); assert.equal(f.lastRun().limitReason, 'output');
  assert.equal(f.lastRun().stepLog[0].finishReason, 'length'); assert.equal(f.lastRun().usage.outputTokens, 30);
  assert.match(f.messages.at(-1)!.content, /Useful partial answer/); assert.equal(f.messages.at(-1)!.error, true); assert.equal(f.messages.at(-1)!.toolCalls, undefined);
});

test('continuation keeps one original user, inherits plan and replays completed calls exactly', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 1 } }); let executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Already read' }; };
  const runtime = new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool('first')]) }); await runtime.run(task);
  const parent = f.lastRun(); parent.plan = [{ text: 'Inspect', status: 'completed' }, { text: 'Explain', status: 'pending' }]; parent.checkpointId = 'original-task-checkpoint'; f.runs.set(parent.id, parent);
  f.session.runLimits = { maxSteps: 2 }; const bodies: any[] = [];
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return reply('Explanation complete'); } }).resume('s', parent.id);
  assert.equal(executions, 1); assert.equal(f.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(f.lastRun().parentRunId, parent.id); assert.equal(f.lastRun().status, 'completed'); assert.deepEqual(f.lastRun().plan, parent.plan);
  assert.equal(f.lastRun().checkpointId, parent.checkpointId);
  assert.equal(bodies[0].messages.find((item: any) => item.role === 'tool').tool_call_id, 'first');
});

test('restart recovery pairs only missing calls with uncertain results and never repeats execution', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 1 } }); let executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Observed' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool('one'), tool('two')]) }).run(task);
  const parent = f.lastRun(); parent.status = 'interrupted'; parent.checkpoint!.pendingToolCallIds = ['two']; f.runs.set(parent.id, parent);
  f.messages.splice(3); const body: any[] = [];
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => { body.push(JSON.parse(String(init?.body))); return reply('Recovered without duplicate action'); } }).resume('s', parent.id);
  assert.equal(executions, 2); assert.equal(f.messages.filter(item => item.role === 'user').length, 1);
  const results = f.messages.filter(item => item.role === 'tool'); assert.deepEqual(results.map(item => item.toolCallId), ['one', 'two']); assert.equal(results[1].error, true);
  assert.match(results[1].content, /не повторено автоматически/); assert.equal(body[0].messages.filter((item: any) => item.role === 'tool').length, 2);
});

test('continuation refuses to attach an old run to a newer user task', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 1 } }); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool()]) }).run(task);
  const parent = f.lastRun(); f.messages.push({ id: 'new-user', role: 'user', content: 'A different task', createdAt: '' });
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply(); } }).resume('s', parent.id);
  assert.equal(requests, 0); assert.match(f.messages.at(-1)!.content, /уже отправлена новая/);
});

test('a checkpoint precedes the first write and its IDs reach all mutation contexts', async () => {
  const f = harnessFixture(); const order: string[] = []; let requests = 0;
  f.deps.createCheckpoint = async (_p, _s, _t, runId) => { assert.ok(f.runs.has(runId)); order.push('checkpoint'); return 'checkpoint-fixture'; };
  f.deps.executeTool = async (_call, context) => { order.push('write'); assert.equal(context.checkpointId, 'checkpoint-fixture'); assert.ok(context.runId); return { text: 'Saved' }; };
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? reply('', undefined, 'tool_calls', [tool('write', 'write_file', { path: 'one.txt', content: 'new' })]) : reply() }).run(task);
  assert.deepEqual(order, ['checkpoint', 'write']); assert.equal(f.lastRun().checkpointId, 'checkpoint-fixture'); assert.deepEqual(f.lastRun().changedFiles, ['one.txt']);
});

test('update_plan persists actual tool-supplied checklists in Plan without filesystem dispatch', async () => {
  const f = harnessFixture({}, { mode: 'plan' }); let requests = 0, executed = 0;
  f.deps.executeTool = async () => { executed++; return { text: 'Unexpected' }; };
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++; if (requests === 3) return reply('A concrete plan');
    return reply('', undefined, 'tool_calls', [tool(`plan-${requests}`, 'update_plan', { items: [{ text: 'Inspect selected files', status: requests === 1 ? 'running' : 'completed' }, { text: 'Describe implementation', status: 'pending' }] })]);
  } }).run(task);
  assert.equal(executed, 0); assert.equal(f.lastRun().plan![0].status, 'completed'); assert.equal(f.lastRun().plan![1].status, 'pending');
  assert.ok(f.saved.some(run => run.plan?.[0].status === 'running')); assert.equal(f.messages.filter(item => item.role === 'tool').length, 2);
});

test('journal failure after announcing calls stops dispatch while preserving each call/result pair', async () => {
  const f = harnessFixture(); let executed = 0;
  const save = f.deps.saveRun!; f.deps.saveRun = async run => { if (run.phase === 'tools') throw new Error('Artificial persistence failure'); await save(run); };
  f.deps.executeTool = async () => { executed++; return { text: 'Unexpected' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('', undefined, 'tool_calls', [tool('one'), tool('two')]) }).run(task);
  assert.equal(executed, 0); assert.equal(f.session.status, 'error'); assert.deepEqual(f.messages.filter(item => item.role === 'tool').map(item => item.toolCallId), ['one', 'two']);
  assert.equal(f.lastRun().status, 'error');
});

test('run duration cancels an in-flight HTTP request and classifies it as a duration limit', { timeout: 12000 }, async () => {
  const f = harnessFixture({}, { runLimits: { maxDurationMs: 10000 } }); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => { requests++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })); } }).run(task);
  assert.equal(requests, 1); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'duration'); assert.equal(f.lastRun().canContinue, true); assert.equal(f.session.status, 'error');
});
