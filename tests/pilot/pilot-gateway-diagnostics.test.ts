import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gateway } from '../../scripts/harness-pilot/gateway';
import { resolvePilotModel } from '../../scripts/harness-pilot/models';
import { summarizeUpstreamFailure } from '../../scripts/harness-pilot/upstream-error';

test('upstream failures classify without retaining bodies', () => {
  const secretish = 'sk-or-v1-should-never-persist';
  const cases: [number, string, string, number | string | undefined][] = [
    [404, JSON.stringify({ error: { code: 404, message: `No endpoints found that can handle the requested parameters ${secretish}` } }), 'unsupported-parameters', 404],
    [404, JSON.stringify({ error: { code: 404, message: 'No endpoints available matching your data policy' } }), 'data-policy', 404],
    [404, JSON.stringify({ error: { message: 'No allowed providers are available for the selected model' } }), 'no-endpoint', undefined],
    [404, JSON.stringify({ error: { message: 'deepseek/x is not a valid model ID' } }), 'model-not-found', undefined],
    [429, '{"error":{"code":429}}', 'rate-limit', 429],
    [502, 'not json', 'upstream-server-error', undefined],
    [404, '{"error":{"code":"weird code with spaces","message":"?"}}', 'not-found-unclassified', undefined],
  ];
  for (const [status, body, classification, code] of cases) {
    const summary = summarizeUpstreamFailure(status, body);
    assert.equal(summary.classification, classification, body);
    assert.equal(summary.code, code);
    assert.ok(!JSON.stringify(summary).includes(secretish));
  }
});

async function run(model: string, upstream: (body: any) => Response) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pilot-gw-'));
  const file = path.join(dir, 'billing.json');
  const sent: any[] = [];
  const gw = await gateway(file, async () => 'sk-or-v1-mock-credential', false, { calls: 0, usd: 1, taskUsd: 0.3 }, resolvePilotModel(model), false,
    async (_url, init) => { const body = JSON.parse(String(init.body)); sent.push({ body, auth: (init.headers as any).Authorization }); return upstream(body); });
  gw.select('workbench', 'task');
  const reply = await fetch(`http://127.0.0.1:${gw.port}/workbench/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'x', stream: false, messages: [{ role: 'user', content: 'hi' }], tools: [], parallel_tool_calls: true }) });
  const text = await reply.text();
  gw.close();
  return { reply, text, sent, ledger: JSON.parse(await readFile(file, 'utf8')), raw: await readFile(file, 'utf8') };
}

test('gateway records structured 404 diagnostics, keeps routing pins and the cost reservation', async () => {
  const body = JSON.stringify({ error: { code: 404, message: 'No endpoints found that can handle the requested parameters', metadata: { raw: 'sk-or-v1-leak' } } });
  const { reply, text, sent, ledger, raw } = await run('deepseek/deepseek-v4.1-flash-1017', () => new Response(body, { status: 404, headers: { 'x-secret': 'leak' } }));
  assert.equal(reply.status, 404);
  assert.ok(!text.includes('leak'));
  const call = ledger.calls[0];
  assert.deepEqual(call.upstreamError, { status: 404, code: 404, classification: 'unsupported-parameters' });
  assert.ok(call.requestKeys.includes('parallel_tool_calls') && call.requestKeys.includes('provider'));
  assert.ok(!raw.includes('leak') && !raw.includes('mock-credential') && !raw.includes('No endpoints found'));
  assert.deepEqual(sent[0].body.provider, { only: ['together'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0.3, completion: 1.2 } });
  assert.deepEqual(sent[0].body.reasoning, { effort: 'none' });
  assert.equal(sent[0].body.max_tokens, 6000);
  assert.ok(ledger.chargedUsd > 0, 'dispatched failures stay conservatively charged');
  assert.equal(call.state, 'uncertain');
});

test('successful GPT chat path is unchanged', async () => {
  const ok = { id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.001 } };
  const { reply, sent, ledger } = await run('openai/gpt-6-luna', () => Response.json(ok));
  assert.equal(reply.status, 200);
  assert.deepEqual(sent[0].body.provider.only, ['openai']);
  assert.equal(ledger.calls[0].state, 'reported');
  assert.equal(ledger.calls[0].upstreamError, undefined);
  assert.equal(ledger.chargedUsd, 0.001);
});
