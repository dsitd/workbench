import type { ChatMessage, RunRecord, RunUsage } from '../shared/types';

export interface CostSummary {
  costUsd?: number;
  costSource: RunUsage['costSource'];
  partial: boolean;
  ongoing: boolean;
  runCount: number;
  includesTitle: boolean;
  missingRequests: number;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheDetailsPartial?: boolean;
}
export interface ChatCosts {
  requests: Map<string, CostSummary>;
  total: CostSummary;
  unassignedRuns: number;
}

const validCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function summarize(runs: RunRecord[], missingRequests = 0): CostSummary {
  const prices = runs.filter(run => validCost(run.usage.costUsd));
  const partial = missingRequests > 0 || prices.length < runs.length || runs.some(run => run.usage.costSource === 'unknown');
  const sources = new Set(prices.map(run => run.usage.costSource));
  const cachedReads = runs.filter(run => run.usage.cacheReadTokens !== undefined);
  const cachedWrites = runs.filter(run => run.usage.cacheWriteTokens !== undefined);
  const hasCacheDetails = cachedReads.length > 0 || cachedWrites.length > 0;
  const costSource: RunUsage['costSource'] = partial || !runs.length ? 'unknown' : sources.has('estimated') && sources.size === 1 ? 'estimated'
    : sources.size === 1 && sources.has('api') ? 'api' : 'mixed';
  return {
    costUsd: prices.length ? prices.reduce((sum, run) => sum + run.usage.costUsd!, 0) : runs.length || missingRequests ? undefined : 0,
    costSource, partial, ongoing: runs.some(run => run.status === 'running'), runCount: runs.length,
    includesTitle: runs.some(run => run.kind === 'title'), missingRequests,
    inputTokens: runs.reduce((sum, run) => sum + run.usage.inputTokens, 0),
    ...(cachedReads.length ? { cacheReadTokens: cachedReads.reduce((sum, run) => sum + run.usage.cacheReadTokens!, 0) } : {}),
    ...(cachedWrites.length ? { cacheWriteTokens: cachedWrites.reduce((sum, run) => sum + run.usage.cacheWriteTokens!, 0) } : {}),
    ...(hasCacheDetails && (missingRequests > 0 || cachedReads.length < runs.length || cachedWrites.length < runs.length || runs.some(run => run.usage.cacheDetailsPartial)) ? { cacheDetailsPartial: true } : {}),
  };
}

/** Each journal record is a cumulative snapshot; only its latest supplied snapshot is counted. */
export function chatCosts(records: RunRecord[], messages: ChatMessage[], sessionId: string): ChatCosts {
  const byId = new Map<string, RunRecord>();
  for (const run of records) if (run.sessionId === sessionId) byId.set(run.id, run);
  const runs = [...byId.values()];
  const users = messages.filter(message => message.role === 'user');
  const userIds = new Set(users.map(message => message.id));
  const groups = new Map<string, RunRecord[]>();

  const requestId = (run: RunRecord): string | undefined => {
    const visited = new Set<string>();
    let current: RunRecord | undefined = run;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const id = current.checkpoint?.userMessageId;
      if (id && userIds.has(id)) return id;
      current = current.parentRunId ? byId.get(current.parentRunId) : undefined;
    }
    // Existing title journals have no checkpoint, but automatic naming always uses the first user message.
    return run.kind === 'title' ? users[0]?.id : undefined;
  };

  let unassignedRuns = 0;
  for (const run of runs) {
    const id = requestId(run);
    if (!id) { unassignedRuns++; continue; }
    const group = groups.get(id) ?? []; group.push(run); groups.set(id, group);
  }
  const requests = new Map<string, CostSummary>();
  let missingRequests = 0;
  for (const user of users) {
    const group = groups.get(user.id) ?? [];
    // A title alone does not establish the cost of the user's agent request.
    const missing = group.some(run => run.kind !== 'title') ? 0 : 1;
    missingRequests += missing;
    requests.set(user.id, summarize(group, missing));
  }
  return { requests, total: summarize(runs, missingRequests), unassignedRuns };
}

export function moneyLabel(summary: CostSummary): string {
  if (summary.costUsd === undefined) return 'Нет данных';
  // A partial sum of zero says nothing about the price, so do not show a misleading "from $0".
  if (summary.partial && summary.costUsd === 0) return summary.ongoing ? 'Стоимость неизвестна · пока' : 'Стоимость неизвестна';
  // Keep tiny title costs visible instead of rounding a paid request to zero.
  const digits = summary.costUsd > 0 && summary.costUsd < 0.0001 ? 6 : 4;
  const money = `$${summary.costUsd.toFixed(digits)}`;
  const prefix = summary.partial ? 'от ' : summary.costSource === 'estimated' || summary.costSource === 'mixed' ? '≈ ' : '';
  return `${prefix}${money}${summary.ongoing ? ' · пока' : ''}${summary.partial ? ' · часть неизвестна' : ''}`;
}

export function costDescription(summary: CostSummary, chat = false, unassignedRuns = 0): string {
  const source = summary.costSource === 'api' ? 'Стоимость по данным API.' : summary.costSource === 'estimated' ? 'Оценка по тарифам модели.'
    : summary.costSource === 'mixed' ? 'Сумма данных API и оценок по тарифам.' : 'Полная стоимость неизвестна; показана известная часть, если она есть.';
  const details = [source, chat ? 'Все запросы и продолжения в этом чате.' : 'Запрос и все его продолжения.'];
  if (summary.includesTitle) details.push('Включая автоматическое название чата.');
  if (summary.ongoing) details.push('Запрос выполняется; итог обновится после ответа API.');
  if (summary.missingRequests) details.push(`Нет журнала для ${summary.missingRequests} запросов.`);
  if (unassignedRuns) details.push('Часть запусков есть только в общем итоге: привязка к сообщению отсутствует.');
  if (summary.cacheReadTokens !== undefined || summary.cacheWriteTokens !== undefined) {
    const counts = [`Вход: ${summary.inputTokens.toLocaleString('ru')} токенов`];
    if (summary.cacheReadTokens !== undefined) counts.push(`чтение из кэша: ${summary.cacheReadTokens.toLocaleString('ru')}`);
    if (summary.cacheWriteTokens !== undefined) counts.push(`запись в кэш: ${summary.cacheWriteTokens.toLocaleString('ru')}`);
    details.push(`${counts.join('; ')}. Кэш входит во входные токены.${summary.cacheDetailsPartial ? ' Данные кэша есть только для части вызовов.' : ''}`);
    if (summary.costSource === 'api') details.push('Стоимость API уже учитывает кэш.');
  }
  return details.join(' ');
}
