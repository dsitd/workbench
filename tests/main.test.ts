import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../src/main/approvals';
import type { AgentEvent, ApprovalRequest } from '../src/shared/types';

const request = (id: string, sessionId: string): ApprovalRequest => ({
  id, sessionId, projectId: 'project', title: 'Command', description: 'Run a fixture', kind: 'command',
});

test('approval decisions belong to their exact request and cancelled sessions unblock', async () => {
  const events: AgentEvent[] = [];
  const broker = new ApprovalBroker(event => events.push(event));
  const first = broker.request(request('one', 'session-a'));
  const second = broker.request(request('two', 'session-b'));
  broker.respond('one', true);
  broker.cancelSession('session-b');
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(events.filter(event => event.type === 'approval').length, 2);
  assert.equal(events.filter(event => event.type === 'approval-dismissed').length, 2);
  assert.deepEqual(broker.listRequests(), []);
});

test('shutdown resolves every outstanding approval once', async () => {
  const broker = new ApprovalBroker(() => undefined);
  const pending = [broker.request(request('one', 'a')), broker.request(request('two', 'b'))];
  broker.cancelAll();
  assert.deepEqual(await Promise.all(pending), [false, false]);
  broker.respond('one', true);
});
