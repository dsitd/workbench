import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file: string) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }

/** One authorization: original invalid run, diagnostics, grading and repair. */
export async function campaignBudget(base: string) {
  const groups: Record<string, { reportedUsd: number; reservedUsd: number; calls: number }> = {};
  for (const group of ['live', 'unsupported-seed-diagnostic', 'regrade', 'repair-live']) {
    const folder = path.join(base, group);
    const tally = { reportedUsd: 0, reservedUsd: 0, calls: 0 }; groups[group] = tally;
    if (!await exists(folder)) continue;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) {
      const file = path.join(folder, entry.name, 'billing.json');
      if (!await exists(file)) continue;
      for (const call of (await readJson(file)).calls) {
        tally.calls++;
        if (['reported', 'local-failure'].includes(call.state)) tally.reportedUsd += call.costUsd ?? 0;
        else tally.reservedUsd += call.reservationUsd;
      }
    }
    const registry = path.join(folder, 'attempts.json');
    if (await exists(registry)) for (const a of await readJson(registry)) {
      if (!await exists(path.join(folder, path.basename(a.output), 'billing.json'))) tally.reservedUsd += a.cap;
    }
  }
  const reportedUsd = Object.values(groups).reduce((s, g) => s + g.reportedUsd, 0);
  const reservedUsd = Object.values(groups).reduce((s, g) => s + g.reservedUsd, 0);
  return { reportedUsd, reservedUsd, accountedUsd: reportedUsd + reservedUsd,
    calls: Object.values(groups).reduce((s, g) => s + g.calls, 0), limitUsd: 10, groups };
}
