import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '../src/agent/runtime';
import { generate } from '../src/agent/providers';
import { aggregateUsage, responseUsage } from '../src/agent/journal';
import { WorkspaceServices } from '../src/backend';
import type { ModelRequest } from '../src/shared/agent';
import { fixtureModel, harnessFixture, reply, sse, tool } from './agent-fixture';

const request = (kind: ModelRequest['model']['kind'] = 'openai-compatible'): ModelRequest => ({
  model: { ...fixtureModel, kind }, system: 'Fixture', messages: [{ role: 'user', content: 'Task' }],
  tools: [], signal: new AbortController().signal, apiKey: 'known-artificial-fixture-value',
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('Chat cache read and creation are subsets of inclusive input, with API cost untouched', async () => {
  const result = await generate(request(), async () => reply('Done', {
    prompt_tokens: 1000, completion_tokens: 10, cost: 0.0123,
    prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
  }));
  assert.equal(result.usage!.inputTokens, 1000); assert.equal(result.usage!.cacheReadTokens, 800);
  assert.equal(result.usage!.cacheWriteTokens, 100); assert.equal(result.usage!.costUsd, 0.0123);
  assert.equal(result.usage!.cacheDetailsPartial, undefined);
});

test('Responses JSON and streaming retain cache counts without adding them to input twice', async () => {
  const body = { status: 'completed', output: [], usage: { input_tokens: 900, output_tokens: 10, cost: 0.0123,
    input_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 } } };
  for (const fetch of [async () => json(body), async () => sse([{ type: 'response.completed', response: body }])]) {
    const result = await generate(request('openai-responses'), fetch);
    assert.equal(result.usage!.inputTokens, 900); assert.equal(result.usage!.cacheReadTokens, 400);
    assert.equal(result.usage!.cacheWriteTokens, 200); assert.equal(result.usage!.costUsd, 0.0123);
  }
});

test('native Anthropic adds exclusive raw, cache read and creation input exactly once', async () => {
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 };
  for (const fetch of [async () => json({ content: [{ type: 'text', text: 'Done' }], usage, stop_reason: 'end_turn' }),
    async () => sse([{ type: 'message_start', message: { usage } }, { type: 'message_delta', usage: { output_tokens: 12 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])]) {
    const result = await generate(request('anthropic'), fetch);
    assert.equal(result.usage!.inputTokens, 800); assert.equal(result.usage!.cacheReadTokens, 500);
    assert.equal(result.usage!.cacheWriteTokens, 200);
  }
});

test('missing or malformed cache details never become invented hits or a discount', async () => {
  for (const details of [undefined, { cached_tokens: -1 }, { cached_tokens: 1200 }, { cached_tokens: 800, cache_write_tokens: 400 }]) {
    const result = await generate(request(), async () => reply('Done', { prompt_tokens: 1000, completion_tokens: 10, cost: 0.0123, prompt_tokens_details: details }));
    assert.equal(result.usage!.inputTokens, 1000); assert.equal(result.usage!.cacheReadTokens, undefined);
    assert.equal(result.usage!.cacheWriteTokens, undefined); assert.equal(result.usage!.cacheDetailsPartial, true);
    assert.equal(result.usage!.costUsd, 0.0123);
  }
  const zero = await generate(request(), async () => reply('Done', { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }));
  assert.equal(zero.usage!.cacheReadTokens, 0); assert.equal(zero.usage!.cacheDetailsPartial, undefined);
});

test('fallback prices split ordinary, cache read and creation input while API cost stays authoritative', () => {
  const model = { ...fixtureModel, inputPricePerMillion: 2, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.2, cacheWritePricePerMillion: 2.5 };
  const usage = { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100 };
  const estimated = responseUsage(model, { content: 'Done', toolCalls: [], usage }, 1000);
  assert.equal(estimated.costSource, 'estimated'); assert.equal(estimated.costUsd, 0.00071);
  const actual = responseUsage(model, { content: 'Done', toolCalls: [], usage: { ...usage, costUsd: 0.0123 } }, 1000);
  assert.equal(actual.costSource, 'api'); assert.equal(actual.costUsd, 0.0123);
  const missingRate = responseUsage({ ...model, cacheWritePricePerMillion: undefined }, { content: 'Done', toolCalls: [], usage }, 1000);
  assert.equal(missingRate.costSource, 'unknown'); assert.equal(missingRate.costUsd, undefined);
});

test('cache aggregation preserves known subtotals and labels unreported calls as partial', () => {
  const first = responseUsage(fixtureModel, { content: '', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 10, costUsd: 0.0123, cacheReadTokens: 800, cacheWriteTokens: 100 } }, 1000);
  const second = responseUsage(fixtureModel, { content: '', toolCalls: [], usage: { inputTokens: 500, outputTokens: 10, costUsd: 0.01 } }, 500);
  const total = aggregateUsage(first, second);
  assert.equal(total.inputTokens, 1500); assert.equal(total.cacheReadTokens, 800); assert.equal(total.cacheWriteTokens, 100);
  assert.equal(total.cacheDetailsPartial, true); assert.equal(total.costUsd, 0.0223); assert.equal(total.costSource, 'api');
  const initial = { inputTokens: 0, outputTokens: 0, tokenSource: 'estimated' as const, costSource: 'estimated' as const, costUsd: 0 };
  assert.equal(aggregateUsage(initial, first, true).cacheDetailsPartial, undefined);
});

test('cache metadata survives each journal step, aggregation and a billed failure', async () => {
  const f = harnessFixture(); let calls = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 10, cost: 0.0123, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } };
    return ++calls === 1 ? reply('', usage, 'tool_calls', [tool()]) : sse([{ choices: [], usage }, { type: 'error' }]);
  } }).run({ sessionId: 's', text: 'Read README.', attachmentIds: [] });
  const run = f.lastRun(); assert.equal(run.status, 'error'); assert.equal(run.usage.inputTokens, 2000);
  assert.equal(run.usage.cacheReadTokens, 1600); assert.equal(run.usage.cacheWriteTokens, 200); assert.equal(run.usage.cacheDetailsPartial, undefined);
  assert.ok(run.stepLog.every(step => step.cacheReadTokens === 800 && step.cacheWriteTokens === 100));
  assert.equal(run.usage.costUsd, 0.0246); assert.equal(run.usage.costSource, 'api');
});

test('configured cache prices survive save/reopen and invalid values are rejected', async context => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-cache-price-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceServices(root, { approve: async () => true, emit: () => undefined }); await workspace.bootstrap();
  const model = { ...fixtureModel, id: 'cache-price-fixture', cacheReadPricePerMillion: 0.2, cacheWritePricePerMillion: 2.5 };
  const saved = await workspace.saveModel(model);
  assert.equal(saved.cacheReadPricePerMillion, 0.2); assert.equal(saved.cacheWritePricePerMillion, 2.5);
  const reopened = new WorkspaceServices(root, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  assert.equal((await reopened.getModel(model.id)).cacheReadPricePerMillion, 0.2); assert.equal((await reopened.getModel(model.id)).cacheWritePricePerMillion, 2.5);
  for (const rate of [-1, NaN, Infinity, 100001]) await assert.rejects(workspace.saveModel({ ...model, cacheReadPricePerMillion: rate }), /model price/);
});
