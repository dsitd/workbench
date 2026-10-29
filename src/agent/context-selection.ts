import { createHash } from 'node:crypto';
import type { ChatMessage } from '../shared/types';
import type { ContextSelectionState } from '../shared/context';
import { distinctReadGroups } from './context-history';
import { AgentError } from './errors';

export const contextHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface SelectionInput {
  history: ChatMessage[];
  groups: ChatMessage[][];
  latestId: string;
  providerId: string;
  policyHash: string;
  rulePaths: string[];
  previous?: ContextSelectionState;
  /** Costs include any ephemeral image frame needed on this request. */
  costs: Map<ChatMessage[], number>;
  contentHash: (ids: string[]) => string;
  fixedTokens: number;
  budget: number;
  hardBudget: number;
  summaryReserve: number;
  /** A validated provider measurement plus conservative new-message estimates, if available. */
  measuredTokens?: (ids: string[]) => number | undefined;
}

/** Append within an epoch; deliberate compaction never reimports already omitted groups. */
export function selectContextHistory(input: SelectionInput): { retained: Set<string>; selection: ContextSelectionState; budget: number; omitted: ChatMessage[]; historyTokens: number } {
  const { history, groups, latestId, previous, fixedTokens, hardBudget, summaryReserve } = input;
  const positions = new Map(history.map((message, index) => [message.id, index]));
  const latestIndex = positions.get(latestId)!;
  const previousIds = new Set(previous?.selectedMessageIds ?? []);
  let reason: 'initial' | 'budget' | 'history-change' | 'policy-change' | undefined;
  let validPrior = false;
  if (!previous || previous.version !== 1 || previous.taskMessageId !== latestId) reason = 'initial';
  else {
    const ordered = history.filter(message => previousIds.has(message.id)).map(message => message.id);
    const complete = groups.filter(group => group.some(message => previousIds.has(message.id))).every(group => group.every(message => previousIds.has(message.id)));
    const intact = previousIds.has(latestId) && complete && ordered.length === previous.selectedMessageIds.length
      && ordered.every((id, index) => id === previous.selectedMessageIds[index])
      && Boolean(previous.throughMessageId && positions.has(previous.throughMessageId))
      && input.contentHash(ordered) === previous.selectedContentHash;
    validPrior = previous.providerId === input.providerId && intact;
    if (previous.providerId !== input.providerId) reason = 'policy-change';
    else if (!intact) reason = 'history-change';
    else if (previous.policyHash !== input.policyHash) reason = 'policy-change';
  }
  const through = validPrior ? positions.get(previous!.throughMessageId!)! : -1;
  // A formerly incomplete group becomes new when its final result arrives after the watermark.
  const candidates = validPrior ? groups.filter(group => group.some(message => previousIds.has(message.id)) || positions.get(group.at(-1)!.id)! > through) : groups;
  let budget = input.budget;
  const fullCost = candidates.reduce((sum, group) => sum + (input.costs.get(group) ?? 0), 0);
  const candidateIds = new Set(candidates.flat().map(message => message.id));
  const measured = input.measuredTokens?.(history.filter(message => candidateIds.has(message.id)).map(message => message.id));
  const overBudget = (measured ?? fixedTokens + fullCost) + summaryReserve > budget;
  if (!reason && overBudget) reason = 'budget';
  // Fresh policy invalidates provider cache, but does not itself require losing
  // fitting conversation history or resurrecting groups omitted in an older epoch.
  const compact = overBudget;
  const distinct = compact ? distinctReadGroups(candidates) : { groups: candidates, omitted: [] };
  const pool = distinct.groups;
  const retained = new Set<string>();
  let historyTokens = 0;
  const latestGroup = pool.find(group => group.some(message => message.id === latestId))!;
  const newestToolGroup = [...pool].reverse().find(group => group[0].toolCalls?.length && positions.get(group[0].id)! > latestIndex);
  const mandatory = new Set([latestGroup, ...(newestToolGroup ? [newestToolGroup] : [])]);
  for (const group of mandatory) {
    const tokens = input.costs.get(group) ?? 0;
    historyTokens += tokens;
    group.forEach(message => retained.add(message.id));
  }
  if ((compact || measured === undefined) && fixedTokens + historyTokens > hardBudget) throw new AgentError('Последний вызов инструмента вместе с задачей и обязательными правилами превышает окно модели. Уменьшите диапазон чтения или лимит ответа.');
  budget = Math.max(budget, fixedTokens + historyTokens + summaryReserve);
  budget = Math.min(budget, hardBudget);
  // Reserve growth space after each reset, while mandatory latest task/results remain whole.
  const compactLimit = Math.max(fixedTokens + historyTokens, Math.floor(budget * 0.80) - summaryReserve);
  const limit = compact ? compactLimit : budget - summaryReserve;
  for (const group of [...pool].reverse()) {
    if (mandatory.has(group)) continue;
    const tokens = input.costs.get(group) ?? 0;
    if ((compact || measured === undefined) && fixedTokens + historyTokens + tokens > limit) continue;
    historyTokens += tokens;
    group.forEach(message => retained.add(message.id));
  }
  const ids = history.filter(message => retained.has(message.id)).map(message => message.id);
  const redundant = new Set(distinct.omitted);
  // Only newly discarded groups advance the bounded checkpoint; no each-step resummarization.
  const omitted = reason ? candidates.filter(group => !redundant.has(group) && group.every(message => !retained.has(message.id))).flat() : [];
  const selection: ContextSelectionState = {
    version: 1, taskMessageId: latestId, providerId: input.providerId, policyHash: input.policyHash,
    epoch: reason ? (previous?.epoch ?? 0) + 1 : previous!.epoch,
    selectedMessageIds: ids, selectedContentHash: input.contentHash(ids), throughMessageId: history.at(-1)?.id,
    targetTokens: budget, rulePaths: input.rulePaths,
    ...(reason ? { lastCompaction: { reason, removedMessageCount: [...previousIds].filter(id => !retained.has(id)).length || (previous ? 0 : history.length - retained.size), retainedMessageCount: ids.length } } : { lastCompaction: previous!.lastCompaction }),
  };
  return { retained, selection, budget, omitted, historyTokens };
}
