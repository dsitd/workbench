import test from 'node:test';
import assert from 'node:assert/strict';
import { captureContextUsage, measuredContextTokens, type ContextUsageInput } from '../src/agent/context-usage';
import { messageTokens } from '../src/agent/context-cost';
import { buildContext } from '../src/agent/context';
import { harnessFixture, reply, tool } from './agent-fixture';
import { AgentRuntime } from '../src/agent';
import type { ChatMessage } from '../src/shared/types';

const fixture = (): ContextUsageInput => ({ model: harnessFixture().model, system: 'Stable policy', tools: [], requestPolicy: 'medium-cache', messages: [
  { role: 'user', content: 'Investigate' }, { role: 'assistant', content: 'Observed code.' }, { role: 'user', content: 'Volatile map 1', contextData: true },
] });
test('usage calibration counts new messages and images, retaining the old volatile-tail overhead conservatively', () => {
  const input = fixture();
  const baseline = JSON.parse(JSON.stringify(captureContextUsage(input, 40000)));
  const next = { ...input, messages: [...input.messages.slice(0, 2), { role: 'tool' as const, content: 'New observation', toolCallId: 'call', images: [{ mimeType: 'image/png', base64: 'fixture' }] }, { role: 'user' as const, content: 'Volatile map 2', contextData: true }] };
  const growth = next.messages.slice(2).reduce((sum, m) => sum + messageTokens(next.model, m), 0);
  assert.equal(measuredContextTokens(next, baseline), 40000 + growth + 2000);
  assert.equal(baseline.prefixHashes.length, 2);
  assert.ok(!JSON.stringify(baseline).includes('Observed code'));
});
test('measurement is invalidated by old-message edits, pruning, provider, rules, tools or request policy changes', () => {
  const input = fixture(), baseline = captureContextUsage(input, 4000);
  for (const change of [
    { messages: input.messages.slice(1) }, { messages: [{ ...input.messages[0], content: 'edited' }, ...input.messages.slice(1)] },
    { model: { ...input.model, model: 'another-model' } }, { model: { ...input.model, baseUrl: 'https://different.example/v1' } },
    { system: 'Changed scope or rules' }, { requestPolicy: 'high-cache' },
    { tools: harnessFixture().deps.tools },
  ]) assert.equal(measuredContextTokens({ ...input, ...change }, baseline), undefined);
  for (const invalid of [undefined, NaN, -1, 0, 1.2, Infinity]) assert.equal(captureContextUsage(input, invalid), undefined);
});
test('measured fitting history is retained even when the heuristic exceeds the model window', async () => {
  const f = harnessFixture({ contextWindow: 200000, maxOutputTokens: 6000 });
  const messages: ChatMessage[] = [{ id: 'u', role: 'user', content: 'Inspect all files.', createdAt: '' }];
  for (let i = 0; i < 20; i++) messages.push({ id: `a${i}`, role: 'assistant', content: 'source '.repeat(2200), createdAt: '' });
  const first = await buildContext(f.deps, f.session, f.project, f.model, messages, [], new AbortController().signal);
  const baseline = captureContextUsage({ model: f.model, system: first.system, tools: [], messages: first.messages }, 50000);
  const next = await buildContext(f.deps, f.session, f.project, { ...f.model, contextWindow: 96000 }, messages, [], new AbortController().signal, { usageBaseline: baseline, selection: first.selection, checkpoint: first.checkpoint });
  assert.ok(next.report.heuristicTokens! > next.report.budget);
  assert.ok(next.report.estimatedTokens < next.report.budget);
  assert.equal(next.report.estimationSource, 'reported-plus-growth');
  assert.equal(next.report.omittedMessages, 0);
});
test('runtime persists actual input usage and applies it on the next request', async () => {
  const f = harnessFixture({ contextWindow: 96000 }); let step = 0;
  const reports: string[] = [];
  f.deps.saveContext = report => { reports.push(report.estimationSource!); };
  await new AgentRuntime(f.deps, { fetch: async () => step++ === 0
    ? reply('', { prompt_tokens: 2500, completion_tokens: 40 }, 'tool_calls', [tool('read', 'read_file', { path: 'fixture.ts' })])
    : reply('Done', { prompt_tokens: 3000, completion_tokens: 20 }) }).run({ sessionId: 's', text: 'Inspect a file', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.deepEqual(reports, ['heuristic', 'reported-plus-growth']);
  assert.equal(f.lastRun().contextUsageBaseline?.inputTokens, 3000);
});
