import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gateway } from '../../scripts/harness-pilot/gateway';
import { resolvePilotModel } from '../../scripts/harness-pilot/models';

const flashId = 'deepseek/deepseek-v4.1-flash-1017';
const upstreamOk = { id: 'mock', provider: 'Together', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } };

test('new comparison can honor bounded reviewer output while legacy campaigns keep their frozen cap', async () => {
  for (const honor of [false, true]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'gateway-output-')); let observed: any;
    const proxy = await gateway(path.join(directory, 'billing.json'), async () => 'local-test-placeholder', false,
      { calls: 0, usd: 2, taskUsd: 0.25 }, resolvePilotModel(flashId), false, async (_url, init) => {
        observed = JSON.parse(String(init.body)); return new Response(JSON.stringify(upstreamOk), { status: 200 });
      }, honor);
    try {
      proxy.select('prototype', 'test');
      const response = await fetch(`http://127.0.0.1:${proxy.port}/prototype/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ max_tokens: 3000, messages: [] }) });
      await response.text(); assert.equal(response.status, 200); assert.equal(observed.max_tokens, honor ? 3000 : 6000);
    } finally { proxy.close(); }
  }
});

// Offline harness: the transport is a local mock, so no network or credential is ever used.
async function harness(modelId: string | undefined, limits = { calls: 0, usd: 10, taskUsd: 5 }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-size-'));
  let dispatched = 0;
  const proxy = await gateway(path.join(dir, 'billing.json'), async () => 'test-only-placeholder', false, limits, resolvePilotModel(modelId), false,
    async () => { dispatched++; return new Response(JSON.stringify(upstreamOk), { status: 200 }); });
  proxy.select('pi', 'size-task');
  const send = async (bytes: number) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/pi/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(bytes) }] }) });
    return { status: response.status, code: ((await response.json()) as any).error?.code as string | undefined };
  };
  return { proxy, send, dispatched: () => dispatched, file: path.join(dir, 'billing.json') };
}

test('model request-size ceilings are explicit and bounded', () => {
  assert.equal(resolvePilotModel(flashId).maxRequestBytes, 1_000_000);
  for (const id of ['openai/gpt-6-luna', 'openai/gpt-6-sol', 'openai/gpt-6.1-sol']) assert.equal(resolvePilotModel(id).maxRequestBytes, 200_000);
});

test('Flash admits a 200K-1M request, records the limit, and rejects over 1M before dispatch', async () => {
  const h = await harness(flashId);
  try {
    assert.deepEqual(await h.send(500_000), { status: 200, code: undefined });
    assert.equal(h.dispatched(), 1);
    assert.deepEqual(await h.send(1_000_001), { status: 413, code: 'request-size' });
    assert.equal(h.dispatched(), 1);
    assert.equal(h.proxy.ledger.maxRequestBytes, 1_000_000);
    assert.equal(JSON.parse(await readFile(h.file, 'utf8')).maxRequestBytes, 1_000_000);
  } finally { h.proxy.close(); }
});

test('legacy GPT models still reject requests over 200K before dispatch', async () => {
  const h = await harness(undefined);
  try {
    assert.deepEqual(await h.send(250_000), { status: 413, code: 'request-size' });
    assert.equal(h.dispatched(), 0);
    assert.equal(h.proxy.ledger.maxRequestBytes, 200_000);
  } finally { h.proxy.close(); }
});

test('a large Flash reservation cannot bypass task or campaign dollar caps', async () => {
  // 900 KB reserves ~(908192*0.3+7200)/1e6 = $0.28.
  const task = await harness(flashId, { calls: 0, usd: 10, taskUsd: 0.2 });
  try {
    assert.deepEqual(await task.send(900_000), { status: 402, code: 'budget' });
    assert.equal(task.dispatched(), 0); assert.equal(task.proxy.ledger.chargedUsd, 0);
  } finally { task.proxy.close(); }
  const campaign = await harness(flashId, { calls: 0, usd: 0.2, taskUsd: 5 });
  try {
    assert.deepEqual(await campaign.send(900_000), { status: 402, code: 'budget' });
    assert.equal(campaign.dispatched(), 0); assert.equal(campaign.proxy.ledger.chargedUsd, 0);
  } finally { campaign.proxy.close(); }
});
