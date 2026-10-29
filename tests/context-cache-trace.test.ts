import test from 'node:test';
import assert from 'node:assert/strict';
import { contextCacheTrace } from '../src/agent/cache-trace';
import type { ContextSelectionState } from '../src/shared/context';

const state = (patch: Partial<ContextSelectionState> = {}): ContextSelectionState => ({
  version: 1, taskMessageId: 'task', providerId: 'provider', policyHash: 'policy', selectedContentHash: 'history',
  epoch: 1, selectedMessageIds: ['task', 'call', 'result'], throughMessageId: 'result',
  targetTokens: 32000, rulePaths: [], ...patch,
});

test('context diagnostics distinguish append from reinsertion without claiming an API hit', () => {
  const previous = state();
  const appended = state({ selectedMessageIds: [...previous.selectedMessageIds, 'next', 'next-result'] });
  assert.deepEqual(contextCacheTrace(previous, appended), {
    epoch: 1, transition: 'append', historyPrefixPreserved: true, removedMessageCount: 0, retainedMessageCount: 5,
  });
  const replaced = state({ epoch: 2, selectedMessageIds: ['task', 'next'], lastCompaction: { reason: 'budget', removedMessageCount: 2, retainedMessageCount: 2 } });
  assert.equal(contextCacheTrace(previous, replaced).transition, 'compaction');
  assert.equal(contextCacheTrace(previous, replaced).historyPrefixPreserved, false);
  assert.equal(contextCacheTrace(previous, state({ selectedMessageIds: ['old', ...previous.selectedMessageIds] })).historyPrefixPreserved, false);
});

test('policy reset and first prompt have explicit diagnostic reasons', () => {
  assert.equal(contextCacheTrace(undefined, state()).transition, 'initial');
  const changed = state({ epoch: 2, policyHash: 'fresh', lastCompaction: { reason: 'policy-change', removedMessageCount: 0, retainedMessageCount: 3 } });
  assert.equal(contextCacheTrace(state(), changed).transition, 'policy-change');
  assert.equal(contextCacheTrace(state(), changed).historyPrefixPreserved, false);
});
