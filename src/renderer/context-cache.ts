import type { RunUsage } from '../shared/types';

export function cacheReadShare(usage?: RunUsage): { percent: number; partial: boolean } | undefined {
  if (!usage || usage.cacheReadTokens === undefined || usage.inputTokens <= 0) return;
  return { percent: Math.min(100, Math.round(100 * usage.cacheReadTokens / usage.inputTokens)),
    partial: Boolean(usage.cacheDetailsPartial || usage.unknownCostCalls || usage.tokenSource !== 'reported') };
}

export function cacheShareLabel(usage?: RunUsage): string {
  const share = cacheReadShare(usage);
  return share ? `Кэш ${share.partial ? '≈ ' : ''}${share.percent}%${share.partial ? ' · часть данных' : ''}` : 'Кэш: нет данных';
}
