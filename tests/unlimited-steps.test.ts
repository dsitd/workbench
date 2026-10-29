import test from 'node:test';
import assert from 'node:assert/strict';
import { RunJournal, resolveLimits } from '../src/agent/journal';
import { checkedRunLimits } from '../src/shared/runs';
import { harnessFixture } from './agent-fixture';

test('explicit zero removes the step ceiling while preserving token, cost and time limits', () => {
  const f = harnessFixture({}, {}, { runLimits: { maxSteps: 0 } });
  assert.equal(checkedRunLimits({ maxSteps: 0 }).maxSteps, 0);
  const limits = resolveLimits(undefined, f.project, f.session, {});
  const journal = new RunJournal(f.deps, f.session, f.model, limits);
  journal.run.steps = 1_000_000;
  assert.equal(journal.limit(), undefined);
  journal.run.usage.costUsd = limits.maxCostUsd;
  assert.equal(journal.limit(), 'cost');
  journal.run.usage.costUsd = 0;
  journal.run.usage.inputTokens = limits.maxTokens;
  assert.equal(journal.limit(), 'tokens');
  journal.run.usage.inputTokens = 0;
  journal.run.startedAt = new Date(Date.now() - limits.maxDurationMs - 100).toISOString();
  assert.equal(journal.limit(), 'duration');
  assert.throws(() => checkedRunLimits({ maxSteps: -1 }));
  assert.throws(() => checkedRunLimits({ maxSteps: 0.5 }), 'fractional limits must not silently become unlimited');
  assert.equal(resolveLimits(undefined, f.project, f.session, { maxSteps: 4 }).maxSteps, 4);
});
