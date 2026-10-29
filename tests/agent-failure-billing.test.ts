import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { generate } from '../src/agent/providers';
import { parseSse } from '../src/agent/http';
import { ModelGenerationFailure } from '../src/agent/provider-failure';
import { fixtureModel, harnessFixture, sse, tool } from './agent-fixture';
import type { ModelRequest } from '../src/shared/agent';

const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: fixtureModel, system: 'Fixture',
  messages: [{ role: 'user', content: 'Read README' }], tools: [], apiKey: 'known-artificial-fixture-value', signal: new AbortController().signal, ...patch });
const task = { sessionId: 's', text: 'Read README and finish.', attachmentIds: [] };
const responseUsage = { input_tokens: 100, output_tokens: 10, cost: 0.0123,
  input_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } };
const chatUsage = { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123,
  prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } };

test('a first failed Responses frame preserves its API charge and never executes or publishes its payload', async () => {
  for (const event of [
    { type: 'response.failed', response: { status: 'failed', usage: responseUsage, error: { message: 'Opaque server fixture data' },
      output: [{ type: 'function_call', call_id: 'unexpected', name: 'write_file', arguments: '{}' }] } },
    { type: 'error', usage: responseUsage, error: { message: 'Opaque server fixture data' } },
    { error: { message: 'Opaque server fixture data' }, response: { usage: responseUsage } },
  ]) {
    const f = harnessFixture({ kind: 'openai-responses', inputPricePerMillion: 1, outputPricePerMillion: 2 });
    let executed = 0; f.deps.executeTool = async () => { executed++; return { text: 'Unexpected execution' }; };
    const fetcher = async () => sse([event]);
    await assert.rejects(generate(request({ model: f.model }), fetcher), error => error instanceof ModelGenerationFailure
      && error.usage?.costUsd === 0.0123 && !error.message.includes('Opaque'));
    await new AgentRuntime(f.deps, { fetch: fetcher }).run(task);
    assert.equal(executed, 0); assert.equal(f.lastRun().status, 'error');
    assert.equal(f.lastRun().usage.costSource, 'api'); assert.equal(f.lastRun().usage.costUsd, 0.0123);
    assert.equal(f.lastRun().usage.inputTokens, 100); assert.equal(f.lastRun().usage.outputTokens, 10);
    assert.equal(f.lastRun().usage.cacheReadTokens, 70); assert.equal(f.lastRun().usage.cacheWriteTokens, 20);
    assert.equal(f.lastRun().usage.unknownCostCalls, undefined);
    assert.equal(f.messages.some(message => message.toolCalls?.length), false);
    assert.equal(JSON.stringify(f.messages).includes('Opaque'), false);
  }
});

test('failed usage snapshots replace prior totals for one call instead of counting twice', async () => {
  const f = harnessFixture({ kind: 'openai-responses' });
  await new AgentRuntime(f.deps, { fetch: async () => sse([
    { type: 'response.incomplete', response: { status: 'incomplete', output: [], usage: { input_tokens: 100, output_tokens: 5, cost: 0.004 } } },
    { type: 'response.failed', response: { usage: responseUsage } },
  ]) }).run(task);
  assert.equal(f.lastRun().steps, 1); assert.equal(f.lastRun().status, 'error');
  assert.equal(f.lastRun().usage.costSource, 'api'); assert.equal(f.lastRun().usage.costUsd, 0.0123);
  assert.equal(f.lastRun().usage.inputTokens, 100); assert.equal(f.lastRun().usage.outputTokens, 10);
  assert.equal(f.lastRun().stepLog[0].costUsd, 0.0123);
});

test('a Chat terminal error preserves first-frame billing and never accepts choices from the failure', async () => {
  for (const type of ['error', undefined]) {
    const f = harnessFixture({ inputPricePerMillion: 1, outputPricePerMillion: 2 });
    let executed = 0; f.deps.executeTool = async () => { executed++; return { text: 'Unexpected execution' }; };
    await new AgentRuntime(f.deps, { fetch: async () => sse([{ type, error: { message: 'Opaque server fixture data' }, usage: chatUsage,
      choices: [{ delta: { content: 'Opaque server fixture data', tool_calls: [{ index: 0, ...tool('bad', 'write_file', {}) }] } }] }]) }).run(task);
    assert.equal(executed, 0); assert.equal(f.lastRun().status, 'error');
    assert.equal(f.lastRun().usage.costUsd, 0.0123); assert.equal(f.lastRun().usage.costSource, 'api');
    assert.equal(f.lastRun().usage.cacheReadTokens, 70); assert.equal(f.lastRun().usage.cacheWriteTokens, 20);
    assert.equal(f.lastRun().usage.unknownCostCalls, undefined); assert.equal(JSON.stringify(f.messages).includes('Opaque'), false);
  }
});

test('failure metadata retains known categories without interpreting snapshots as additional costs', async () => {
  const f = harnessFixture();
  await new AgentRuntime(f.deps, { fetch: async () => sse([
    { choices: [], usage: chatUsage },
    { type: 'error', usage: { cost: 0.0123, completion_tokens: 10 }, error: { message: 'Opaque server fixture data' } },
  ]) }).run(task);
  assert.equal(f.lastRun().usage.costUsd, 0.0123); assert.equal(f.lastRun().usage.inputTokens, 100);
  assert.equal(f.lastRun().usage.outputTokens, 10); assert.equal(f.lastRun().usage.cacheReadTokens, 70);
});

test('a failed billed request adds exactly one charge to the preceding successful task step', async () => {
  const f = harnessFixture({ kind: 'openai-responses' }); let requests = 0, executed = 0;
  f.deps.executeTool = async () => { executed++; return { text: 'Observed README' }; };
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? new Response(JSON.stringify({ status: 'completed',
    output: [{ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"README.md"}' }],
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.004 } }), { headers: { 'content-type': 'application/json' } })
    : sse([{ type: 'response.failed', response: { usage: responseUsage } }]) }).run(task);
  assert.equal(executed, 1); assert.equal(requests, 2); assert.equal(f.lastRun().status, 'error');
  assert.ok(Math.abs(f.lastRun().usage.costUsd! - 0.0163) < 1e-12);
  assert.equal(f.lastRun().usage.costSource, 'api'); assert.equal(f.lastRun().stepLog[1].costUsd, 0.0123);
});

test('terminal failure callbacks contain only numeric billing fields, excluding opaque server bodies', async () => {
  const events: unknown[] = [];
  const stream = sse([{ type: 'response.failed', error: { message: 'Opaque server fixture data' },
    choices: [{ delta: { content: 'Opaque server fixture data' } }], response: { output: ['Opaque server fixture data'],
      usage: { ...responseUsage, unrelated: 'Opaque server fixture data', input_tokens_details: { ...responseUsage.input_tokens_details, private: 'Opaque server fixture data' } } } }]).body!;
  await assert.rejects(parseSse(stream, event => events.push(event), new AbortController().signal), /прервал/);
  assert.deepEqual(events, [{ type: 'response.failed', response: { usage: responseUsage } }]);
});

test('terminal frames without valid usage never erase earlier reported billing', async () => {
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 'invalid', cost: 'invalid' }]) {
    const f = harnessFixture({ kind: 'openai-responses' });
    await new AgentRuntime(f.deps, { fetch: async () => sse([
      { type: 'response.completed', response: { status: 'completed', output: [], usage: responseUsage } },
      { type: 'response.failed', response: { usage } },
    ]) }).run(task);
    assert.equal(f.lastRun().usage.costUsd, 0.0123); assert.equal(f.lastRun().usage.inputTokens, 100);
    assert.equal(f.lastRun().usage.costSource, 'api'); assert.equal(f.lastRun().status, 'error');
  }
});
