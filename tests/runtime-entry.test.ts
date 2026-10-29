import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { appSettings } from '../src/backend/settings';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply } from './agent-fixture';

const task = { sessionId: 's', text: 'Inspect the project', attachmentIds: [] };
const usage = { prompt_tokens: 20, completion_tokens: 5, cost: 0 };
const removed = { runtimeEngine: 'pi', searchVerification: true } as Record<string, unknown>;

test('settings of removed experiments are dropped from saved settings', () => {
  for (const runtimeEngine of [undefined, 'legacy', 'pi', 'invalid']) {
    const saved = appSettings({ ...defaultAppSettings, ...removed, runtimeEngine } as any) as unknown as Record<string, unknown>;
    assert.equal('runtimeEngine' in saved, false);
    assert.equal('searchVerification' in saved, false);
  }
});

test('application runtime completes a task with stale saved settings', async () => {
  const f = harnessFixture(); let calls = 0;
  f.deps.getSettings = async () => ({ ...defaultAppSettings, ...removed } as any);
  await new AgentRuntime(f.deps, { fetch: async () => { calls++; return reply('Done', usage); } }).run(task);
  assert.equal(calls, 1);
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().engine, undefined);
});

test('incompatible saved runs are rejected before effects and release the session', async () => {
  const f = harnessFixture(); let calls = 0;
  const runtime = new AgentRuntime(f.deps, { fetch: async () => { calls++; return reply('Done', usage); } });
  await runtime.run(task);
  const parent = { ...structuredClone(f.lastRun()), engine: 'pi' as const, status: 'interrupted' as const, canContinue: true };
  f.runs.set(parent.id, parent);
  const saved = f.saved.length, messages = structuredClone(f.messages);
  await assert.rejects(runtime.resume('s', parent.id), /несовместим/);
  assert.equal(calls, 1);
  assert.equal(f.saved.length, saved);
  assert.deepEqual(f.messages, messages);
  assert.deepEqual(f.runs.get(parent.id), parent);
  await runtime.run(task);
  assert.equal(calls, 2);
});

test('stop before dispatch cancels the request and releases the session', async () => {
  const f = harnessFixture(); let calls = 0;
  const runtime = new AgentRuntime(f.deps, { fetch: async () => { calls++; return reply('Done', usage); } });
  const running = runtime.run(task);
  await assert.rejects(runtime.run(task), /уже выполняется/);
  await runtime.stop('s');
  await running;
  assert.equal(calls, 0);
  await runtime.run(task);
  assert.equal(calls, 1);
});
