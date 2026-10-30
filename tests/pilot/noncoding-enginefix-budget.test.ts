import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchSlots } from '../../scripts/harness-pilot/noncoding/repeat-budget';
import { enginefixBudget } from '../../scripts/harness-pilot/noncoding/enginefix-budget';

test('engine fixes retain historical repeat costs and concurrent slots reserve full unfinished caps including crashes before ledger creation', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'repeat-budget-'));
  const write = async (name: string, data: unknown) => { const file = path.join(base, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data)); };
  try {
    await write('live/old/billing.json', { calls: [{ state: 'reported', costUsd: 8 }] });
    await write('repeat-live/old/billing.json', { calls: [{ state: 'reported', costUsd: 1 }] });
    await write('enginefix-live/a/billing.json', { calls: [{ state: 'reported', costUsd: 0.02 }, { state: 'uncertain', reservationUsd: 0.03 }] });
    const attempts = [{ output: '/unused/a', cap: 0.35, status: 'started' }, { output: '/unused/b', cap: 0.35, status: 'started' }];
    await write('enginefix-live/attempts.json', attempts);
    const inFlight = await enginefixBudget(base);
    assert.ok(Math.abs(inFlight.accountedUsd - 9.40) < 1e-10);
    assert.ok(Math.abs(inFlight.encumberedUsd - 9.70) < 1e-10);
    assert.equal(batchSlots(inFlight.encumberedUsd, 0.35, 4), 0);
    attempts[0].status = 'ended'; await write('enginefix-live/attempts.json', attempts);
    const completed = await enginefixBudget(base);
    assert.ok(Math.abs(completed.encumberedUsd - 9.40) < 1e-10);
    assert.equal(batchSlots(completed.encumberedUsd, 0.35, 4), 1);
    assert.equal(completed.calls, 4);
    // Resuming does not reset previous authorization or drop the unpriced call.
    assert.deepEqual(await enginefixBudget(base), completed);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});


test('aborted diagnostic caps stay reserved when the corrected campaign starts', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'enginefix-diagnostic-budget-'));
  try {
    const folder = path.join(base, 'enginefix-diagnostic'); await fs.mkdir(path.join(folder, 'a'), { recursive: true });
    await fs.writeFile(path.join(folder, 'a/billing.json'), JSON.stringify({ calls: [{ state: 'reported', costUsd: 0.01 }, { state: 'pending', reservationUsd: 0.02 }] }));
    await fs.writeFile(path.join(folder, 'attempts.json'), JSON.stringify([{ output: '/unused/a', cap: 0.35, status: 'aborted-reserved' }]));
    const result = await enginefixBudget(base);
    assert.ok(Math.abs(result.accountedUsd - 0.35) < 1e-10);
    assert.ok(Math.abs(result.reservedUsd - 0.34) < 1e-10);
    assert.equal(result.committedRemainderUsd, 0);
    assert.equal(result.encumberedUsd, result.accountedUsd);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
