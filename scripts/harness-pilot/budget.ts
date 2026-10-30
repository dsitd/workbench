import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { gateway } from './gateway';
import { resolvePilotModel, type PilotModel } from './models';

/** Cumulative authorizations per registry; a registry file must state the same limit. */
const campaignLimits = { 'control': 9, 'flash-20261022': 10, 'refactor-20261029': 3 } as const;
export type BudgetCampaign = keyof typeof campaignLimits;
export const refactorCampaign = 'refactor-20261029' as const;
export const registryFile = (base: string, campaign: BudgetCampaign) => path.join(base, campaign === 'control' ? 'budget-control.json' : `budget-${campaign}.json`);

/** Sum of every ledger's charges (reported costs and unknown-cost reservations). Missing or malformed ledgers fail closed. */
export function campaignSpent(base: string, campaign: BudgetCampaign): { limitUsd: number; spentUsd: number; ledgers: string[] } {
  const budget = JSON.parse(readFileSync(registryFile(base, campaign), 'utf8'));
  // User authorized an additional $5 on 2026-10-09, on top of the original $4.
  if (budget.limitUsd !== campaignLimits[campaign] || !Array.isArray(budget.ledgers) || new Set(budget.ledgers).size !== budget.ledgers.length) throw new Error('Invalid cumulative budget');
  const spentUsd = budget.ledgers.reduce((sum: number, ledger: string) => {
    const amount = JSON.parse(readFileSync(path.resolve(base, ledger), 'utf8')).chargedUsd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('Invalid historical billing');
    return sum + amount;
  }, 0);
  return { limitUsd: budget.limitUsd, spentUsd, ledgers: budget.ledgers };
}

/** Locks the registry, registers an empty ledger and returns the remaining authorization; the lock lasts until release. */
export function openCampaignLedger(base: string, campaign: BudgetCampaign, ledger: string): { spentUsd: number; remainingUsd: number; release(): void } {
  const registry = registryFile(base, campaign), lock = registry + '.lock';
  const fd = openSync(lock, 'wx', 0o600);
  const release = () => { closeSync(fd); unlinkSync(lock); };
  try {
    const { limitUsd, spentUsd } = campaignSpent(base, campaign);
    if (spentUsd >= limitUsd) throw new Error('Authorized cumulative budget exhausted');
    writeFileSync(ledger, JSON.stringify({ chargedUsd: 0, calls: [] }), { mode: 0o600 });
    const budget = JSON.parse(readFileSync(registry, 'utf8'));
    budget.ledgers.push(ledger);
    writeFileSync(registry, JSON.stringify(budget, null, 2), { mode: 0o600 });
    return { spentUsd, remainingUsd: limitUsd - spentUsd, release };
  } catch (error) { release(); throw error; }
}

// Fail closed across reruns, including reservations for responses with unknown cost.
export async function trackedGateway(base: string, output: string, credential: () => Promise<string | undefined>, dry: boolean, calls = 0, cap = 3.8, taskUsd = 0.30, model: PilotModel = resolvePilotModel(), capturePublicPayloads = false, campaign: BudgetCampaign = 'control') {
  const file = path.join(output, 'billing.json');
  if (dry) return gateway(file, credential, true, { calls, usd: 0, taskUsd }, model, capturePublicPayloads);
  const opened = openCampaignLedger(base, campaign, file);
  try {
    const proxy = await gateway(file, credential, false, { calls, usd: Math.min(cap, opened.remainingUsd), taskUsd }, model, capturePublicPayloads);
    console.log(`BUDGET prior=$${opened.spentUsd.toFixed(6)} remaining=$${opened.remainingUsd.toFixed(6)}`);
    return { ...proxy, close() { proxy.close(); opened.release(); } };
  } catch (error) { opened.release(); throw error; }
}
