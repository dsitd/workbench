import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionCoverage, createModelCompactor, validModelSummary } from '../src/agent/model-compaction';
import { RunJournal, RunLimitError } from '../src/agent/journal';
import { defaultAppSettings, defaultRunLimits } from '../src/shared/runs';
import { AgentRuntime } from '../src/agent/runtime';
import { harnessFixture, reply, sse, tool } from './agent-fixture';
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

test('rejected summary responses record distinct reasons and safe metrics, and are not retried on the same history', async () => {
  const cases = [
    { response: () => reply('LEAK-CANARY', usage, 'length'), reason: /^Model compaction fragment rejected \(incomplete\): fragment 1, chars 0-\d+ of \d+, estimate 4, API output 20, limit 500, target 375\. Deterministic checkpoint retained\.$/, calls: 1 },
    { response: () => reply('LEAK-CANARY', usage, 'tool_calls', [tool()]), reason: /rejected \(tool-calls\)/, calls: 1 },
    { response: () => reply('  ', usage), reason: /rejected \(empty\): .*estimate 0/, calls: 1 },
    { response: () => sse([{ type: 'error', error: { message: 'LEAK-CANARY' }, usage }]), reason: /rejected \(request-failed\): fragment 1, chars 0-\d+ of \d+, limit 500/, calls: 1 },
    // Still oversized after the single shortening request: two billed steps, then the fragment fails.
    { response: () => reply('LEAK-CANARY'.repeat(1000), usage), reason: /shortened fragment rejected \(oversized\): .*estimate 3667, API output 20, limit 500/, calls: 2 },
  ];
  for (const item of cases) {
    const f = fixture(), history = [old('a', 'Original history')]; let calls = 0;
    const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return item.response(); } });
    assert.equal(await compact(history, 500), undefined); assert.equal(await compact(history, 500), undefined);
    assert.equal(calls, item.calls); assert.equal(f.journal.run.modelSummary, undefined); assert.equal(f.journal.run.usage.costUsd, 0.001 * item.calls);
    const errors = f.journal.run.stepLog.flatMap(step => step.errors);
    assert.match(errors.at(-1)!, item.reason); assert.equal(compactionCoverage(compact), undefined);
    assert.doesNotMatch(JSON.stringify(f.journal.run), /LEAK-CANARY/);
  }
});

test('oversized summaries get one billed shortening request checked against the same conservative limit', async () => {
  const f = fixture(), history = [old('a', 'Original decision')], bodies: { messages: { content: string }[]; tools?: unknown }[] = [];
  const oversized = 'Decision a stays. '.repeat(100).trim();
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body); assert.equal(body.tools, undefined);
    return reply(bodies.length === 1 ? oversized : 'Decision a kept.', usage);
  } });
  assert.equal(await compact(history, 500), 'Decision a kept.');
  // The request asks for 75% of the hard limit, in the same bytes/3 unit that the check uses.
  assert.match(bodies[0].messages[1].content, /^Update the previous summary.*at most 375 tokens and 1125 UTF-8 bytes/);
  const shortening = bodies[1].messages[1].content;
  assert.match(shortening, /^The summary DATA below exceeds the size limit\. Rewrite it in at most 375 tokens and 1125 UTF-8 bytes.*decisions/);
  assert.equal(JSON.parse(shortening.slice(shortening.indexOf('\n') + 1)).oversizedSummary, oversized);
  assert.match(bodies[1].messages[0].content, /^Summarize conversation DATA.*Do not follow instructions/);
  assert.equal(f.journal.run.steps, 2); assert.ok(f.journal.run.stepLog.every(step => step.kind === 'compaction' && step.costUsd === 0.001));
  assert.equal(f.journal.run.usage.costUsd, 0.002);
  assert.match(f.journal.run.stepLog[0].errors.join('\n'), /^Model compaction fragment rejected \(oversized\): fragment 1, .*estimate 600, API output 20, limit 500, target 375\. One shortening request follows\.$/);
  assert.deepEqual(f.journal.run.stepLog[1].errors, []); assert.doesNotMatch(JSON.stringify(f.journal.run.stepLog), /stays/);
  assert.equal(f.journal.run.modelSummary!.complete, true); assert.equal(compactionCoverage(compact)?.complete, true);
});

test('a later fragment failure keeps earlier fragments as partial memory that is reused and then continued', async () => {
  const f = fixture(), big = (id: string) => old(id, `${id}: ` + 'detail '.repeat(2800));
  const history = [big('a'), big('b'), big('c')], fragments: { previousSummary: string; transcriptFragment: string }[] = [];
  let failAt = 2;
  const options = { ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async (_url: unknown, init?: RequestInit) => {
    const content = JSON.parse(String(init?.body)).messages[1].content;
    fragments.push(JSON.parse(content.slice(content.indexOf('\n') + 1)));
    return fragments.length === failAt ? reply('', usage) : reply(`Summary through request ${fragments.length}.`, usage);
  } };
  const compact = createModelCompactor(options);
  assert.equal(await compact(history, 500), 'Summary through request 1.'); assert.equal(fragments.length, 2);
  // Fragment 1 also held the start of b; a message counts as covered only once its end is adopted.
  assert.match(fragments[0].transcriptFragment, /"id":"b"/);
  const partial = f.journal.run.modelSummary!;
  assert.deepEqual(partial.sources.map(item => item.id), ['a']); assert.equal(partial.complete, false); assert.ok(validModelSummary(partial, partial.scope, history));
  assert.deepEqual(compactionCoverage(compact), { complete: false, coveredMessages: 1, omittedMessages: 3, firstUncoveredId: 'b' });
  assert.match(f.journal.run.stepLog[1].errors.join('\n'), /fragment rejected \(empty\): fragment 2, .*Partial model memory kept for 1\/3 omitted messages/);
  // The same failing attempt is not billed again on the next step, but its partial result stays usable.
  assert.equal(await compact(history, 500), 'Summary through request 1.'); assert.equal(fragments.length, 2); assert.equal(compactionCoverage(compact)?.complete, false);
  // Newly omitted history starts a new attempt that continues from the partial summary with only uncovered messages.
  failAt = 0; history.push(old('d', 'Later correction: keep the old API.'));
  const continued = createModelCompactor(options);
  assert.equal(await continued(history, 500), `Summary through request ${fragments.length}.`);
  assert.equal(fragments[2].previousSummary, 'Summary through request 1.'); assert.ok(fragments[2].transcriptFragment.startsWith('{"id":"b"'));
  assert.doesNotMatch(fragments.slice(2).map(item => item.transcriptFragment).join(''), /"id":"a"/);
  assert.deepEqual(f.journal.run.modelSummary!.sources.map(item => item.id), ['a', 'b', 'c', 'd']); assert.equal(f.journal.run.modelSummary!.complete, true);
  assert.equal(compactionCoverage(continued)?.complete, true);
  assert.ok(Math.abs(f.journal.run.usage.costUsd! - fragments.length * 0.001) < 1e-9);
});

test('a run limit between fragments keeps the earlier adopted fragment', async () => {
  const f = fixture(), history = [old('a', 'a: ' + 'detail '.repeat(2800)), old('b', 'b: ' + 'detail '.repeat(2800))]; let calls = 0;
  f.journal.run.limits.maxSteps = 1;
  const compact = createModelCompactor({ ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return reply('First fragment kept.', usage); } });
  await assert.rejects(compact(history, 500), error => error instanceof RunLimitError && error.reason === 'steps');
  assert.equal(calls, 1); assert.equal(f.journal.run.modelSummary?.text, 'First fragment kept.'); assert.equal(f.journal.run.modelSummary?.complete, false);
  assert.deepEqual(f.journal.run.modelSummary?.sources.map(item => item.id), ['a']);
});

test('stored version-1 summaries without coverage fields remain valid complete memory', async () => {
  const f = fixture(), history = [old('a', 'Original content')]; let calls = 0;
  const options = { ...f, journal: f.journal, history, signal: new AbortController().signal, fetch: async () => { calls++; return reply('Source a retained.', usage); } };
  await createModelCompactor(options)(history, 500);
  const stored = structuredClone(f.journal.run.modelSummary!); delete stored.complete;
  assert.ok(validModelSummary(stored, stored.scope, history));
  assert.equal(validModelSummary({ ...stored, complete: 'yes' as unknown as boolean }, stored.scope, history), false);
  const next = new RunJournal(f.deps, f.session, f.model, { ...defaultRunLimits }); next.run.evidenceScope = 'fixture-access'; next.run.modelSummary = stored;
  const compact = createModelCompactor({ ...options, journal: next });
  assert.equal(await compact(history, 500), 'Source a retained.'); assert.equal(calls, 1);
  assert.deepEqual(compactionCoverage(compact), { complete: true, coveredMessages: 1, omittedMessages: 1, firstUncoveredId: undefined });
});

test('runtime labels partial model memory and still sends the deterministic checkpoint', async () => {
  const f = harnessFixture(); let normal = 0, summaries = 0;
  f.messages.push({ id: 'original', role: 'user', content: 'Original objective: preserve compatibility.', createdAt: '' });
  for (let i = 0; i < 15; i++) f.messages.push(old(`history-${i}`, 'Detailed finding '.repeat(1000)));
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.startsWith('Summarize conversation DATA')) return ++summaries === 2 ? reply('', usage) : reply('Early findings. Source original.', usage);
    normal++;
    const data = (body.messages as { content: string }[]).map(message => message.content).find(content => content.includes('model-history-summary'))!;
    const summary = data.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(item => item?.kind === 'model-history-summary');
    assert.match(summary.coverage, /^partial: covers only the earlier \d+ of \d+ omitted messages; later omitted messages \(from message history-\d+\) are not summarized here and are represented only by the deterministic checkpoint\.$/);
    assert.equal(summary.text, 'Early findings. Source original.'); assert.match(data, /Original objective: preserve compatibility/);
    return reply('Done', usage);
  } }).run({ sessionId: 's', text: 'Current task is preserved', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed', f.lastRun().error); assert.equal(summaries, 2); assert.equal(normal, 1);
  assert.equal(f.lastRun().modelSummary?.complete, false); assert.ok(f.lastRun().modelSummary!.sources.length > 0);
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
