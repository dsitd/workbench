import { randomUUID } from 'node:crypto';
import type { AgentDependencies, ModelResponse } from '../shared/agent';
import type { ModelConfig, Project, RunLimits, RunRecord, RunUsage, Session } from '../shared/types';
import { checkedRunLimits, defaultRunLimits, isReasoningEffort, type CacheUsage } from '../shared/runs';
import { AgentError } from './errors';
import { emitSafely } from './events';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value <= 300_000_000;
export const estimate = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);

export function resolveLimits(global: RunLimits | undefined, project: Project, session: Session, options: { maxSteps?: number; maxRunTokens?: number }): Required<RunLimits> {
  try {
    return { ...defaultRunLimits, ...checkedRunLimits(global), ...checkedRunLimits(project.runLimits), ...checkedRunLimits(session.runLimits),
      ...checkedRunLimits({ maxSteps: options.maxSteps, maxTokens: options.maxRunTokens }) };
  } catch { throw new AgentError('Некорректный бюджет запуска. Проверьте лимиты проекта и чата.'); }
}

export function responseUsage(model: ModelConfig, response: ModelResponse, inputEstimate: number): RunUsage {
  const inputReported = tokens(response.usage?.inputTokens), outputReported = tokens(response.usage?.outputTokens);
  const inputTokens = inputReported ? response.usage!.inputTokens! : inputEstimate;
  const outputTokens = outputReported ? response.usage!.outputTokens! : estimate(response.content + JSON.stringify(response.toolCalls) + JSON.stringify(response.reasoningDetails ?? []) + JSON.stringify(response.providerItems ?? []));
  const cache = inputReported ? checkedCacheUsage(response.usage!, inputTokens) : { cacheDetailsPartial: true };
  const apiCost = response.usage?.costUsd;
  const estimatedCost = requestCost(model, inputTokens, outputTokens, cache);
  const costUsd = finite(apiCost) ? apiCost : estimatedCost;
  return { inputTokens, outputTokens, ...cache, tokenSource: inputReported && outputReported ? 'reported' : inputReported || outputReported ? 'mixed' : 'estimated',
    ...(costUsd !== undefined ? { costUsd } : {}), costSource: finite(apiCost) ? 'api' : estimatedCost !== undefined ? 'estimated' : 'unknown' };
}

function checkedCacheUsage(usage: CacheUsage, inputTokens: number): CacheUsage {
  let read = tokens(usage.cacheReadTokens) && usage.cacheReadTokens <= inputTokens ? usage.cacheReadTokens : undefined;
  let write = tokens(usage.cacheWriteTokens) && usage.cacheWriteTokens <= inputTokens ? usage.cacheWriteTokens : undefined;
  if ((read ?? 0) + (write ?? 0) > inputTokens) { read = undefined; write = undefined; }
  return { ...(read !== undefined ? { cacheReadTokens: read } : {}), ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    ...(usage.cacheDetailsPartial || read === undefined || write === undefined ? { cacheDetailsPartial: true } : {}) };
}

export function requestCost(model: ModelConfig, inputTokens: number, outputTokens: number, cache: CacheUsage = {}): number | undefined {
  if (model.kind === 'demo') return 0;
  if (!finite(model.inputPricePerMillion) || !finite(model.outputPricePerMillion)) return;
  const read = cache.cacheReadTokens ?? 0, write = cache.cacheWriteTokens ?? 0;
  if (!tokens(read) || !tokens(write) || read + write > inputTokens) return;
  if (read > 0 && !finite(model.cacheReadPricePerMillion) || write > 0 && !finite(model.cacheWritePricePerMillion)) return;
  const cost = ((inputTokens - read - write) * model.inputPricePerMillion + outputTokens * model.outputPricePerMillion
    + read * (model.cacheReadPricePerMillion ?? 0) + write * (model.cacheWritePricePerMillion ?? 0)) / 1_000_000;
  return finite(cost) ? cost : undefined;
}

export function aggregateUsage(previous: RunUsage, added: RunUsage, first = false): RunUsage {
  const costSource = first ? added.costSource : previous.costSource === added.costSource ? previous.costSource
    : previous.costSource === 'unknown' || added.costSource === 'unknown' ? 'unknown' : 'mixed';
  // A known subtotal remains visible when another step has unknown cost, clearly tagged unknown.
  const costUsd = previous.costUsd === undefined && added.costUsd === undefined ? undefined : (previous.costUsd ?? 0) + (added.costUsd ?? 0);
  return { inputTokens: previous.inputTokens + added.inputTokens, outputTokens: previous.outputTokens + added.outputTokens,
    tokenSource: first ? added.tokenSource : previous.tokenSource === added.tokenSource ? previous.tokenSource : 'mixed', costSource,
    ...aggregateCache(previous, added, first),
    ...((previous.unknownCostCalls ?? 0) + (added.unknownCostCalls ?? 0) > 0
      ? { unknownCostCalls: (previous.unknownCostCalls ?? 0) + (added.unknownCostCalls ?? 0) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}) };
}

function aggregateCache(previous: CacheUsage, added: CacheUsage, first: boolean): CacheUsage {
  if (first) return { ...(added.cacheReadTokens !== undefined ? { cacheReadTokens: added.cacheReadTokens } : {}),
    ...(added.cacheWriteTokens !== undefined ? { cacheWriteTokens: added.cacheWriteTokens } : {}),
    ...(added.cacheDetailsPartial || added.cacheReadTokens === undefined || added.cacheWriteTokens === undefined ? { cacheDetailsPartial: true } : {}) };
  return { ...(previous.cacheReadTokens !== undefined || added.cacheReadTokens !== undefined ? { cacheReadTokens: (previous.cacheReadTokens ?? 0) + (added.cacheReadTokens ?? 0) } : {}),
    ...(previous.cacheWriteTokens !== undefined || added.cacheWriteTokens !== undefined ? { cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + (added.cacheWriteTokens ?? 0) } : {}),
    ...(previous.cacheDetailsPartial || added.cacheDetailsPartial || previous.cacheReadTokens === undefined || previous.cacheWriteTokens === undefined
      || added.cacheReadTokens === undefined || added.cacheWriteTokens === undefined ? { cacheDetailsPartial: true } : {}) };
}

export class RunJournal {
  readonly run: RunRecord;
  constructor(private readonly deps: AgentDependencies, session: Session, model: ModelConfig, limits: Required<RunLimits>, parentRunId?: string) {
    const effort = session.reasoningEffort ?? model.reasoningEffort ?? 'auto';
    if (!isReasoningEffort(effort)) throw new AgentError('Неизвестный уровень reasoning в настройках чата.');
    this.run = { id: randomUUID(), projectId: session.projectId, sessionId: session.id, modelId: model.id,
      modelIdentifier: model.model, kind: 'agent', mode: session.mode ?? 'auto-edit', reasoningEffort: effort,
      status: 'running', phase: 'context', startedAt: new Date().toISOString(), steps: 0, stepLog: [], limits, parentRunId,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, tokenSource: 'estimated', costSource: 'estimated' }, canContinue: false, changedFiles: [] };
  }
  async save(): Promise<void> {
    // Snapshot before crossing asynchronous persistence/UI boundaries.
    const snapshot = structuredClone(this.run);
    await this.deps.saveRun?.(snapshot);
    emitSafely(this.deps.emit, { type: 'run', sessionId: snapshot.sessionId, projectId: snapshot.projectId, run: snapshot });
  }
  limit(): RunRecord['limitReason'] | undefined {
    const { run } = this;
    if (run.usage.inputTokens + run.usage.outputTokens >= run.limits.maxTokens!) return 'tokens';
    if (run.usage.costUsd !== undefined && run.usage.costUsd >= run.limits.maxCostUsd!) return 'cost';
    if (Date.now() - Date.parse(run.startedAt) >= run.limits.maxDurationMs!) return 'duration';
    if (run.limits.maxSteps! > 0 && run.steps >= run.limits.maxSteps!) return 'steps';
  }
  async finish(status: RunRecord['status'], error?: string, limitReason?: RunRecord['limitReason']): Promise<void> {
    Object.assign(this.run, { status, error, limitReason, phase: 'final', finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(this.run.startedAt), canContinue: status !== 'completed' && Boolean(this.run.checkpoint?.userMessageId) });
    await this.save();
  }
}

export function limitText(reason: RunRecord['limitReason'], limits: RunLimits): string {
  const label = reason === 'steps' ? `лимит ${limits.maxSteps} шагов` : reason === 'tokens' ? `лимит ${limits.maxTokens} токенов запуска`
    : reason === 'cost' ? `бюджет $${limits.maxCostUsd}` : reason === 'duration' ? 'лимит времени запуска' : 'лимит вывода модели';
  return `Достигнут ${label}. Результаты сохранены; продолжите задачу из журнала или измените соответствующий лимит.`;
}

export class RunLimitError extends AgentError {
  constructor(readonly reason: NonNullable<RunRecord['limitReason']>, limits: RunLimits) { super(limitText(reason, limits)); }
}
