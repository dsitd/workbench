import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply, sse, tool } from './agent-fixture';

const task = { sessionId: 's', text: 'Read README and finish.', attachmentIds: [] };
const strictMessages = (f: ReturnType<typeof harnessFixture>) => {
  f.deps.appendMessage = async (_sessionId, value) => {
    if (f.messages.some(message => message.id === value.id)) throw new Error('Message already exists.');
    f.messages.push(structuredClone(value));
  };
};

test('failing UI notifications cannot orphan persisted calls or discard API billing', async () => {
  const f = harnessFixture(); strictMessages(f);
  const notifications: string[] = [];
  f.deps.emit = event => { notifications.push(event.type); throw new Error('Artificial notification transport failure'); };
  let requests = 0, executed = 0;
  f.deps.executeTool = async () => { executed++; return { text: 'Observed README' }; };
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? sse([
    { choices: [{ delta: { content: 'Inspecting README. ', tool_calls: [{ index: 0, ...tool() }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 } },
  ]) : reply('Verified result', { prompt_tokens: 110, completion_tokens: 11, cost: 0.004 }) }).run(task);
  assert.equal(requests, 2); assert.equal(executed, 1); assert.equal(f.session.status, 'completed');
  assert.deepEqual(f.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(f.messages[1].toolCalls![0].id, f.messages[2].toolCallId);
  assert.equal(new Set(f.messages.map(message => message.id)).size, f.messages.length);
  assert.equal(f.lastRun().status, 'completed'); assert.equal(f.lastRun().usage.costSource, 'api');
  assert.ok(Math.abs(f.lastRun().usage.costUsd! - 0.0163) < 1e-12);
  for (const type of ['run', 'context', 'delta', 'message', 'status', 'tool-start', 'tool-end']) assert.ok(notifications.includes(type), type);
});

test('bookkeeping failure pairs announced calls and saves their charge even when notifications fail', async () => {
  const f = harnessFixture(); strictMessages(f);
  f.deps.emit = () => { throw new Error('Artificial notification transport failure'); };
  const save = f.deps.saveRun!;
  f.deps.saveRun = async run => { if (run.phase === 'tools') throw new Error('Artificial journal storage failure'); await save(run); };
  let executed = 0; f.deps.executeTool = async () => { executed++; return { text: 'Unexpected execution' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('', { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 }, 'tool_calls', [tool('one'), tool('two')]) }).run(task);
  assert.equal(executed, 0); assert.equal(f.session.status, 'error'); assert.equal(f.lastRun().status, 'error');
  assert.deepEqual(f.messages.filter(message => message.role === 'tool').map(message => message.toolCallId), ['one', 'two']);
  assert.equal(new Set(f.messages.map(message => message.id)).size, f.messages.length);
  assert.equal(f.lastRun().usage.costSource, 'api'); assert.equal(f.lastRun().usage.costUsd, 0.0123);
});

test('UI notification failures never approve a denied action', async () => {
  const f = harnessFixture({}, { mode: 'ask' }); strictMessages(f);
  f.deps.emit = () => { throw new Error('Artificial notification transport failure'); };
  let approved = 0, executed = 0, requests = 0;
  f.deps.approveTool = async () => { approved++; return false; };
  f.deps.executeTool = async () => { executed++; return { text: 'Unexpected execution' }; };
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1 ? reply('', undefined, 'tool_calls', [tool()]) : reply('Action declined') }).run(task);
  assert.equal(approved, 1); assert.equal(executed, 0);
  assert.equal(f.messages.find(message => message.role === 'tool')!.error, true);
  assert.match(f.messages.find(message => message.role === 'tool')!.content, /отклонил/);
});

test('a possible one-hour cache write is reserved before submitting the paid request', async () => {
  const selectedModel = { model: 'anthropic/claude-sonnet-5.5', inputPricePerMillion: 100, outputPricePerMillion: 0, cacheWritePricePerMillion: 125, maxOutputTokens: 1 };
  const sizing = harnessFixture(selectedModel, { runLimits: { maxCostUsd: 100 } });
  let baselineInput = 0;
  sizing.deps.saveContext = report => { baselineInput = report.estimatedTokens; };
  await new AgentRuntime(sizing.deps, { fetch: async () => reply('Local sizing response') }).run(task);
  const limit = baselineInput * 150 / 1_000_000;
  const f = harnessFixture(selectedModel, { runLimits: { maxCostUsd: limit } });
  f.deps.getSettings = async () => ({ ...structuredClone(defaultAppSettings), promptCache: { enabled: true, ttl: '1h' } });
  let requests = 0, input = 0;
  f.deps.saveContext = report => { input = report.estimatedTokens; };
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply('Unexpected request'); } }).run(task);
  assert.ok(input * 100 / 1_000_000 < limit); assert.ok(input * 200 / 1_000_000 > limit);
  assert.equal(requests, 0); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'cost');
  assert.equal(f.lastRun().usage.costUsd, 0); assert.equal(f.lastRun().usage.unknownCostCalls, undefined);
});
