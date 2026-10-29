import test from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, responsesBody } from '../src/agent/mappings';
import { cacheBillingModel, cacheReservationModel, promptCacheCapability } from '../src/agent/cache-policy';
import { generate } from '../src/agent/providers';
import { providerId } from '../src/agent/reasoning';
import type { ModelRequest } from '../src/shared/agent';
import { fixtureModel } from './agent-fixture';

const luna = { ...fixtureModel, kind: 'openai-responses' as const, model: 'openai/gpt-6-luna' };
const direct = { ...luna, baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' };
const claude = { ...fixtureModel, kind: 'openai-responses' as const, model: 'anthropic/claude-sonnet-5.5' };
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: luna, system: 'Stable trusted policy',
  messages: [{ role: 'user', content: 'Inspect README.' }], tools: [], signal: new AbortController().signal,
  apiKey: 'known-artificial-fixture-value', sessionId: 'contract-fixture', cachePolicy: { enabled: true, ttl: '5m' }, ...patch });
const count = (value: unknown, key: string): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item, key), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [name, item]) => sum + (name === key ? 1 : count(item, key)), 0);
};

// Narrow assertions from the public OpenRouter OpenAPI schemas checked 2026-10-07:
// https://openrouter.ai/openapi.json -> PromptCacheOptions, Inputs, EasyInputMessage,
// InputText and OutputMessage. They are provider contracts, not a payload snapshot.
function assertOpenRouterContract(body: Record<string, any>): void {
  if (body.prompt_cache_options) assert.ok(['explicit'].includes(body.prompt_cache_options.mode), 'OpenRouter PromptCacheOptions mode enum');
  for (const item of body.input ?? []) {
    if (!item.role) continue;
    assert.ok(['user', 'assistant', 'system', 'developer'].includes(item.role));
    const easyContent = item.content == null || typeof item.content === 'string'
      || Array.isArray(item.content) && item.content.every((part: Record<string, any>) => ['input_text', 'input_image', 'input_file', 'input_audio', 'input_video'].includes(part.type));
    if (easyContent) continue;
    assert.equal(item.role, 'assistant');
    assert.equal(item.type, 'message', 'OutputMessage requires type');
    assert.equal(typeof item.id, 'string', 'OutputMessage requires id');
    assert.ok(Array.isArray(item.content) && item.content.every((part: Record<string, any>) => ['output_text', 'refusal'].includes(part.type)));
  }
}

test('the first Luna OpenRouter request satisfies cache and message schemas', async () => {
  const body = responsesBody(request());
  assertOpenRouterContract(body);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assert.equal(count(body, 'prompt_cache_breakpoint'), 2);
  assert.equal(body.session_id, 'contract-fixture');
  assert.equal(body.store, false); assert.equal(body.previous_response_id, undefined);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  let submissions = 0;
  const response = await generate(request(), async (_url, init) => {
    submissions++; assertOpenRouterContract(JSON.parse(String(init?.body)));
    return Response.json({ status: 'completed', output: [{ type: 'message', id: 'message-fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }],
      usage: { input_tokens: 1100, output_tokens: 5, cost: 0.00008, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 } } });
  });
  assert.equal(submissions, 1); assert.equal(response.content, 'Done'); assert.equal(response.usage?.costUsd, 0.00008);
});

test('Luna OpenRouter cache off has valid explicit mode with no cache boundaries', () => {
  for (const body of [responsesBody(request({ cachePolicy: { enabled: false } })), chatBody(request({ model: { ...luna, kind: 'openai-compatible' }, cachePolicy: { enabled: false } }))]) {
    assertOpenRouterContract(body);
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
    assert.equal(count(body, 'prompt_cache_breakpoint'), 0); assert.equal(body.session_id, undefined);
  }
});

test('direct modern OpenAI retains documented implicit caching while OpenRouter Chat uses explicit', () => {
  for (const body of [responsesBody(request({ model: direct })), chatBody(request({ model: { ...direct, kind: 'openai-compatible' } }))]) {
    assert.deepEqual(body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
    assert.equal(body.prompt_cache_key, 'contract-fixture'); assert.equal(body.session_id, undefined);
    assert.equal(count(body, 'prompt_cache_breakpoint'), 2);
  }
  const router = chatBody(request({ model: { ...luna, kind: 'openai-compatible' } }));
  assertOpenRouterContract(router); assert.deepEqual(router.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
});

test('Sonnet and error assistant text transfer to Luna as valid easy input messages', () => {
  const source = { ...fixtureModel, model: 'anthropic/claude-sonnet-5.5' };
  const messages: ModelRequest['messages'] = [{ role: 'user', content: 'Original task' },
    { role: 'assistant', content: 'Earlier Sonnet answer', providerId: providerId(source), providerItems: [{ type: 'text', text: 'Native source block' }] },
    { role: 'assistant', content: 'HTTP 400; request rejected' }, { role: 'user', content: 'Continue with Luna' }];
  const before = structuredClone(messages), body = responsesBody(request({ messages }));
  assertOpenRouterContract(body);
  assert.deepEqual(body.input.filter((item: Record<string, any>) => item.role === 'assistant'),
    [{ role: 'assistant', content: 'Earlier Sonnet answer' }, { role: 'assistant', content: 'HTTP 400; request rejected' }]);
  assert.deepEqual(messages, before);
});

test('actual Responses output and encrypted reasoning replay retain their original provider items', () => {
  const retained = [{ type: 'reasoning', id: 'reasoning-fixture', encrypted_content: 'opaque-fixture' },
    { type: 'message', id: 'message-fixture', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Earlier answer', annotations: [] }] }];
  const before = structuredClone(retained), body = responsesBody(request({ messages: [{ role: 'user', content: 'Original task' },
    { role: 'assistant', content: 'Earlier answer', providerId: providerId(luna), providerItems: retained }, { role: 'user', content: 'Continue' }] }));
  assertOpenRouterContract(body);
  assert.equal(body.input[2], retained[0]); assert.equal(body.input[3], retained[1]);
  assert.deepEqual(retained, before); assert.equal(body.input.filter((item: Record<string, any>) => item.role === 'assistant').length, 1);
});

test('a foreign gateway gets valid fallback text without receiving provider-specific cache controls', () => {
  const body = responsesBody(request({ model: { ...luna, baseUrl: 'https://gateway.example/v1' }, messages: [
    { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Continue' }] }));
  assertOpenRouterContract(body);
  assert.equal(body.prompt_cache_options, undefined); assert.equal(body.session_id, undefined); assert.equal(body.prompt_cache_key, undefined);
  assert.equal(count(body, 'prompt_cache_breakpoint'), 0);
});

test('Claude Responses caches stable history before a changing project snapshot with valid five-minute markers', () => {
  const bodies = ['Snapshot one', 'Snapshot two'].map(content => responsesBody(request({ model: claude, messages: [
    { role: 'user', content: 'Inspect README' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-fixture', name: 'read_file', arguments: { path: 'README.md' } }] },
    { role: 'tool', content: 'README observation', toolCallId: 'call-fixture' }, { role: 'user', content, contextData: true }] })));
  for (const body of bodies) {
    assertOpenRouterContract(body);
    assert.equal(body.cache_control, undefined, 'automatic boundary must not include the volatile snapshot');
    assert.equal(body.prompt_cache_options, undefined, 'OpenAI-only request controls do not apply to Claude');
    assert.equal(count(body, 'prompt_cache_breakpoint'), 2); assert.equal(count(body, 'cache_control'), 0);
    assert.equal(count(body.input.at(-1), 'prompt_cache_breakpoint'), 0);
    assert.equal(count(body.input.at(-2), 'prompt_cache_breakpoint'), 1);
    assert.equal(count(body, 'contextData'), 0);
  }
  assert.deepEqual(bodies[0].input.slice(0, -1), bodies[1].input.slice(0, -1));
});

test('Claude Responses declares five-minute explicit capability without changing Chat and native TTL support', () => {
  assert.deepEqual(promptCacheCapability(claude), { strategy: 'anthropic-explicit', canDisable: true, ttl: '5m' });
  assert.equal(promptCacheCapability({ ...claude, kind: 'openai-compatible' }).ttl, 'claude');
  assert.equal(promptCacheCapability({ ...claude, kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' }).ttl, 'claude');
  const pricing = { ...claude, inputPricePerMillion: 2, outputPricePerMillion: 10, cacheWritePricePerMillion: 2.5 };
  assert.equal(cacheReservationModel(pricing, { enabled: true, ttl: '5m' }).inputPricePerMillion, 2.5);
  assert.equal(cacheReservationModel(pricing, { enabled: true, ttl: '1h' }).inputPricePerMillion, 2.5);
  assert.equal(cacheBillingModel(pricing, { enabled: true, ttl: '1h' }), pricing);
});

test('unsupported one-hour Claude Responses caching fails locally before submitting a request', async () => {
  let submitted = 0;
  await assert.rejects(generate(request({ model: claude, cachePolicy: { enabled: true, ttl: '1h' } }), async () => {
    submitted++; return Response.json({ status: 'completed', output: [] });
  }), /Responses.*5.*Chat|Responses.*5.*Anthropic/);
  assert.equal(submitted, 0);
  const off = responsesBody(request({ model: claude, cachePolicy: { enabled: false, ttl: '1h' } }));
  assert.equal(count(off, 'prompt_cache_breakpoint'), 0); assert.equal(off.cache_control, undefined);
});

test('Claude Responses volatile-only context has no conversation breakpoint', () => {
  const body = responsesBody(request({ model: claude, messages: [{ role: 'user', content: 'Quoted snapshot', contextData: true }] }));
  assert.equal(count(body, 'prompt_cache_breakpoint'), 1);
  assert.equal(body.input[0].role, 'developer'); assert.equal(count(body.input[1], 'prompt_cache_breakpoint'), 0);
});
