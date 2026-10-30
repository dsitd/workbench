import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson } from './campaign-budget';
import { techniqueBudget } from './technique-budget';

/** Keep historical costs and reserve the entire cap of every unfinished task.
 * This permits concurrent isolated trials without spending the same balance twice.
 */
export async function protocolBudget(base: string) {
  const previous = await techniqueBudget(base);
  let reportedUsd = previous.reportedUsd, reservedUsd = previous.reservedUsd, calls = previous.calls;
  let committedRemainderUsd = previous.committedRemainderUsd;
  const groups: Record<string, { reportedUsd: number; reservedUsd: number; calls: number }> = { ...previous.groups };
  for (const group of ['protocol-live']) {
    const folder = path.join(base, group);
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
    for (const attempt of await exists(path.join(folder, 'attempts.json')) ? await readJson(path.join(folder, 'attempts.json')) : []) {
      const charged = accounted.get(path.basename(attempt.output));
      if (charged === undefined) tally.reservedUsd += attempt.cap;
      else if (attempt.status === 'aborted-reserved') tally.reservedUsd += Math.max(0, attempt.cap - charged);
      else if (attempt.status !== 'ended') committedRemainderUsd += Math.max(0, attempt.cap - charged);
    }
    reportedUsd += tally.reportedUsd; reservedUsd += tally.reservedUsd; calls += tally.calls;
    groups[group] = tally;
  }
  const accountedUsd = reportedUsd + reservedUsd;
  return { reportedUsd, reservedUsd, accountedUsd, committedRemainderUsd,
    encumberedUsd: accountedUsd + committedRemainderUsd, limitUsd: 10,
    calls, groups };
}
