import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/agent/context';
import { selectContextHistory, contextHash } from '../src/agent/context-selection';
import { harnessFixture } from './agent-fixture';
import type { ChatMessage } from '../src/shared/types';

const signal = () => new AbortController().signal;
function history(): ChatMessage[] {
  return [{ id: 'u', role: 'user', content: 'Keep all observations while investigating the regression.', createdAt: '' }, ...Array.from({ length: 16 }, (_, i) => [
    { id: `a${i}`, role: 'assistant' as const, content: '', createdAt: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `file${i}.ts` } }] },
    { id: `t${i}`, role: 'tool' as const, content: `file ${i}: ` + 'source '.repeat(1350), toolName: 'read_file', toolCallId: `c${i}`, createdAt: '' },
  ]).flat()];
}
test('default policy uses the model window and ignores legacy economy targets', async () => {
  const f = harnessFixture({ contextWindow: 96000, maxOutputTokens: 6000 });
  f.deps.getSettings = async () => ({ autoTitle: { enabled: false, model: 'fixture' }, runLimits: {}, contextBudgetTokens: 32000, adaptiveContext: true });
  const messages = history();
  const result = await buildContext(f.deps, f.session, f.project, f.model, messages, [], signal());
  assert.equal(result.report.omittedMessages, 0);
  assert.equal(result.report.budget, 88976);
  assert.ok(result.report.estimatedTokens > 32000);
  const next = [...messages, { id: 'steering', role: 'user' as const, content: 'Also preserve the original API.', createdAt: '' }];
  const continued = await buildContext(f.deps, f.session, f.project, f.model, next, [], signal(), { selection: result.selection, checkpoint: result.checkpoint });
  assert.equal(continued.report.omittedMessages, 0);
});

test('initial context selection retains fitting history without a growth discount', () => {
  const messages = ['old', 'assistant', 'current'].map((id, i) => ({ id, role: i === 1 ? 'assistant' as const : 'user' as const, content: id, createdAt: '' }));
  const groups = messages.map(m => [m]);
  const selected = selectContextHistory({ history: messages, groups, latestId: 'current', providerId: 'fixture', policyHash: 'policy', rulePaths: [],
    costs: new Map(groups.map((g, i) => [g, [200, 600, 100][i]])), contentHash: ids => contextHash(ids), fixedTokens: 0, budget: 1000, hardBudget: 1000, summaryReserve: 0 });
  assert.deepEqual([...selected.retained].sort(), ['assistant', 'current', 'old']);
  assert.equal(selected.omitted.length, 0);
});

test('settings migrate legacy automatic targets to model-window while explicit custom limits survive', async () => {
  const { appSettings } = await import('../src/backend/settings');
  const legacy = { autoTitle: { enabled: false, model: 'fixture' }, runLimits: {}, contextBudgetTokens: 32000, adaptiveContext: true };
  assert.equal(appSettings(legacy).contextPolicy, 'model-window');
  assert.equal(appSettings(legacy).adaptiveContext, false);
  assert.equal(appSettings({ ...legacy, contextPolicy: 'custom', contextBudgetTokens: 48000 }).contextBudgetTokens, 48000);
  assert.throws(() => appSettings({ ...legacy, contextPolicy: 'invalid' as 'custom' }));
});
