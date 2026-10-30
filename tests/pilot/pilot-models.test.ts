import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveRequestCost, resolvePilotModel } from '../../scripts/harness-pilot/models';

test('pilot model selection is explicit and rejects unknown IDs instead of falling back', () => {
  assert.equal(resolvePilotModel().id, 'openai/gpt-6-luna');
  assert.equal(resolvePilotModel('openai/gpt-6-sol').id, 'openai/gpt-6-sol');
  const sol61 = resolvePilotModel('openai/gpt-6.1-sol');
  assert.equal(sol61.api, 'responses'); assert.equal(sol61.reasoning, 'medium');
  assert.equal(sol61.cacheRead, 0.1);
  for (const name of ['openai/gpt-sol', 'constructor', 'toString', '']) assert.throws(() => resolvePilotModel(name));
  const selected = resolvePilotModel('openai/gpt-6-sol'); selected.input = 0;
  assert.equal(resolvePilotModel('openai/gpt-6-sol').input, 2);
});

test('Sol budget reserves cache writes and maximum output at Sol rates, not Luna rates', () => {
  const sol = resolvePilotModel('openai/gpt-6-sol'), luna = resolvePilotModel();
  const bytes = 100_000;
  const upperBound = reserveRequestCost(sol, bytes);
  assert.equal(upperBound, 0.33048); // (100000 + 8192) at $2.50/M plus 6000 at $10/M.
  assert.ok(upperBound > ((bytes + 8192) * 2 + 6000 * 10) / 1_000_000);
  assert.ok(Math.abs(upperBound / reserveRequestCost(luna, bytes) - 20) < 1e-10);
});

test('Flash campaign pins a dated model and the Together route with peak-price reservations', () => {
  const flash = resolvePilotModel('deepseek/deepseek-v4.1-flash-1017');
  assert.equal(flash.provider, 'together');
  assert.equal(flash.reasoning, 'none');
  assert.equal(flash.api, 'chat');
  assert.equal(flash.input, 0.3); assert.equal(flash.output, 1.2);
  assert.ok(reserveRequestCost(flash, 200_000) >= (200_000 * 0.3 + 6000 * 1.2) / 1_000_000);
  assert.throws(() => resolvePilotModel('deepseek-flash'));
});
