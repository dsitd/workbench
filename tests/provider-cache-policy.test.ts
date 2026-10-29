import test from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, responsesBody, anthropicBody } from '../src/agent/mappings';
import { cacheBillingModel, cacheReservationModel, promptCacheCapability } from '../src/agent/cache-policy';
import { responseUsage } from '../src/agent/journal';
import { generate } from '../src/agent/providers';
import { providerId } from '../src/agent/reasoning';
import type { ModelRequest } from '../src/shared/agent';
import { fixtureModel, reply } from './agent-fixture';

const claude = { ...fixtureModel, model: 'anthropic/claude-sonnet-5.5' };
const luna = { ...fixtureModel, kind: 'openai-responses' as const, model: 'openai/gpt-6-luna' };
const native = { ...fixtureModel, kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' };
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: claude, system: 'Stable trusted project policy',
  messages: [{ role: 'user', content: 'Inspect README.' }], tools: [], signal: new AbortController().signal,
  apiKey: 'known-artificial-fixture-value', sessionId: 'chat-fixture:revision-1', cachePolicy: { enabled: true }, ...patch });
const count = (value: unknown, key: string): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item, key), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [name, item]) => sum + (name === key ? 1 : count(item, key)), 0);
};
const call = { id: 'call-one', name: 'read_file', arguments: { path: 'README.md' } };

test('missing policy preserves provider defaults and never opts one-shot Claude into writes', () => {
  assert.equal(chatBody(request({ cachePolicy: undefined })).messages[0].content, 'Stable trusted project policy');
  assert.equal(count(chatBody(request({ cachePolicy: undefined })), 'cache_control'), 0);
  assert.equal(anthropicBody(request({ model: native, cachePolicy: undefined })).system, 'Stable trusted project policy');
  const body = responsesBody(request({ model: luna, cachePolicy: undefined }));
  assert.equal(body.prompt_cache_options, undefined); assert.equal(body.session_id, undefined);
});

test('OpenRouter Claude caches the stable prefix and last tool result without changing replay', () => {
  const reasoning = [{ type: 'reasoning.encrypted', id: 'reasoning-fixture', data: 'opaque-fixture' }];
  const req = request({ messages: [{ role: 'user', content: 'Inspect README.' },
    { role: 'assistant', content: '', toolCalls: [call], reasoningDetails: reasoning, providerId: providerId(claude) },
    { role: 'tool', content: 'Observed README', toolCallId: call.id }] });
  const before = structuredClone(req.messages); const body = chatBody(req);
  assert.equal(body.session_id, req.sessionId); assert.equal(body.cache_control, undefined);
  assert.equal(count(body, 'cache_control'), 2);
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.messages[2].tool_calls[0].id, call.id);
  assert.deepEqual(body.messages[2].reasoning_details, reasoning);
  assert.equal(body.messages[3].tool_call_id, call.id);
  assert.deepEqual(body.messages[3].content, [{ type: 'text', text: 'Observed README', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(req.messages, before);
});

test('native Claude marks a completed tool group while preserving signed thinking and arguments', () => {
  const signed = [{ type: 'thinking', thinking: 'opaque private fixture', signature: 'fixture-signature' },
    { type: 'tool_use', id: 'one', name: 'read_file', input: { path: 'one.md' } },
    { type: 'tool_use', id: 'two', name: 'read_file', input: { path: 'two.md' } }];
  const req = request({ model: native, messages: [{ role: 'user', content: 'Inspect both files.' },
    { role: 'assistant', content: '', providerId: providerId(native), providerItems: signed },
    { role: 'tool', content: 'First', toolCallId: 'one' }, { role: 'tool', content: 'Second', toolCallId: 'two' }] });
  const before = structuredClone(signed), body = anthropicBody(req);
  assert.equal(count(body, 'cache_control'), 2); assert.equal(body.session_id, undefined);
  assert.deepEqual(body.messages[1].content, signed); assert.deepEqual(signed, before);
  assert.equal(body.messages[2].content.length, 2);
  assert.equal(body.messages[2].content[0].tool_use_id, 'one'); assert.equal(body.messages[2].content[0].cache_control, undefined);
  assert.equal(body.messages[2].content[1].tool_use_id, 'two'); assert.deepEqual(body.messages[2].content[1].cache_control, { type: 'ephemeral' });
});

test('native cache markers never attach to thinking, redacted thinking or tool-use blocks', () => {
  const signed = [{ type: 'thinking', thinking: 'opaque fixture', signature: 'fixture-signature' }, { type: 'redacted_thinking', data: 'opaque fixture' }];
  const body = anthropicBody(request({ model: native, messages: [{ role: 'user', content: 'Task' },
    { role: 'assistant', content: '', providerId: providerId(native), providerItems: signed }] }));
  assert.deepEqual(body.messages[1].content, signed); assert.equal(count(body.messages[1], 'cache_control'), 0);
});

test('Claude Responses uses supported explicit five-minute markers instead of a volatile automatic boundary', () => {
  const body = responsesBody(request({ model: { ...claude, kind: 'openai-responses' }, cachePolicy: { enabled: true, ttl: '5m' } }));
  assert.equal(body.cache_control, undefined); assert.equal(count(body.input, 'cache_control'), 0);
  assert.equal(count(body.input, 'prompt_cache_breakpoint'), 2);
  assert.equal(body.session_id, 'chat-fixture:revision-1'); assert.equal(body.input[0].content[0].text, 'Stable trusted project policy');
});

test('modern OpenRouter Responses exposes a stable developer boundary and retains encrypted replay', () => {
  const encrypted = [{ type: 'reasoning', id: 'opaque-fixture', encrypted_content: 'fixture-encrypted-block' }];
  const req = request({ model: luna, cachePolicy: { enabled: true, ttl: '1h' }, messages: [
    { role: 'user', content: 'Inspect README.' }, { role: 'assistant', content: '', providerItems: encrypted, providerId: providerId(luna), toolCalls: [call] },
    { role: 'tool', content: 'Observed README', toolCallId: call.id },
  ] });
  const before = structuredClone(req.messages), body = responsesBody(req);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' }); assert.equal(body.instructions, undefined);
  assert.equal(body.session_id, req.sessionId); assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.input[0].role, 'developer'); assert.equal(body.input[0].content[0].text, req.system);
  assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(body.input[2], encrypted[0]);
  assert.equal(body.input.at(-1).call_id, call.id); assert.deepEqual(body.input.at(-1).output[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(count(body, 'prompt_cache_breakpoint'), 3); assert.deepEqual(req.messages, before);
});

test('configured cache off really suppresses modern OpenAI writes and Claude explicit opt-in', () => {
  for (const body of [responsesBody(request({ model: luna, cachePolicy: { enabled: false } })),
    chatBody(request({ model: { ...luna, kind: 'openai-compatible' }, cachePolicy: { enabled: false } }))]) {
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' }); assert.equal(count(body, 'prompt_cache_breakpoint'), 0);
    assert.equal(body.session_id, undefined); assert.equal(body.prompt_cache_key, undefined);
  }
  assert.equal(count(chatBody(request({ cachePolicy: { enabled: false } })), 'cache_control'), 0);
  assert.equal(count(anthropicBody(request({ model: native, cachePolicy: { enabled: false } })), 'cache_control'), 0);
});

test('older OpenAI exposes automatic provider behavior without falsely claiming an off control', () => {
  const old = { ...luna, model: 'openai/gpt-5.5' };
  assert.deepEqual(promptCacheCapability(old), { strategy: 'implicit', canDisable: false });
  assert.equal(responsesBody(request({ model: old, cachePolicy: { enabled: false } })).prompt_cache_options, undefined);
  const direct = { ...old, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' };
  assert.equal(responsesBody(request({ model: direct })).prompt_cache_key, 'chat-fixture:revision-1');
  assert.equal(responsesBody(request({ model: direct })).session_id, undefined);
});

test('cache capabilities honor modern model versions and exact official route families', () => {
  for (const model of ['openai/gpt-5.6', 'openai/gpt-5.10-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol'])
    assert.equal(promptCacheCapability({ ...luna, model }).strategy, 'openai-explicit');
  for (const baseUrl of ['https://openrouter.ai.evil.example/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai/api/v2',
    'https://user@openrouter.ai/api/v1', 'https://openrouter.ai:8443/api/v1', 'https://openrouter.ai/api/v1?fixture=1', 'https://openrouter.ai/api/v1//']) {
    const model = { ...luna, baseUrl }; assert.equal(promptCacheCapability(model).strategy, 'unsupported');
    const body = responsesBody(request({ model }));
    assert.equal(body.session_id, undefined); assert.equal(body.prompt_cache_options, undefined); assert.equal(count(body, 'prompt_cache_breakpoint'), 0);
  }
  assert.equal(promptCacheCapability({ ...native, baseUrl: 'https://proxy.example/v1' }).strategy, 'unsupported');
  assert.equal(promptCacheCapability({ ...luna, baseUrl: 'https://openrouter.ai/api/v1/responses' }).strategy, 'openai-explicit');
});

test('images retain their chosen detail and position instead of acquiring invalid reasoning markers', () => {
  const image = { mimeType: 'image/png', base64: 'ZmFrZQ==', detail: 'high' as const };
  const messages: ModelRequest['messages'] = [{ role: 'user', content: 'Inspect image' },
    { role: 'assistant', content: '', toolCalls: [{ ...call, name: 'inspect_image' }] },
    { role: 'tool', content: 'Selected image', toolCallId: call.id, images: [image] }];
  const chat = chatBody(request({ messages }));
  assert.equal(chat.messages.at(-1).content.length, 2); assert.equal(chat.messages.at(-1).content[1].image_url.detail, 'high');
  assert.equal(chat.messages.at(-1).content[1].cache_control, undefined);
  const responses = responsesBody(request({ model: luna, messages }));
  assert.equal(responses.input.at(-1).content[1].detail, 'high'); assert.equal(responses.input.at(-1).content[1].prompt_cache_breakpoint, undefined);
  const low = chatBody(request({ messages: [{ role: 'user', content: 'Default image', images: [{ ...image, detail: undefined }] }] }));
  assert.equal(low.messages[1].content[1].image_url.detail, 'low');
});

test('native explicit markers never exceed four or mutate replayed blocks', () => {
  const retained = Array.from({ length: 4 }, (_, index) => ({ type: 'text', text: `Fixture ${index}`, cache_control: { type: 'ephemeral' } }));
  const req = request({ model: native, messages: [{ role: 'user', content: 'Task' },
    { role: 'assistant', content: '', providerItems: retained, providerId: providerId(native) }] });
  const before = structuredClone(retained), body = anthropicBody(req);
  assert.equal(count(body, 'cache_control'), 4); assert.deepEqual(retained, before);
  assert.throws(() => anthropicBody({ ...req, messages: [{ ...req.messages[1], providerItems: [...retained, retained[0]] }] }), /четырёх/);
});

test('invalid supported cache configuration is rejected before transport submission', async () => {
  let calls = 0;
  await assert.rejects(generate(request({ sessionId: 'fixture\ninvalid' }), async () => { calls++; return reply(); }), /идентификатор/);
  await assert.rejects(generate(request({ cachePolicy: { enabled: true, ttl: 'invalid' as '5m' } }), async () => { calls++; return reply(); }), /настройка/);
  assert.equal(calls, 0);
});

test('provider transport receives real controls without inventing a reported cache hit', async () => {
  let submitted: Record<string, any> | undefined;
  const response = await generate(request(), async (_url, init) => {
    submitted = JSON.parse(String(init?.body));
    return reply('Done', { prompt_tokens: 1000, completion_tokens: 10, cost: 0.0123 });
  });
  assert.equal(submitted!.session_id, 'chat-fixture:revision-1'); assert.equal(count(submitted, 'cache_control'), 2);
  assert.equal(response.usage!.costUsd, 0.0123); assert.equal(response.usage!.cacheReadTokens, undefined);
});

test('volatile project snapshots stay after the same cached history boundary in all explicit protocols', () => {
  const messages = (snapshot: string): ModelRequest['messages'] => [{ role: 'user', content: 'Inspect README.' },
    { role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', content: 'Observed README', toolCallId: call.id },
    { role: 'user', content: snapshot, contextData: true }];
  const chat = ['Snapshot one', 'Snapshot two'].map(snapshot => chatBody(request({ messages: messages(snapshot) })));
  assert.deepEqual(chat[0].messages.slice(0, -1), chat[1].messages.slice(0, -1));
  assert.equal(count(chat[0].messages.at(-2), 'cache_control'), 1);
  assert.equal(count(chat[0].messages.at(-1), 'cache_control'), 0);
  const nativeBodies = ['Snapshot one', 'Snapshot two'].map(snapshot => anthropicBody(request({ model: native, messages: messages(snapshot) })));
  assert.deepEqual(nativeBodies[0].messages.at(-1).content[0], nativeBodies[1].messages.at(-1).content[0]);
  assert.equal(count(nativeBodies[0].messages.at(-1).content[0], 'cache_control'), 1);
  assert.equal(count(nativeBodies[0].messages.at(-1).content[1], 'cache_control'), 0);
  const responses = ['Snapshot one', 'Snapshot two'].map(snapshot => responsesBody(request({ model: luna, messages: messages(snapshot) })));
  assert.deepEqual(responses[0].input.slice(0, -1), responses[1].input.slice(0, -1));
  assert.equal(count(responses[0].input.at(-2), 'prompt_cache_breakpoint'), 1);
  assert.equal(count(responses[0].input.at(-1), 'prompt_cache_breakpoint'), 0);
  for (const body of [...chat, ...nativeBodies, ...responses]) {
    assert.equal(count(body, 'contextData'), 0); assert.equal(count(body, 'cacheCandidates'), 0);
  }
});

test('a volatile-only user message does not invent an explicit conversation cache boundary', () => {
  const req = request({ messages: [{ role: 'user', content: 'Quoted project snapshot', contextData: true }] });
  assert.equal(count(chatBody(req), 'cache_control'), 1);
  assert.equal(count(anthropicBody({ ...req, model: native }), 'cache_control'), 1);
  assert.equal(count(responsesBody({ ...req, model: luna }), 'prompt_cache_breakpoint'), 1);
});

test('one-hour Claude fallback pricing derives only an established standard five-minute tariff', () => {
  const model = { ...claude, inputPricePerMillion: 2, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.2, cacheWritePricePerMillion: 2.5 };
  const before = structuredClone(model), billing = cacheBillingModel(model, { enabled: true, ttl: '1h' });
  assert.equal(billing.cacheWritePricePerMillion, 4); assert.deepEqual(model, before);
  const response = { content: 'Done', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 500 } };
  const estimated = responseUsage(billing, response, 1000);
  assert.equal(estimated.costSource, 'estimated'); assert.equal(estimated.costUsd, 0.00266);
  const api = responseUsage(billing, { ...response, usage: { ...response.usage, costUsd: 0.000123 } }, 1000);
  assert.equal(api.costSource, 'api'); assert.equal(api.costUsd, 0.000123);
  for (const patch of [{ cacheWritePricePerMillion: undefined }, { cacheWritePricePerMillion: 3 }, { inputPricePerMillion: undefined }]) {
    const unresolved = cacheBillingModel({ ...model, ...patch }, { enabled: true, ttl: '1h' });
    assert.equal(unresolved.cacheWritePricePerMillion, undefined);
    assert.equal(responseUsage(unresolved, response, 1000).costSource, 'unknown');
  }
  assert.equal(cacheBillingModel(model, undefined), model);
  assert.equal(cacheBillingModel(model, { enabled: false, ttl: '1h' }), model);
  assert.equal(cacheBillingModel(model, { enabled: true, ttl: '5m' }), model);
  const openai = { ...luna, ...model, model: luna.model, kind: luna.kind };
  assert.equal(cacheBillingModel(openai, { enabled: true, ttl: '1h' }), openai);
});

test('a disabled reasoning one-shot uses none only for verified official Luna Responses routes', () => {
  for (const model of [luna, { ...luna, model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1' }]) {
    const body = responsesBody(request({ model, reasoningEnabled: false, cachePolicy: undefined }));
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.prompt_cache_options, undefined); assert.equal(count(body, 'prompt_cache_breakpoint'), 0);
  }
  for (const model of [{ ...luna, model: 'openai/gpt-6-sol' }, { ...luna, baseUrl: 'https://proxy.example/v1' }]) {
    const body = responsesBody(request({ model, reasoningEnabled: false, cachePolicy: undefined }));
    assert.notEqual(body.reasoning?.effort, 'none');
  }
});

test('budget reservation prices possible writes without inventing a billed cache estimate', () => {
  const model = { ...claude, inputPricePerMillion: 2, outputPricePerMillion: 10 };
  assert.equal(cacheReservationModel(model, { enabled: true }).inputPricePerMillion, 2.5);
  assert.equal(cacheReservationModel(model, { enabled: true, ttl: '1h' }).inputPricePerMillion, 4);
  assert.equal(cacheReservationModel(model, { enabled: false, ttl: '1h' }), model);
  assert.equal(cacheReservationModel(model, undefined), model);
  assert.equal(model.inputPricePerMillion, 2); assert.equal(model.cacheWritePricePerMillion, undefined);
  // A request reservation may use documented premium ratios while an actual
  // fallback bill with unknown configured write tariff remains unknown.
  assert.equal(cacheBillingModel(model, { enabled: true, ttl: '1h' }).cacheWritePricePerMillion, undefined);
  const openai = { ...luna, inputPricePerMillion: 2 };
  assert.equal(cacheReservationModel(openai, undefined).inputPricePerMillion, 2.5);
  assert.equal(cacheReservationModel(openai, { enabled: true, ttl: '1h' }).inputPricePerMillion, 2.5);
  assert.equal(cacheReservationModel(openai, { enabled: false }), openai);
  assert.equal(cacheReservationModel({ ...model, cacheWritePricePerMillion: 5 }, { enabled: true }).inputPricePerMillion, 5);
  // An unsupported route cannot promise that off suppresses an existing cache.
  const custom = { ...model, baseUrl: 'https://fixture.example/v1', cacheWritePricePerMillion: 3 };
  assert.equal(cacheReservationModel(custom, { enabled: false }).inputPricePerMillion, 3);
  assert.equal(cacheReservationModel({ ...model, inputPricePerMillion: undefined }, { enabled: true }).inputPricePerMillion, undefined);
});
