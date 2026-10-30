import fs from 'node:fs/promises';
import path from 'node:path';
import { campaignBudget, exists, readJson } from './campaign-budget';

/** Keep historical costs and reserve the entire cap of every unfinished task.
 * This permits concurrent isolated trials without spending the same balance twice.
 */
export async function repeatBudget(base: string) {
  const previous = await campaignBudget(base);
  const folder = path.join(base, 'repeat-live');
  const tally = { reportedUsd: 0, reservedUsd: 0, calls: 0 };
  const accounted = new Map<string, number>();
  if (await exists(folder)) for (const e of await fs.readdir(folder, { withFileTypes: true })) if (e.isDirectory()) {
    const file = path.join(folder, e.name, 'billing.json');
    if (!await exists(file)) continue;
    let sum = 0;
    for (const call of (await readJson(file)).calls) {
      tally.calls++;
      if (['reported', 'local-failure'].includes(call.state)) { tally.reportedUsd += call.costUsd ?? 0; sum += call.costUsd ?? 0; }
      else { tally.reservedUsd += call.reservationUsd; sum += call.reservationUsd; }
    }
    accounted.set(e.name, sum);
  }
  let committedRemainderUsd = 0;
  for (const attempt of await exists(path.join(folder, 'attempts.json')) ? await readJson(path.join(folder, 'attempts.json')) : []) {
    const charged = accounted.get(path.basename(attempt.output));
    if (charged === undefined) tally.reservedUsd += attempt.cap;
    else if (attempt.status !== 'ended') committedRemainderUsd += Math.max(0, attempt.cap - charged);
  }
  const reportedUsd = previous.reportedUsd + tally.reportedUsd;
  const reservedUsd = previous.reservedUsd + tally.reservedUsd;
  const accountedUsd = reportedUsd + reservedUsd;
  return { reportedUsd, reservedUsd, accountedUsd, committedRemainderUsd,
    encumberedUsd: accountedUsd + committedRemainderUsd, limitUsd: 10,
    calls: previous.calls + tally.calls, groups: { ...previous.groups, 'repeat-live': tally } };
}

export function batchSlots(encumberedUsd: number, taskCap: number, maximum: number) {
  if (![encumberedUsd, taskCap, maximum].every(Number.isFinite) || taskCap <= 0 || maximum < 0)
    throw new Error('Invalid budget limits');
  return Math.max(0, Math.min(Math.floor(maximum), Math.floor((10 - encumberedUsd + 1e-10) / taskCap)));
}
