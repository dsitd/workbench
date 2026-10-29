import test from 'node:test';
import assert from 'node:assert/strict';
import { observedActionDiff } from '../src/agent/action-diff';
import type { ModelMessage } from '../src/shared/agent';
import type { ToolCall } from '../src/shared/types';

const observation = (id: string, name: string, args: Record<string, unknown>, value: unknown, error = false): ModelMessage[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] },
  { role: 'tool', toolCallId: id, toolName: name, content: JSON.stringify(value), error },
];
const action: ToolCall = { id: 'change', name: 'update_booking', arguments: {
  booking_id: 'B1', cabin: 'standard', routes: [{ number: 'F1', date: '2026-11-01' }], payment_id: 'P1',
} };

test('distinguishes a changed field from unchanged nested route arguments despite an overloaded mutator name', () => {
  const diff = observedActionDiff(action, observation('read', 'get_booking', { booking_id: 'B1' }, {
    booking_id: 'B1', cabin: 'basic', routes: [{ number: 'F1', date: '2026-11-01', price: 80, origin: 'AAA' }],
  }));
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0].equal, ['routes']);
  assert.deepEqual(diff[0].different, { cabin: { observed: 'basic', proposed: 'standard' } });
  assert.deepEqual(diff[0].notInObservation, ['payment_id']);
  assert.equal(diff[0].sourceToolCallId, 'read');
});

test('changing a route, its date, or array length is not labelled unchanged', () => {
  for (const routes of [[{ number: 'F2', date: '2026-11-01' }], [{ number: 'F1', date: '2026-11-02' }], []]) {
    const diff = observedActionDiff({ ...action, arguments: { ...action.arguments, routes } }, observation('r', 'read', { booking_id: 'B1' }, { booking_id: 'B1', routes: action.arguments.routes }));
    assert.ok(diff[0].different.routes); assert.deepEqual(diff[0].equal, []);
  }
});

test('a foreign user_id in an order is not confused with the profile read identified by user_id', () => {
  const call: ToolCall = { id: 'w', name: 'update_profile', arguments: { user_id: 'U1', address: 'new' } };
  const history = [...observation('profile', 'get_profile', { user_id: 'U1' }, { user_id: 'U1', address: 'old' }),
    ...observation('order', 'get_order', { order_id: 'O1' }, { order_id: 'O1', user_id: 'U1', address: 'new' })];
  const diff = observedActionDiff(call, history);
  assert.equal(diff.length, 1); assert.equal(diff[0].sourceToolCallId, 'profile');
  assert.deepEqual(diff[0].different.address, { observed: 'old', proposed: 'new' });
});

test('latest successful matching state wins; a later failed or opaque call invalidates the previous comparison', () => {
  const history = [...observation('old', 'get_booking', { booking_id: 'B1' }, { booking_id: 'B1', cabin: 'basic' }),
    ...observation('new', 'update_booking', { booking_id: 'B1', cabin: 'standard' }, { booking_id: 'B1', cabin: 'standard' })];
  assert.deepEqual(observedActionDiff(action, history)[0].equal, ['cabin']);
  for (const last of [observation('failed', 'change', { booking_id: 'B1' }, 'Unknown outcome', true), observation('opaque', 'change', { booking_id: 'B1' }, { ok: true })])
    assert.deepEqual(observedActionDiff(action, [...history, ...last]), []);
  assert.deepEqual(observedActionDiff(action, [...history, ...observation('other-payment', 'change', { booking_id: 'B1', payment_id: 'P2' }, { ok: true })]), []);
});

test('does not invent a snapshot from assistant prose, failed observations, unknown refs or ambiguous wrappers', () => {
  assert.deepEqual(observedActionDiff(action, [{ role: 'assistant', content: '{"booking_id":"B1","cabin":"basic"}' }]), []);
  assert.deepEqual(observedActionDiff(action, observation('x', 'get_booking', { booking_id: 'OTHER' }, { booking_id: 'B1', cabin: 'basic' })), []);
  assert.deepEqual(observedActionDiff(action, observation('x', 'get_booking', { booking_id: 'B1' }, [{ booking_id: 'B1', cabin: 'basic' }, { booking_id: 'B1', cabin: 'standard' }])), []);
});
