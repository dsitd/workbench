import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { campaignBudget } from '../../scripts/harness-pilot/noncoding/campaign-budget';

test('repair budget carries historical charges, unknown reservations and interrupted registrations', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'noncoding-budget-'));
  async function write(relative: string, value: unknown) {
    const file = path.join(base, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value));
  }
  try {
    await write('live/a/billing.json', { calls: [{ state: 'reported', costUsd: 0.3, reservationUsd: 0.5 }] });
    await write('unsupported-seed-diagnostic/a/billing.json', { calls: [{ state: 'uncertain', reservationUsd: 0.02 }] });
    await write('regrade/a/billing.json', { calls: [{ state: 'reported', costUsd: 0.001, reservationUsd: 0.03 }] });
    await write('repair-live/attempts.json', [{ output: path.join(base, 'repair-live/pending'), cap: 0.35 }]);
    // Local fixtures are never counted as paid provider traffic.
    await write('repair-offline/a/billing.json', { calls: [{ state: 'reported', costUsd: 5 }] });
    assert.ok(Math.abs((await campaignBudget(base)).accountedUsd - 0.671) < 1e-12);
    await write('repair-live/pending/billing.json', { calls: [{ state: 'reported', costUsd: 0.04, reservationUsd: 0.1 }] });
    const resumed = await campaignBudget(base);
    assert.ok(Math.abs(resumed.accountedUsd - 0.361) < 1e-12);
    assert.equal(resumed.reservedUsd, 0.02);
    assert.equal(resumed.calls, 4);
    assert.equal(resumed.limitUsd, 10);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
