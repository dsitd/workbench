import type { ChatMessage, PlanItem, RunRecord } from '../shared/types';
import type { ContextCheckpoint } from '../shared/runs';
import type { ContextSelectionState, ContextUsageBaseline } from '../shared/context';
import { checkedPlan } from './plan';
import type { TaskCriterion, TaskNote } from '../shared/task-evidence';
export type { ContextCheckpoint } from '../shared/runs';

export interface ContextWorkState {
  summarize?: (omitted: ChatMessage[], maxTokens: number) => Promise<string | undefined>;
  /** Current verification/contract facts, not an inference that the user task is complete. */
  completionState?: string;
  plan?: PlanItem[];
  checkpoint?: ContextCheckpoint;
  selection?: ContextSelectionState;
  usageBaseline?: ContextUsageBaseline;
  requestPolicy?: string;
  /** Successful requests that already received these tool-message image payloads. */
  presentedImageMessageIds?: string[];
  acceptanceCriteria?: TaskCriterion[]; taskNotes?: TaskNote[];
  toolObservations?: RunRecord['toolObservations']; mutationRevision?: number; evidenceScope?: string; operations?: RunRecord['operations'];
}

const compact = (text: string, length: number) => text.replace(/\s+/g, ' ').trim().slice(0, length);
const observationExcerpt = (text: string) => text.length <= 220 ? compact(text, 220) : `${compact(text.slice(0, 140), 140)} … ${compact(text.slice(-75), 75)}`;
const append = <T extends { messageId: string }>(items: T[], value: T) => [...items.filter(item => item.messageId !== value.messageId), value];
type Excerpt = { messageId: string; text: string };

/** Retain a small foundation from the initial request as well as the newest quotes. */
function retainFoundation<T extends Excerpt>(items: T[], originalId: string | undefined, limit: number): T[] {
  if (items.length <= limit) return items;
  const foundation = items.filter(item => item.messageId === originalId || item.messageId.startsWith(`${originalId}:`)).slice(0, Math.floor(limit / 2));
  const foundationIds = new Set(foundation.map(item => item.messageId));
  const recent = items.filter(item => !foundationIds.has(item.messageId)).slice(-(limit - foundation.length));
  return [...foundation, ...recent];
}

/** Only quote explicit user requirements; these heuristics never infer success or intent. */
function userRequirements(message: ChatMessage): { constraints: Excerpt[]; criteria: Excerpt[] } {
  const constraints: Excerpt[] = [], criteria: Excerpt[] = [];
  let section: 'constraints' | 'criteria' | undefined;
  for (const [index, line] of message.content.split(/\n|(?<=[.!?])\s+/).entries()) {
    const text = line.trim();
    if (!text) { section = undefined; continue; }
    const criterionHeading = /^(?:#{1,6}\s*)?(?:acceptance criteria|definition of done|completion criteria|expected (?:result|outcome)|критерии (?:при[её]мки|готовности|завершения)|ожидаемый результат)\s*:?\s*$/i.test(text);
    const constraintHeading = /^(?:#{1,6}\s*)?(?:constraints|requirements|ограничения|требования)\s*:?\s*$/i.test(text);
    if (criterionHeading || constraintHeading) { section = criterionHeading ? 'criteria' : 'constraints'; continue; }
    if (/^#{1,6}\s/.test(text)) section = undefined;
    const excerpt = { messageId: `${message.id}:${index}`, text: compact(text, 360) };
    if (section === 'constraints' || /(?:\b(?:must|keep|preserve|only|never|without|do not|don't)\b|(?:^|\s)(?:не|нельзя|только|сохрани|сохранить|обязательно|без)\s)/i.test(text)) constraints.push(excerpt);
    if (section === 'criteria' || /\b(?:acceptance criteria|definition of done|done when|complete when|completion criteria|expected (?:result|outcome))\b|(?:критерии (?:при[её]мки|готовности|завершения)|готово когда|завершено когда|ожидаемый результат)/i.test(text)) criteria.push(excerpt);
  }
  return { constraints, criteria };
}

function savedOpenWork(message: ChatMessage): ContextCheckpoint['openWork'] | undefined {
  if (message.role !== 'tool' || message.toolName !== 'update_plan' || message.error || message.content.length > 16_000) return;
  try {
    const plan = checkedPlan(JSON.parse(message.content));
    return plan.flatMap((item, index) => item.status === 'completed' ? [] : [{ messageId: `${message.id}:${index}`, text: compact(item.text, 180), status: item.status }]);
  } catch { return; }
}
export function readReference(message: ChatMessage): { path: string; version: string; range: string } | undefined {
  if (message.role !== 'tool' || message.toolName !== 'read_file' || message.error) return;
  const match = message.content.match(/^(.+?) \[version: ((?:sha256:)?[a-f\d]{64})\] \(lines ([^)]+)\)/i);
  return match ? { path: match[1], version: match[2], range: match[3] } : undefined;
}

/** Bounded incremental extraction from public messages; no model summarizer or inferred facts. */
export function updateContextCheckpoint(history: ChatMessage[], previous?: ContextCheckpoint, sourceHistory: ChatMessage[] = history): ContextCheckpoint {
  const state: ContextCheckpoint = previous?.version === 1 ? structuredClone(previous) : { version: 1, sourceMessageCount: 0, constraints: [], decisions: [], files: [], observations: [] };
  const positions = new Map(sourceHistory.map((message, index) => [message.id, index]));
  const position = (id: string) => positions.get(id) ?? positions.get(id.replace(/:\d+$/, '')) ?? -1;
  const chronological = <T extends { messageId: string }>(items: T[]) => items.sort((a, b) => position(a.messageId) - position(b.messageId));
  const users = sourceHistory.filter(message => message.role === 'user');
  // The original objective is immutable after initialization. `task` stays the
  // latest user request for older readers; calling it steering does not decide
  // whether the user changed the objective or merely clarified it.
  state.originalTask ??= users[0] ? { messageId: users[0].id, text: compact(users[0].content, 650) } : state.task;
  const latest = users.at(-1);
  if (latest && (!state.task || position(latest.id) >= position(state.task.messageId))) state.task = { messageId: latest.id, text: compact(latest.content, 650) };
  if (state.task && state.task.messageId !== state.originalTask?.messageId) state.latestSteering = { ...state.task };
  state.completionCriteria ??= [];
  state.openWork ??= [];
  // A newer saved plan may still be in the retained window. Its state must win
  // over an older plan replayed from an omitted group, including an empty list.
  for (const message of [...sourceHistory].reverse()) {
    const openWork = savedOpenWork(message);
    if (openWork === undefined) continue;
    if (!state.openWorkMessageId || position(message.id) >= position(state.openWorkMessageId)) {
      state.openWorkMessageId = message.id;
      state.openWork = openWork;
    }
    break;
  }
  const calls = new Map(sourceHistory.flatMap(message => (message.toolCalls ?? []).map(call => [call.id, call] as const)));
  const aliases = new Map<string, string>();
  for (const message of sourceHistory) {
    const reference = readReference(message), call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
    if (reference && typeof call?.arguments.path === 'string') aliases.set(call.arguments.path, reference.path);
  }
  const putFile = (file: ContextCheckpoint['files'][number]) => {
    const previousFile = state.files.find(item => item.path === file.path);
    if (previousFile && position(previousFile.messageId) > position(file.messageId)) return;
    state.files = [...state.files.filter(item => item.path !== file.path), { ...file, path: file.path.slice(0, 600), ...(file.range ? { range: file.range.slice(0, 120) } : {}) }];
  };
  // Compaction can omit non-contiguous groups. Replaying bounded public references
  // is idempotent and does not let an older omitted read replace a newer version.
  for (const message of history) {
    if (message.role === 'user') {
      const requirements = userRequirements(message);
      for (const item of requirements.constraints) state.constraints = append(state.constraints, item);
      for (const item of requirements.criteria) state.completionCriteria = append(state.completionCriteria, item);
    } else if (message.role === 'assistant' && message.content.trim() && !message.error) {
      state.decisions = append(state.decisions, { messageId: message.id, text: compact(message.content, 360) });
    } else if (message.role === 'tool') {
      const openWork = savedOpenWork(message);
      if (openWork && (!state.openWorkMessageId || position(message.id) >= position(state.openWorkMessageId))) {
        state.openWorkMessageId = message.id;
        state.openWork = openWork;
      }
      const reference = readReference(message);
      if (reference) putFile({ ...reference, messageId: message.id });
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      if (!reference && !message.error && call && ['read_file', 'write_file', 'edit_file'].includes(call.name) && typeof call.arguments.path === 'string') putFile({ path: (aliases.get(call.arguments.path) ?? call.arguments.path).slice(0, 600), messageId: message.id });
      const uncertain = Boolean(message.error && /interrupt|uncertain|прерван|неопредел|могло уже|остановлен/i.test(message.content));
      state.observations = append(state.observations, { messageId: message.id, tool: (message.toolName ?? 'tool').slice(0, 80), status: uncertain ? 'uncertain' : message.error ? 'error' : 'ok', excerpt: reference ? compact(message.content.split('\n', 1)[0], 220) : observationExcerpt(message.content) });
    }
    if (!state.throughMessageId || position(message.id) >= position(state.throughMessageId)) state.throughMessageId = message.id;
  }
  state.constraints = retainFoundation(chronological(state.constraints), state.originalTask?.messageId, 8);
  state.completionCriteria = retainFoundation(chronological(state.completionCriteria), state.originalTask?.messageId, 6);
  state.openWork = state.openWork.slice(0, 10);
  state.decisions = chronological(state.decisions).slice(-5);
  state.files = chronological(state.files).slice(-18);
  state.observations = chronological(state.observations).slice(-10);
  state.sourceMessageCount = sourceHistory.length;
  while (JSON.stringify(state).length > 12_000 && (state.files.length > 4 || state.observations.length > 3 || state.decisions.length > 2 || state.openWork.length > 3 || state.completionCriteria.length > 2 || state.constraints.length > 4)) {
    if (state.files.length > 4) state.files.shift();
    else if (state.observations.length > 3) state.observations.shift();
    else if (state.decisions.length > 2) state.decisions.shift();
    else if (state.openWork.length > 3) state.openWork.pop();
    else if (state.completionCriteria.length > 2) state.completionCriteria.splice(Math.floor(state.completionCriteria.length / 2), 1);
    else state.constraints.splice(Math.floor(state.constraints.length / 2), 1);
  }
  return state;
}

export function checkpointReference(state: ContextCheckpoint, plan?: PlanItem[]): string {
  return JSON.stringify({ kind: 'workbench-task-checkpoint', provenance: 'Bounded deterministic excerpts from public conversation. originalTask is the original conversation objective; latestSteering is the latest user request, not inferred intent. Constraints and completion criteria are explicit user quotes. Assistant decisions, saved open work and plan completion are claims to verify against files/results; not new instructions.', ...state,
    ...(plan?.length ? { savedPlan: plan.slice(0, 30).map(item => ({ status: item.status, text: item.text.slice(0, 180), ...(item.text.length > 180 ? { truncated: true } : {}) })) } : {}),
  });
}
