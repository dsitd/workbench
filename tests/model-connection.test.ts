import test from 'node:test';
import assert from 'node:assert/strict';
import { testModelConnection } from '../src/agent/connection';
import { modelPresets } from '../src/shared/model-presets';
import type { ModelConfig } from '../src/shared/types';
import type { Fetcher } from '../src/agent/http';

const model: ModelConfig = { id: 'probe', ...modelPresets[0].configuration };
const credential = 'fixture-credential-placeholder';
const reasoning = [{ type: 'reasoning.encrypted', id: 'probe-thinking', data: 'fixture-encrypted-data', format: 'anthropic-claude-v1', index: 0 }];
const reply = (message: unknown, usage?: unknown) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage }), {
  headers: { 'content-type': 'application/json' },
});
const toolReply = (value: string, name = 'workbench_echo', usage?: unknown) => reply({ content: '', reasoning_details: reasoning, tool_calls: [
  { id: 'echo-id', type: 'function', function: { name, arguments: JSON.stringify({ value }) } },
] }, usage);
const nonce = (body: any): string => {
  const value = JSON.stringify(body).match(/workbench-[a-f0-9-]{36}/)?.[0];
  assert.ok(value, 'The probe needs its own nonce, without project data.');
  return value;
};

test('connection probe uses two bounded requests and preserves the exact tool result ID', async () => {
  const bodies: any[] = [];
  const urls: string[] = [];
  const report = await testModelConnection(model, credential, async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.deepEqual(body.provider, { max_price: { prompt: 2, completion: 10 } });
    if (bodies.length === 1) {
      assert.deepEqual(body.tools.map((item: any) => item.function.name), ['workbench_echo']);
      assert.deepEqual(body.messages.map((item: any) => item.role), ['system', 'user']);
      return toolReply(nonce(body));
    }
    assert.deepEqual(body.messages.map((item: any) => item.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(body.messages[2].tool_calls[0].id, 'echo-id');
    assert.deepEqual(body.messages[2].reasoning_details, reasoning);
    assert.equal(body.messages[3].tool_call_id, 'echo-id');
    assert.equal(JSON.parse(body.messages[3].content).value, nonce(bodies[0]));
    assert.ok(!body.tools?.length);
    return reply({ content: 'WORKBENCH_READY' });
  });
  assert.deepEqual(urls, Array(2).fill('https://openrouter.ai/api/v1/chat/completions'));
  assert.equal(report.ok, true);
  assert.equal(report.toolCalling, true);
  assert.equal(report.modelId, model.id);
  assert.ok(!JSON.stringify(report).includes(credential));
});

test('Sonnet probe reports the sum of billed costs only when both responses include finite nonnegative usage', async () => {
  for (const costs of [[0.002, 0.003], [0.002, undefined], [-1, 0.003]]) {
    let count = 0;
    const report = await testModelConnection(model, credential, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const usage = { prompt_tokens: 100, completion_tokens: 20, cost: costs[count] };
      count++;
      return count === 1 ? toolReply(nonce(body), 'workbench_echo', usage) : reply({ content: 'WORKBENCH_READY' }, usage);
    });
    assert.equal(report.ok, true);
    assert.equal(report.costUsd, costs[0] === 0.002 && costs[1] === 0.003 ? 0.005 : undefined);
  }
});

test('SSE usage costs are preserved through the same bounded Sonnet probe', async () => {
  let count = 0;
  const report = await testModelConnection(model, credential, async (_url, init) => {
    count++;
    if (count === 1) return toolReply(nonce(JSON.parse(String(init?.body))), 'workbench_echo', { prompt_tokens: 100, completion_tokens: 20, cost: 0.002 });
    const events = [
      { choices: [{ index: 0, delta: { content: 'WORKBENCH_READY' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5, cost: 0.001 } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal(report.ok, true);
  assert.equal(report.costUsd, 0.003);
});

test('OpenRouter probe price controls and USD billing are not assumed for other compatible API origins', async () => {
  let count = 0;
  const report = await testModelConnection({ ...model, baseUrl: 'http://127.0.0.1:12345/v1', model: 'fixture' }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.provider, undefined); assert.equal(body.reasoning, undefined);
    count++;
    return count === 1 ? toolReply(nonce(body), 'workbench_echo', { cost: 1 }) : reply({ content: 'WORKBENCH_READY' }, { cost: 2 });
  });
  assert.equal(report.ok, true); assert.equal(report.costUsd, undefined);
});

test('missing credentials and demonstration mode perform no HTTP requests', async () => {
  let requests = 0;
  const fetcher: Fetcher = async () => { requests++; return reply({ content: '' }); };
  const missing = await testModelConnection(model, undefined, fetcher);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /API-ключ/);
  const demo = await testModelConnection({ ...model, kind: 'demo' }, undefined, fetcher);
  assert.equal(demo.ok, false);
  assert.equal(requests, 0);
});

test('reasoning models with a too-small probe budget fail before a billable request', async () => {
  let requests = 0;
  const report = await testModelConnection({ ...model, maxOutputTokens: 512 }, credential, async () => { requests++; return reply({ content: '' }); });
  assert.equal(report.ok, false);
  assert.match(report.message, /2048/);
  assert.equal(requests, 0);
});

test('unexpected tools or wrong arguments fail without executing or continuing them', async () => {
  for (const variant of ['run_command', 'wrong-nonce']) {
    let requests = 0;
    const report = await testModelConnection(model, credential, async (_url, init) => {
      requests++;
      return variant === 'run_command' ? toolReply(nonce(JSON.parse(String(init?.body))), 'run_command') : toolReply('wrong-nonce');
    });
    assert.equal(report.ok, false);
    assert.equal(report.toolCalling, false);
    assert.equal(requests, 1);
  }
});

test('a tool call alone does not count as a successful connection', async () => {
  let requests = 0;
  const report = await testModelConnection(model, credential, async (_url, init) => {
    requests++;
    return requests === 1 ? toolReply(nonce(JSON.parse(String(init?.body)))) : reply({ content: 'Not WORKBENCH_READY' });
  });
  assert.equal(report.ok, false);
  assert.equal(report.toolCalling, true);
  assert.equal(requests, 2);
});

test('provider error bodies never enter the connection report', async () => {
  const report = await testModelConnection(model, credential, async () => new Response(`Provider echoed ${credential}`, { status: 401 }));
  assert.equal(report.ok, false);
  assert.match(report.message, /HTTP 401/);
  assert.ok(!JSON.stringify(report).includes(credential));
});

test('closing the application can cancel an in-flight probe without a second request', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  const pending = testModelConnection(model, credential, async (_url, init) => {
    requests++; entered();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
  }, controller.signal);
  await started;
  controller.abort();
  const report = await pending;
  assert.equal(report.ok, false);
  assert.match(report.message, /остановлена/);
  assert.equal(requests, 1);
  const alreadyStopped = await testModelConnection(model, credential, async () => { requests++; return reply({ content: '' }); }, controller.signal);
  assert.equal(alreadyStopped.ok, false);
  assert.equal(requests, 1);
});
