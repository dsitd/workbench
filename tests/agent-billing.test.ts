import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { harnessFixture, reply, tool } from './agent-fixture';

const task = { sessionId: 's', text: 'Read README and finish.', attachmentIds: [] };

test('payment rejection stops as a cost limit without retry, body disclosure or unknown charge', async () => {
  const f = harnessFixture(); let calls = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    calls++; return new Response('untrusted server echo must stay private', { status: 402 });
  } }).run(task);
  assert.equal(calls, 1);
  assert.equal(f.lastRun().status, 'limited');
  assert.equal(f.lastRun().limitReason, 'cost');
  assert.equal(f.lastRun().usage.unknownCostCalls, undefined);
  assert.doesNotMatch(f.lastRun().error ?? '', /untrusted server echo|частоту запросов/);
  assert.match(f.lastRun().error ?? '', /денежного лимита/);
});

test('a duration stop preserves API billing already delivered by the stream', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = harnessFixture({}, { runLimits: { maxDurationMs: 10000 } });
  let received!: () => void;
  const firstFrame = new Promise<void>(resolve => { received = resolve; });
  const emit = f.deps.emit;
  f.deps.emit = event => { emit(event); if (event.type === 'delta') received(); };
  const runtime = new AgentRuntime(f.deps, { fetch: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
        choices: [{ delta: { content: 'Partial answer '.repeat(100) } }],
        usage: { prompt_tokens: 27, completion_tokens: 4, cost: 0.0123 },
      }) + '\n\n'));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const running = runtime.run(task);
  await firstFrame;
  context.mock.timers.tick(10000);
  await running;
  const run = f.lastRun();
  assert.equal(run.status, 'limited'); assert.equal(run.limitReason, 'duration');
  assert.equal(run.usage.costUsd, 0.0123); assert.equal(run.usage.costSource, 'api');
  assert.equal(run.usage.unknownCostCalls, undefined);
  assert.equal(run.usage.inputTokens, 27); assert.equal(run.usage.outputTokens, 4);
  assert.equal(run.stepLog[0].costUsd, 0.0123);
});

test('a submitted failed request marks the preceding API subtotal incomplete', async () => {
  const f = harnessFixture(); let calls = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++calls === 1) return reply('', { prompt_tokens: 20, completion_tokens: 5, cost: 0.003 }, 'tool_calls', [tool()]);
    throw new Error('Artificial connection failure after submission');
  } }).run(task);
  const run = f.lastRun();
  assert.equal(calls, 2); assert.equal(run.status, 'error');
  assert.equal(run.usage.costUsd, 0.003);
  assert.equal(run.usage.costSource, 'unknown');
  assert.equal(run.usage.unknownCostCalls, 1);
});

test('preflight budgets and credential failures do not claim uncertain API charges', async () => {
  for (const kind of ['budget', 'credential', 'endpoint']) {
    const f = harnessFixture(kind === 'endpoint' ? { baseUrl: 'http://external.example/v1' } : {},
      kind === 'budget' ? { runLimits: { maxTokens: 1000 } } : {});
    if (kind === 'credential') f.deps.resolveCredential = async () => { throw new Error('Artificial credential resolution failure'); };
    let calls = 0;
    await new AgentRuntime(f.deps, { fetch: async () => { calls++; return reply(); } }).run(task);
    const run = f.lastRun();
    assert.equal(calls, 0); assert.equal(run.usage.costUsd, 0);
    assert.equal(run.usage.costSource, 'estimated'); assert.equal(run.usage.unknownCostCalls, undefined);
  }
});

test('bounded explicitly rejected requests do not contaminate an earlier API subtotal', async () => {
  const f = harnessFixture(); let calls = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++calls === 1) return reply('', { prompt_tokens: 20, completion_tokens: 5, cost: 0.003 }, 'tool_calls', [tool()]);
    return new Response('', { status: 429, headers: { 'retry-after': '0' } });
  } }).run(task);
  const run = f.lastRun();
  assert.equal(calls, 4); assert.equal(run.stepLog[1].retries, 2);
  assert.equal(run.usage.costUsd, 0.003); assert.equal(run.usage.costSource, 'api');
  assert.equal(run.usage.unknownCostCalls, undefined);
});

test('a connection lost on a later retry marks one uncertain call, not rejected attempts', async () => {
  const f = harnessFixture(); let calls = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++calls < 3) return new Response('', { status: 503, headers: { 'retry-after': '0' } });
    throw new Error('Artificial transport interruption');
  } }).run(task);
  const run = f.lastRun();
  assert.equal(calls, 3); assert.equal(run.stepLog[0].retries, 2);
  assert.equal(run.usage.costSource, 'unknown'); assert.equal(run.usage.unknownCostCalls, 1);
  assert.ok(run.usage.inputTokens > 0); assert.equal(run.usage.tokenSource, 'estimated');
});

test('stopping the backoff never records another submitted or uncertain call', async () => {
  const f = harnessFixture(); let retried!: () => void;
  const retry = new Promise<void>(resolve => { retried = resolve; });
  const save = f.deps.saveRun!;
  f.deps.saveRun = async run => { await save(run); if (run.stepLog[0]?.retries === 1) retried(); };
  let calls = 0;
  const runtime = new AgentRuntime(f.deps, { fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '10' } }); } });
  const running = runtime.run(task);
  await retry; await runtime.stop('s'); await running;
  const run = f.lastRun();
  assert.equal(calls, 1); assert.equal(run.status, 'stopped');
  assert.equal(run.usage.costUsd, 0); assert.equal(run.usage.unknownCostCalls, undefined);
});

test('OpenRouter Responses cost is authoritative instead of a local tariff estimate', async () => {
  const f = harnessFixture({ kind: 'openai-responses', inputPricePerMillion: 1, outputPricePerMillion: 2 });
  await new AgentRuntime(f.deps, { fetch: async () => new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
    usage: { input_tokens: 20, output_tokens: 5, cost: 0.0123 },
  }), { headers: { 'content-type': 'application/json' } }) }).run(task);
  const run = f.lastRun();
  assert.equal(run.status, 'completed'); assert.equal(run.usage.costSource, 'api');
  assert.equal(run.usage.costUsd, 0.0123);
});

test('a billed malformed JSON answer retains API cost before content validation fails', async () => {
  const f = harnessFixture();
  await new AgentRuntime(f.deps, { fetch: async () => new Response(JSON.stringify({
    choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.0123 },
  }), { headers: { 'content-type': 'application/json' } }) }).run(task);
  const run = f.lastRun();
  assert.equal(run.status, 'error'); assert.equal(run.usage.costUsd, 0.0123);
  assert.equal(run.usage.costSource, 'api'); assert.equal(run.usage.unknownCostCalls, undefined);
});

test('Responses billing delivered before a subsequent stream error survives generation failure', async () => {
  const f = harnessFixture({ kind: 'openai-responses' });
  await new AgentRuntime(f.deps, { fetch: async () => new Response([
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 5, cost: 0.0123 } } },
    { type: 'error' },
  ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }) }).run(task);
  const run = f.lastRun();
  assert.equal(run.status, 'error'); assert.equal(run.usage.costUsd, 0.0123);
  assert.equal(run.usage.costSource, 'api'); assert.equal(run.usage.unknownCostCalls, undefined);
});

test('valid API cost survives missing or malformed token counts instead of a tariff estimate', async () => {
  for (const counts of [{}, { prompt_tokens: -1, completion_tokens: 'unknown' }, { prompt_tokens: 27 }]) {
    const f = harnessFixture({ inputPricePerMillion: 1, outputPricePerMillion: 2 });
    await new AgentRuntime(f.deps, { fetch: async () => reply('Done', { ...counts, cost: 0.0123 }) }).run(task);
    const run = f.lastRun();
    assert.equal(run.status, 'completed'); assert.equal(run.usage.costUsd, 0.0123); assert.equal(run.usage.costSource, 'api');
    assert.equal(run.usage.tokenSource, 'prompt_tokens' in counts && counts.prompt_tokens === 27 ? 'mixed' : 'estimated');
    assert.ok(Number.isFinite(run.usage.inputTokens + run.usage.outputTokens));
  }
});
