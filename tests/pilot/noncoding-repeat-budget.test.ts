import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchSlots, repeatBudget } from '../../scripts/harness-pilot/noncoding/repeat-budget';

test('concurrent repeat slots reserve full unfinished caps including crashes before ledger creation', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'repeat-budget-'));
  const write = async (name: string, data: unknown) => { const file = path.join(base, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data)); };
  try {
    await write('live/old/billing.json', { calls: [{ state: 'reported', costUsd: 9 }] });
    await write('repeat-live/a/billing.json', { calls: [{ state: 'reported', costUsd: 0.02 }, { state: 'uncertain', reservationUsd: 0.03 }] });
    const attempts = [{ output: '/unused/a', cap: 0.35, status: 'started' }, { output: '/unused/b', cap: 0.35, status: 'started' }];
    await write('repeat-live/attempts.json', attempts);
    const inFlight = await repeatBudget(base);
    assert.ok(Math.abs(inFlight.accountedUsd - 9.40) < 1e-10);
    assert.ok(Math.abs(inFlight.encumberedUsd - 9.70) < 1e-10);
    assert.equal(batchSlots(inFlight.encumberedUsd, 0.35, 4), 0);
    attempts[0].status = 'ended'; await write('repeat-live/attempts.json', attempts);
    const completed = await repeatBudget(base);
    assert.ok(Math.abs(completed.encumberedUsd - 9.40) < 1e-10);
    assert.equal(batchSlots(completed.encumberedUsd, 0.35, 4), 1);
    assert.equal(completed.calls, 3);
    // Resuming does not reset previous authorization or drop the unpriced call.
    assert.deepEqual(await repeatBudget(base), completed);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('repeat admission never allocates above the shared authorization', () => {
  for (const used of [0, 1.273630596, 8.6, 8.7, 9.0, 9.65, 9.99, 10, 10.1]) {
    const slots = batchSlots(used, 0.35, 4);
    assert.ok(slots <= 4 && slots >= 0);
    if (slots) assert.ok(used + slots * 0.35 <= 10 + 1e-10);
  }
});
