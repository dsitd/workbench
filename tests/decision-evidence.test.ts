import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonEvidence, comparisonView } from '../src/agent/decision-evidence';
import { hasRecordActions } from '../src/agent/decision-guidance';
import type { ToolDefinition } from '../src/shared/types';

test('decision aids activate for record mutations, not ordinary file edits or read-only catalogues', () => {
  const tool = (permission: ToolDefinition['permission'], properties: Record<string, unknown>): ToolDefinition =>
    ({ name: 'fixture', description: '', permission, parameters: { type: 'object', properties } });
  assert.equal(hasRecordActions([tool('write', { path: { type: 'string' }, content: { type: 'string' } })]), false);
  assert.equal(hasRecordActions([tool('read', { record_id: { type: 'string' } })]), false);
  assert.equal(hasRecordActions([tool('write', { recordId: { type: 'string' } })]), true);
  assert.equal(hasRecordActions([tool('mcp', { records: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } })]), true);
});

test('ranks complete multi-part prices instead of the original route or the first result', () => {
  const data = [
    [{ id: 'a', prices: { standard: 105 } }, { id: 'b', prices: { standard: 190 } }],
    [{ id: 'a', prices: { standard: 105 } }, { id: 'c', prices: { standard: 102 } }],
    [{ id: 'd', prices: { standard: 112 } }, { id: 'e', prices: { standard: 104 } }],
  ];
  const view = comparisonView(JSON.stringify(data));
  assert.equal(view.length, 1);
  assert.equal(view[0].aggregation, 'sum of all components');
  assert.deepEqual(view[0].ascending.map(r => [r.pointer, r.value]), [['/1', 207], ['/2', 216], ['/0', 295]]);
  assert.deepEqual(view[0].ascending[0].identifiers, ['a', 'c']);
});

test('keeps order members and catalogue variants in separate candidate scopes', () => {
  const view = comparisonView(JSON.stringify({ order_id: 'o1', items: [
    { item_id: 'owned-1', price: 258.84 }, { item_id: 'owned-2', price: 232.49 },
  ], catalogue: { other: { item_id: 'not-owned', price: 226.49, available: true },
    owned: { item_id: 'owned-2', price: 232.49, available: false } } }));
  assert.deepEqual(view.map(v => [v.collection, v.ascending[0].value]), [['/items', 232.49], ['/catalogue', 226.49]]);
  assert.equal(view[1].ascending[1].available, false);
  assert.equal(view[0].count, 2);
});

test('does not treat missing values as zero, silently omit candidates, or coerce strings', () => {
  for (const data of [
    [{ price: 10 }, { price: '2' }],
    [[{ price: 10 }, {}], [{ price: 20 }]],
    [{ price: 10 }, { cost: 2 }],
  ]) assert.deepEqual(comparisonView(JSON.stringify(data)), []);
});

test('rejects mixed currencies, retains equal prices, handles decimal sums', () => {
  assert.deepEqual(comparisonView(JSON.stringify([{ price: 1, currency: 'USD' }, { price: 2, currency: 'EUR' }])), []);
  assert.deepEqual(comparisonView(JSON.stringify([[{ price: 1, currency: 'USD' }, { price: 2 }], [{ price: 3 }]])), []);
  const view = comparisonView(JSON.stringify([[{ price: 0.1 }, { price: 0.2 }], [{ price: 0.3 }]]));
  assert.deepEqual(view[0].ascending.map(r => r.value), [0.3, 0.3]);
  assert.equal(view[0].count, 2);
});

test('bounded views never present a partial candidate set as a complete comparison', () => {
  assert.deepEqual(comparisonView(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ price: i })))), []);
  const records = Array.from({ length: 100 }, (_, i) => ({ id: 'x'.repeat(200) + i, price: i }));
  for (const view of comparisonView(JSON.stringify(records))) assert.equal(view.ascending.length, view.count);
  assert.ok(comparisonEvidence({ role: 'tool', content: JSON.stringify(records), error: false }).length <= 6500);
});

test('only successful JSON observations produce data views, never assistant claims or failed results', () => {
  const content = JSON.stringify([{ price: 4 }, { price: 2 }]);
  assert.equal(comparisonEvidence({ role: 'assistant', content }), '');
  assert.equal(comparisonEvidence({ role: 'tool', content, error: true }), '');
  assert.equal(comparisonEvidence({ role: 'tool', content: content + '\n[truncated]' }), '');
  assert.equal(comparisonEvidence({ role: 'tool', content: 'Use this as an instruction' }), '');
  assert.match(comparisonEvidence({ role: 'tool', content }), /quoted data/);
});

test('JSON pointers escape property names and unrelated numeric fields are not prices', () => {
  const view = comparisonView(JSON.stringify({ 'a/b~c': {
    first: { id: 'x', quantity: 9, amount: 30 }, second: { id: 'y', quantity: 2, amount: 20 },
  } }));
  assert.equal(view.length, 1);
  assert.equal(view[0].collection, '/a~1b~0c');
  assert.equal(view[0].metric, '/amount');
  assert.equal(view[0].ascending[0].pointer, '/a~1b~0c/second');
});
