import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDomainRequest } from '../../scripts/harness-pilot/noncoding/policy-guard';

const policy = 'Customer service.\nCancellation requires eligibility and confirmation.';
const tools = [{ name: 'cancel_booking', description: 'Cancel an eligible booking.', parameters: {
  type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
} }];
const request = (system: string) => ({ messages: [{ role: 'system', content: system }], tools: tools.map(t => ({ type: 'function', function: t })) });

test('domain policy must reach the outbound system message; metadata or user text does not suffice', () => {
  const broken = { ...request('You are a coding agent.'), project: { instructions: policy } };
  assert.throws(() => verifyDomainRequest(broken, policy, tools), /full customer-service/);
  broken.messages.push({ role: 'user', content: policy });
  assert.throws(() => verifyDomainRequest(broken, policy, tools), /full customer-service/);
  assert.equal(verifyDomainRequest(request(`Native engine instructions.\n${policy}`), policy, tools).kind, 'agent-request');
});

test('guard rejects a partial policy and changed or missing business tools', () => {
  assert.throws(() => verifyDomainRequest(request('Customer service.'), policy, tools), /domain policy/);
  const missing = request(policy); missing.tools[0].function = { ...tools[0], name: 'other' };
  assert.throws(() => verifyDomainRequest(missing, policy, tools), /contract changed/);
  const changed = request(policy); changed.tools[0].function = { ...tools[0], description: 'Cancel any booking.' };
  assert.throws(() => verifyDomainRequest(changed, policy, tools), /contract changed/);
});

test('summarization is explicitly distinguished from a conversational agent request', () => {
  assert.deepEqual(verifyDomainRequest({ messages: [] }, policy, tools), { kind: 'non-tool-request' });
});
