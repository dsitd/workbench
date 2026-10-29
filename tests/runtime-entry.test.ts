import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { appSettings } from '../src/backend/settings';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply } from './agent-fixture';

const task = { sessionId: 's', text: 'Inspect the project', attachmentIds: [] };
const usage = { prompt_tokens: 20, completion_tokens: 5, cost: 0 };

test('saved settings select the supported runtime', () => {
  for (const runtimeEngine of [undefined, 'legacy', 'pi'] as const)
    assert.equal(appSettings({ ...defaultAppSettings, runtimeEngine }).runtimeEngine, 'legacy');
  assert.throws(() => appSettings({ ...defaultAppSettings, runtimeEngine: 'invalid' as any }));
});

test('application runtime completes a task with stale saved settings', async () => {
  const f = harnessFixture(); let calls = 0;
  f.deps.getSettings = async () => ({ ...defaultAppSettings, runtimeEngine: 'pi' });
  await new AgentRuntime(f.deps, { engine: 'legacy', fetch: async () => { calls++; return reply('Done', usage); } }).run(task);
  assert.equal(calls, 1);
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().engine ?? 'legacy', 'legacy');
});

test('incompatible saved runs are rejected before effects and release the session', async () => {
  const f = harnessFixture(); let calls = 0;
  const runtime = new AgentRuntime(f.deps, { engine: 'legacy', fetch: async () => { calls++; return reply('Done', usage); } });
  await runtime.run(task);
  const parent = { ...structuredClone(f.lastRun()), engine: 'pi' as const, status: 'interrupted' as const, canContinue: true };
  f.runs.set(parent.id, parent);
  const saved = f.saved.length, messages = structuredClone(f.messages);
  await assert.rejects(runtime.resume('s', parent.id), /другой движок|несовместим/);
  assert.equal(calls, 1);
  assert.equal(f.saved.length, saved);
  assert.deepEqual(f.messages, messages);
  assert.deepEqual(f.runs.get(parent.id), parent);
  await runtime.run(task);
  assert.equal(calls, 2);
});

test('stop before dispatch cancels the request and releases the session', async () => {
  const f = harnessFixture(); let calls = 0;
  const runtime = new AgentRuntime(f.deps, { engine: 'legacy', fetch: async () => { calls++; return reply('Done', usage); } });
  const running = runtime.run(task);
  await assert.rejects(runtime.run(task), /уже выполняется/);
  await runtime.stop('s');
  await running;
  assert.equal(calls, 0);
  await runtime.run(task);
  assert.equal(calls, 1);
});
