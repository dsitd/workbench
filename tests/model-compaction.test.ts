import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCompactor, validModelSummary } from '../src/agent/model-compaction';
import { RunJournal, RunLimitError } from '../src/agent/journal';
import { defaultAppSettings, defaultRunLimits } from '../src/shared/runs';
import { AgentRuntime } from '../src/agent/runtime';
import { harnessFixture, reply, sse } from './agent-fixture';
import type { ChatMessage } from '../src/shared/types';
const usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 };
const old = (id: string, content: string): ChatMessage => ({ id, role: 'assistant', content, createdAt: '' });
const fixture = () => {
  const f = harnessFixture({ contextWindow: 12000 }); const journal = new RunJournal(f.deps, f.session, f.model, { ...defaultRunLimits });
  journal.run.evidenceScope = 'fixture-access'; return { ...f, journal };
};

test('model compaction is incremental, source-scoped, billed and reused without another request', async () => {
  const f = fixture(), history = [old('a', 'Original decision'), old('b', 'New finding')]; let requests = 0;
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async (_url, init) => {
    requests++; const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined); assert.match(body.messages[0].content, /DATA/);
    return reply('Summary citing a and b: check the finding.', usage);
  } });
  const first = await compact(history.slice(0, 1), 800); assert.ok(first);
  assert.equal(await compact(history.slice(0, 1), 800), first); assert.equal(requests, 1);
  await compact(history, 800); assert.equal(requests, 2);
  assert.equal(f.journal.run.steps, 2); assert.equal(f.journal.run.usage.costUsd, 0.002);
  assert.ok(f.journal.run.stepLog.every(step => step.kind === 'compaction' && step.costUsd === 0.001));
  const summary = f.journal.run.modelSummary!;
  assert.ok(validModelSummary(summary, summary.scope, history));
  assert.equal(validModelSummary(summary, summary.scope, [old('a', 'Changed'), history[1]]), false);
  assert.equal(validModelSummary(summary, 'other-access', history), false);
});

test('oversized history is streamed through bounded summary requests without dropping the middle', async () => {
  const f = fixture(), history = [old('huge', 'start-' + 'middle "\\ 😀 '.repeat(9000) + '-end')];
  const fragments: string[] = [];
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const content = body.messages[1].content;
    fragments.push(JSON.parse(content.slice(content.indexOf('\n') + 1)).transcriptFragment);
    return reply('Preserved findings with source huge.', usage);
  } });
  assert.ok(await compact(history, 500)); assert.ok(fragments.length > 2);
  const reconstructed = JSON.parse(fragments.join('')); assert.equal(reconstructed.content, history[0].content);
  assert.equal(f.journal.run.steps, fragments.length); assert.equal(f.journal.run.modelSummary!.sources.length, 1);
});

test('incomplete and excessive summary responses are not adopted or retried on the same history', async () => {
  for (const response of [() => reply('Partial', usage, 'length'), () => reply('x'.repeat(10000), usage), () => reply('', usage)]) {
    const f = fixture(), history = [old('a', 'Original history')]; let calls = 0;
    const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return response(); } });
    assert.equal(await compact(history, 500), undefined); assert.equal(await compact(history, 500), undefined);
    assert.equal(calls, 1); assert.equal(f.journal.run.modelSummary, undefined); assert.equal(f.journal.run.usage.costUsd, 0.001);
    assert.ok(f.journal.run.stepLog[0].errors.length);
  }
});

test('summary provider failures retain numeric billing and cancellation cannot publish a summary', async () => {
  const f = fixture(), history = [old('a', 'Original')];
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal,
    fetch: async () => sse([{ type: 'error', error: { message: 'Opaque server fixture' }, usage }]) });
  assert.equal(await compact(history, 500), undefined); assert.equal(f.journal.run.usage.costUsd, 0.001);
  assert.equal(f.journal.run.usage.inputTokens, 100); assert.doesNotMatch(JSON.stringify(f.journal.run), /Opaque/);
  const stopped = fixture(), controller = new AbortController();
  const cancelled = createModelCompactor({ ...stopped, journal: stopped.journal, history, signal: controller.signal,
    fetch: async () => { controller.abort(); return reply('Too late', usage); } });
  await assert.rejects(cancelled(history, 500)); assert.equal(stopped.journal.run.modelSummary, undefined);
  assert.equal(stopped.journal.run.steps, 1);
});

test('summary calls share step/token/cost limits before submitting a request', async () => {
  for (const ceiling of ['steps', 'tokens', 'cost'] as const) {
    const f = fixture(); let calls = 0;
    if (ceiling === 'steps') { f.journal.run.steps = 1; f.journal.run.limits.maxSteps = 1; }
    if (ceiling === 'tokens') f.journal.run.limits.maxTokens = 10;
    if (ceiling === 'cost') { f.model.inputPricePerMillion = 100; f.model.outputPricePerMillion = 100; f.journal.run.limits.maxCostUsd = 0.001; }
    const history = [old('a', 'Original')];
    const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return reply('Wrong'); } });
    await assert.rejects(compact(history, 500), error => error instanceof RunLimitError && error.reason === ceiling); assert.equal(calls, 0);
  }
});

test('runtime summarizes only displaced history, passes a data summary, retains full local messages and itemized charges', async () => {
  const f = harnessFixture(); let normal = 0, summaries = 0;
  f.messages.push({ id: 'original', role: 'user', content: 'Original objective: preserve compatibility.', createdAt: '' });
  for (let i = 0; i < 15; i++) f.messages.push(old(`history-${i}`, 'Detailed finding '.repeat(1000)));
  const before = structuredClone(f.messages);
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.startsWith('Summarize conversation DATA')) { summaries++; return reply('Historical findings. Original objective: preserve compatibility. Source original.', usage); }
    normal++; assert.match(JSON.stringify(body), /model-history-summary/); assert.match(JSON.stringify(body), /Current task is preserved/); return reply('Done', usage);
  } }).run({ sessionId: 's', text: 'Current task is preserved', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed', f.lastRun().error); assert.ok(summaries > 0); assert.equal(normal, 1);
  assert.deepEqual(f.messages.slice(0, before.length), before); assert.equal(f.lastRun().steps, summaries + normal);
  assert.ok(Math.abs(f.lastRun().usage.costUsd! - (summaries + normal) * 0.001) < 1e-9);
});

test('runtime does not call summarizer for fitting history or when explicitly disabled', async () => {
  for (const large of [false, true]) {
    const f = harnessFixture(); let calls = 0;
    if (large) {
      f.deps.getSettings = async () => ({ ...defaultAppSettings, modelCompaction: false });
      for (let i = 0; i < 15; i++) f.messages.push(old(`history-${i}`, 'Detailed finding '.repeat(1000)));
    }
    await new AgentRuntime(f.deps, { fetch: async (_url, init) => { calls++; assert.doesNotMatch(String(init?.body), /Summarize conversation DATA/); return reply('Done', usage); } }).run({ sessionId: 's', text: 'Small task', attachmentIds: [] });
    assert.equal(calls, 1); assert.equal(f.lastRun().status, 'completed'); assert.equal(f.lastRun().modelSummary, undefined);
  }
});

test('persisted summaries survive a new run and changed source content invalidates them', async () => {
  const f = fixture(), history = [old('a', 'Original content')]; let calls = 0;
  const options = { ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return reply('Source a retained.', usage); } };
  await createModelCompactor(options)(history, 500);
  const next = new RunJournal(f.deps, f.session, f.model, { ...defaultRunLimits }); next.run.evidenceScope = 'fixture-access'; next.run.modelSummary = structuredClone(f.journal.run.modelSummary);
  assert.equal(await createModelCompactor({ ...options, journal: next })(history, 500), 'Source a retained.'); assert.equal(calls, 1);
  history[0].content = 'Changed content'; await createModelCompactor({ ...options, journal: next })(history, 500); assert.equal(calls, 2);
  assert.equal(next.run.modelSummary!.sources.length, 1);
});

test('unknown-charge summary failures are not counted as zero-cost successful requests', async () => {
  const f = fixture(), history = [old('a', 'Original')];
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal,
    fetch: async () => sse([{ type: 'error', error: { message: 'Opaque failure' } }]) });
  assert.equal(await compact(history, 500), undefined); assert.equal(f.journal.run.usage.unknownCostCalls, 1);
  assert.equal(f.journal.run.usage.costSource, 'unknown'); assert.equal(f.journal.run.modelSummary, undefined);
});
