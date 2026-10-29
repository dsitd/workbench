import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/agent/providers';
import { chatBody, anthropicBody, responsesBody } from '../src/agent/mappings';
import { requestJson, retryDelay } from '../src/agent/http';
import { generateTitle } from '../src/agent/title';
import { providerId } from '../src/agent/reasoning';
import { ModelGenerationFailure } from '../src/agent/provider-failure';
import { AgentRuntime } from '../src/agent';
import type { ModelRequest } from '../src/shared/agent';
import { fixtureModel, harnessFixture, reply, sse } from './agent-fixture';
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: fixtureModel, system: 'Fixture', messages: [{ role: 'user', content: 'Selected task' }], tools: [], apiKey: 'known-artificial-fixture-value', signal: new AbortController().signal, ...patch });

test('reasoning maps per provider and Auto omits explicit effort', () => {
  for (const effort of ['low', 'medium', 'high'] as const) {
    const req = request({ reasoningEffort: effort }); assert.deepEqual(chatBody(req).reasoning, { effort });
    assert.equal(chatBody({ ...req, model: { ...req.model, baseUrl: 'https://api.openai.com/v1' } }).reasoning_effort, effort);
    assert.deepEqual(responsesBody({ ...req, model: { ...req.model, kind: 'openai-responses' } }).reasoning, { effort });
    const native = anthropicBody({ ...req, model: { ...req.model, kind: 'anthropic', model: 'claude-sonnet-5-5' } });
    assert.deepEqual(native.output_config, { effort }); assert.deepEqual(native.thinking, { type: 'adaptive' });
  }
  assert.equal(chatBody(request({ reasoningEffort: 'auto' })).reasoning, undefined);
  assert.equal(responsesBody(request({ reasoningEffort: 'auto' })).reasoning, undefined);
  assert.equal(anthropicBody(request({ reasoningEffort: 'auto', model: { ...fixtureModel, kind: 'anthropic' } })).thinking, undefined);
  assert.throws(() => anthropicBody(request({ reasoningEffort: 'high', model: { ...fixtureModel, kind: 'anthropic', model: 'claude-sonnet-4-5' } })), /не поддерживает/);
  assert.throws(() => chatBody(request({ reasoningEnabled: false, model: { ...fixtureModel, model: 'anthropic/claude-sonnet-5.5' } })), /обязателен/);
});

test('Anthropic signed thinking and redacted blocks replay exactly during native tool loops', async () => {
  const model = { ...fixtureModel, kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', reasoningEffort: 'low' as const };
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Private reasoning text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part1' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-part2' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'unchanged-opaque-data' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'native-call', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }, { type: 'message_stop' },
  ];
  const deltas: string[] = []; const first = await generate(request({ model, onDelta: text => deltas.push(text) }), async () => sse(events));
  assert.deepEqual(deltas, []); assert.equal(first.content, ''); assert.equal(first.usage!.inputTokens, 30);
  const exact = [{ type: 'thinking', thinking: 'Private reasoning text', signature: 'sig-part1-part2' }, { type: 'redacted_thinking', data: 'unchanged-opaque-data' }, { type: 'tool_use', id: 'native-call', name: 'read_file', input: { path: 'README.md' } }];
  assert.deepEqual(first.providerItems, exact);
  const next = request({ model, messages: [{ role: 'user', content: 'Inspect' }, { role: 'assistant', content: '', toolCalls: first.toolCalls, providerItems: first.providerItems, providerId: providerId(model) }, { role: 'tool', content: 'Observed', toolCallId: 'native-call', toolName: 'read_file' }] });
  const body = anthropicBody(next); assert.deepEqual(body.messages[1].content, exact); assert.equal(body.messages[2].content[0].tool_use_id, 'native-call');
  const switched = anthropicBody({ ...next, model: { ...model, model: 'claude-opus-5-5' } }); assert.ok(switched.messages[1].content.every((block: any) => block.type !== 'thinking' && block.type !== 'redacted_thinking'));
  const direct = await generate(request({ model }), async () => new Response(JSON.stringify({ stop_reason: 'tool_use', content: exact, usage: { input_tokens: 5, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(direct.providerItems, exact);
});

test('Anthropic structured credential echoes split across thinking blocks are rejected without emitting reasoning', async () => {
  const emitted: string[] = [];
  await assert.rejects(generate(request({ model: { ...fixtureModel, kind: 'anthropic' }, onDelta: text => emitted.push(text) }), async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'known-artificial-', signature: 'fixture-value' }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })), /credential/);
  assert.deepEqual(emitted, []);
});

test('all API adapters expose output truncation and retain billed usage without incomplete tool execution', async () => {
  const fixtures = [
    { kind: 'openai-compatible' as const, body: { choices: [{ finish_reason: 'length', message: { content: 'Partial', tool_calls: [{ id: 'c', type: 'function', function: { name: 'write_file', arguments: '{' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 10, cost: 0.003 } } },
    { kind: 'anthropic' as const, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial' }, { type: 'tool_use', id: 'c', name: 'write_file', input: {} }], usage: { input_tokens: 5, output_tokens: 10 } } },
    { kind: 'openai-responses' as const, body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }, { type: 'function_call', call_id: 'c', name: 'write_file', arguments: '{' }], usage: { input_tokens: 5, output_tokens: 10 } } },
  ];
  for (const fixture of fixtures) {
    const result = await generate(request({ model: { ...fixtureModel, kind: fixture.kind } }), async () => new Response(JSON.stringify(fixture.body), { headers: { 'content-type': 'application/json' } }));
    assert.equal(result.content, 'Partial'); assert.equal(result.incomplete, true); assert.deepEqual(result.toolCalls, []); assert.equal(result.usage!.outputTokens, 10); assert.equal(result.providerItems, undefined);
  }
});

test('streamed length and Responses incomplete wait for usage before returning an incomplete result', async () => {
  const chat = await generate(request(), async () => sse([{ choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: 'length' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 10, cost: 0.002 } }]));
  assert.equal(chat.incomplete, true); assert.equal(chat.usage!.costUsd, 0.002);
  const response = await generate(request({ model: { ...fixtureModel, kind: 'openai-responses' } }), async () => sse([{ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }], usage: { input_tokens: 3, output_tokens: 8 } } }]));
  assert.equal(response.incomplete, true); assert.equal(response.usage!.outputTokens, 8);
});

test('pathological usage counts cannot create non-finite persisted totals or pretend precise billing', async () => {
  const f = harnessFixture();
  const fetcher = async () => reply('Useful reply', { prompt_tokens: 1e308, completion_tokens: 1e308, cost: -1 });
  assert.equal((await generate(request(), fetcher)).usage, undefined);
  await new AgentRuntime(f.deps, { fetch: fetcher }).run({ sessionId: 's', text: 'Task', attachmentIds: [] });
  const usage = f.lastRun().usage;
  assert.ok(Number.isFinite(usage.inputTokens + usage.outputTokens)); assert.equal(usage.tokenSource, 'estimated'); assert.equal(usage.costSource, 'unknown');
});

test('transient pre-stream status retries are bounded, preserve body and report each attempt', async () => {
  let attempts = 0; const bodies: string[] = [], retries: unknown[] = [];
  const result = await generate(request({ onRetry: retry => { retries.push(retry); } }), async (_url, init) => {
    attempts++; bodies.push(String(init?.body)); return attempts < 3 ? new Response('Artificial server echo discarded', { status: attempts === 1 ? 429 : 529, headers: { 'retry-after': '0' } }) : reply('Success');
  });
  assert.equal(result.content, 'Success'); assert.equal(attempts, 3); assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(retries, [{ attempt: 1, status: 429, delayMs: 0 }, { attempt: 2, status: 529, delayMs: 0 }]);
  let failures = 0; await assert.rejects(generate(request(), async () => { failures++; return new Response('Never forwarded', { status: 503, headers: { 'retry-after': '0' } }); }), /HTTP 503/); assert.equal(failures, 3);
});

test('nontransient status, network failure and midstream errors are never retried', async () => {
  for (const status of [400, 401, 402, 404, 500]) {
    let calls = 0; await assert.rejects(generate(request(), async () => { calls++; return new Response('Never forward this body', { status }); }), new RegExp(`HTTP ${status}`)); assert.equal(calls, 1);
  }
  let calls = 0; await assert.rejects(generate(request(), async () => { calls++; throw new Error('Opaque network failure'); }), /Не удалось связаться/); assert.equal(calls, 1);
  const deltas: string[] = []; calls = 0;
  await assert.rejects(generate(request({ onDelta: text => deltas.push(text) }), async () => { calls++; return sse([{ choices: [{ delta: { content: 'Useful partial text' } }] }, { error: { message: 'known-artificial-fixture-value' } }]); }), /прервал/);
  assert.equal(calls, 1); assert.equal(deltas.join(''), 'Useful partial text');
});

test('retry respects stop and refuses Retry-After above the bounded wait instead of retrying early', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = generate(request({ signal: controller.signal, onRetry: () => { controller.abort(); } }), async () => { calls++; return new Response('Ignored', { status: 429, headers: { 'retry-after': '5' } }); });
  await assert.rejects(pending, /остановлена/); assert.equal(calls, 1);
  calls = 0; await assert.rejects(generate(request(), async () => { calls++; return new Response('Ignored', { status: 429, headers: { 'retry-after': '11' } }); }), /HTTP 429/); assert.equal(calls, 1);
  const now = Date.parse('2026-10-07T00:00:00Z'); assert.equal(retryDelay('Wed, 07 Oct 2026 00:00:02 GMT', 1, now), 2000); assert.equal(retryDelay('invalid', 2, now), 1000);
});

test('idle timeout resets for every stream chunk while a stalled reader is cancelled', async () => {
  const encoder = new TextEncoder(); let interval: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { let chunks = 0; interval = setInterval(() => { controller.enqueue(encoder.encode(': heartbeat\n\n')); if (++chunks === 5) { clearInterval(interval); controller.enqueue(encoder.encode('data: {"ok":true}\n\n')); controller.close(); } }, 15); }, cancel() { clearInterval(interval); } });
  const events: unknown[] = []; await requestJson(request(), 'chat/completions', {}, {}, event => events.push(event), async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), 40);
  assert.deepEqual(events, [{ ok: true }]);
  let cancelled = false; const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(requestJson(request(), 'chat/completions', {}, {}, () => undefined, async () => new Response(stalled, { headers: { 'content-type': 'text/event-stream' } }), 10), /не ответил/); assert.equal(cancelled, true);
});

test('runtime retry journal preserves one logical step and one original user', async () => {
  const f = harnessFixture(); let attempts = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++attempts < 3 ? new Response('Ignored', { status: 502, headers: { 'retry-after': '0' } }) : reply('Done', { prompt_tokens: 10, completion_tokens: 3 }) }).run({ sessionId: 's', text: 'Task', attachmentIds: [] });
  assert.equal(attempts, 3); assert.equal(f.lastRun().steps, 1); assert.equal(f.lastRun().stepLog[0].retries, 2); assert.equal(f.messages.filter(item => item.role === 'user').length, 1);
});

test('usage received before stream failure remains safe billing metadata in the error and journal', async () => {
  const f = harnessFixture();
  const fetcher = async () => sse([{ choices: [{ delta: { content: 'Partial' } }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }, { error: { message: 'Opaque server body' } }]);
  await assert.rejects(generate(request(), fetcher), error => error instanceof ModelGenerationFailure && error.usage?.costUsd === 0.001 && !error.message.includes('Opaque'));
  await new AgentRuntime(f.deps, { fetch: fetcher }).run({ sessionId: 's', text: 'Task', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'error'); assert.equal(f.lastRun().usage.costUsd, 0.001); assert.equal(f.lastRun().usage.costSource, 'api');
});

test('auto title uses a separate bounded tool-free prompt, disabled reasoning, and returns reported billing', async () => {
  let body: any;
  const generated = await generateTitle({ model: { ...fixtureModel, model: 'google/gemini-2.5-flash-lite', maxOutputTokens: 16000, reasoningEffort: 'high' }, apiKey: 'known-artificial-fixture-value', firstUser: 'Task '.repeat(1000), finalAnswer: 'Answer '.repeat(1000), signal: new AbortController().signal }, async (_url, init) => { body = JSON.parse(String(init?.body)); return reply('« Исправление загрузки изображений »', { prompt_tokens: 30, completion_tokens: 5, cost: 0.00001 }); });
  assert.equal(generated.title, 'Исправление загрузки изображений'); assert.equal(generated.usage!.costUsd, 0.00001);
  assert.equal(body.max_tokens, 128); assert.equal(body.tools, undefined); assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.messages.length, 2); const snippets = JSON.parse(body.messages[1].content); assert.equal(snippets.task.length, 2000); assert.equal(snippets.outcome.length, 2000);
  assert.equal(body.messages.some((item: any) => item.images || item.tool_calls || item.reasoning_details), false);
});

test('truncated/invalid title never becomes a successful title and preserves reported usage in failure', async () => {
  const input = { model: fixtureModel, apiKey: 'known-artificial-fixture-value', firstUser: 'Task', finalAnswer: 'Done', signal: new AbortController().signal };
  await assert.rejects(generateTitle(input, async () => reply('Partial title', { prompt_tokens: 2, completion_tokens: 128, cost: 0.0001 }, 'length')), error => error instanceof ModelGenerationFailure && error.usage!.costUsd === 0.0001);
  await assert.rejects(generateTitle(input, async () => reply('')), /некорректный заголовок/);
});
