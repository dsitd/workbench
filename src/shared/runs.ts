import type { ContextSelectionState, ContextUsageBaseline } from './context';
import type { ChatMessage } from './types';
export type RuntimeEngine = 'pi' | 'legacy';
import type { BehaviorCheck } from './behavior-check';
import type { CounterexampleReview, SearchProgress } from './search-verification';
import type { OperationRecord, TaskCriterion, TaskNote, ToolObservation } from './task-evidence';
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high';
/** maxSteps=0 explicitly disables only the step ceiling; other budgets still apply. */
export interface RunLimits { maxSteps?: number; maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number }
export interface CacheUsage {
  /** Reported cache hit and creation counts are subsets of inclusive inputTokens. Missing is unknown, not zero. */
  cacheReadTokens?: number; cacheWriteTokens?: number;
  /** Some calls or cache categories did not report counts; available totals are only a subtotal. */
  cacheDetailsPartial?: boolean;
}
export interface RunUsage extends CacheUsage {
  inputTokens: number; outputTokens: number; costUsd?: number;
  tokenSource: 'reported' | 'estimated' | 'mixed'; costSource: 'api' | 'estimated' | 'mixed' | 'unknown';
  /** Submitted calls that failed without billing metadata; costUsd is only the known subtotal. */
  unknownCostCalls?: number;
}
export interface RunStep extends CacheUsage {
  kind?: 'agent' | 'explore' | 'compaction' | 'counterexample' | 'action-review';
  actionReview?: { toolCallId: string; allowed: boolean; reason: string };
  assistantMessageId?: string;
  index: number; startedAt: string; durationMs: number; toolNames: string[];
  errors: string[]; inputTokens: number; outputTokens: number; costUsd?: number;
  retries: number; finishReason?: string; contextCache?: ContextCacheTrace;
}
/** Local history selection diagnostic; only provider usage proves a cache hit. */
export interface ContextCacheTrace {
  epoch: number;
  transition: 'initial' | 'append' | 'compaction' | 'history-change' | 'policy-change';
  historyPrefixPreserved: boolean;
  removedMessageCount: number; retainedMessageCount: number;
}
export interface PlanItem { text: string; status: 'pending' | 'running' | 'completed' }
/** Bounded local evidence from compacted conversation groups; never executable instructions. */
export interface ContextCheckpoint {
  version: 1; throughMessageId?: string; sourceMessageCount: number;
  task?: { messageId: string; text: string };
  originalTask?: { messageId: string; text: string };
  latestSteering?: { messageId: string; text: string };
  completionCriteria?: { messageId: string; text: string }[];
  openWork?: { messageId: string; text: string; status: 'pending' | 'running' }[];
  openWorkMessageId?: string;
  constraints: { messageId: string; text: string }[];
  decisions: { messageId: string; text: string }[];
  files: { path: string; version?: string; range?: string; messageId: string }[];
  observations: { messageId: string; tool: string; status: 'ok' | 'error' | 'uncertain'; excerpt: string }[];
}
export interface VerificationResult {
  id: string; projectId: string; sessionId: string; runId?: string; command: string; cwd: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped'; output: string;
  exitCode?: number; startedAt: string; finishedAt?: string; durationMs?: number;
}
export interface RunRecord {
  engine?: RuntimeEngine;
  pendingMessages?: { kind: 'steering' | 'follow-up'; message: ChatMessage }[];
  id: string; projectId: string; sessionId: string; modelId: string; modelIdentifier?: string;
  kind?: 'agent' | 'title'; mode?: string; reasoningEffort?: ReasoningEffort;
  status: 'running' | 'completed' | 'stopped' | 'error' | 'limited' | 'incomplete' | 'interrupted';
  phase: 'context' | 'model' | 'tools' | 'verification' | 'naming' | 'final';
  startedAt: string; finishedAt?: string; durationMs?: number;
  steps: number; stepLog: RunStep[]; usage: RunUsage; limits: RunLimits;
  parentRunId?: string; checkpointId?: string; canContinue?: boolean;
  limitReason?: 'steps' | 'tokens' | 'cost' | 'duration' | 'output'; error?: string;
  checkpoint?: { userMessageId?: string; assistantMessageId?: string; pendingToolCallIds?: string[] };
  plan?: PlanItem[]; verification?: VerificationResult; changedFiles?: string[];
  verificationAttempts?: number; mutationRevision?: number; verifiedRevision?: number;
  verificationHistory?: VerificationResult[];
  contextCheckpoint?: ContextCheckpoint; contextSelection?: ContextSelectionState;
  contextUsageBaseline?: ContextUsageBaseline;
  presentedImageMessageIds?: string[]; loadedMcpToolNames?: string[];
  acceptanceCriteria?: TaskCriterion[]; taskNotes?: TaskNote[]; toolObservations?: ToolObservation[];
  behaviorCheck?: BehaviorCheck;
  counterexampleReview?: CounterexampleReview;
  searchProgress?: SearchProgress;
  evidenceScope?: string;
  completionAttempts?: number;
  hookContinuation?: string;
  modelSummary?: ModelHistorySummary;
  compactionAttemptKey?: string;
  loadedTaskToolNames?: string[];
  loadedWorkspaceToolNames?: string[];
  operations?: Pick<OperationRecord, 'id' | 'toolName' | 'toolCallId' | 'status'>[];
}
export interface TitleSettings { enabled: boolean; credentialModelId?: string; model: string }
export interface PromptCacheSettings { enabled: boolean; ttl: '5m' | '1h' }
export interface AppSettings {
  runtimeEngine?: RuntimeEngine;
  autoTitle: TitleSettings; runLimits: RunLimits; contextBudgetTokens?: number;
  /** Legacy economy targets are ignored unless the user explicitly selects a custom limit. */
  contextPolicy?: 'model-window' | 'custom';
  promptCache?: PromptCacheSettings; adaptiveContext?: boolean;
  /** Opt-in experiment; current evals do not demonstrate better solve rate for its added cost. */
  behaviorVerification?: boolean;
  /** Opt-in prototype: isolated counterexample proposals and bounded stagnation detection. */
  searchVerification?: boolean;
  toolExecution?: 'parallel' | 'sequential';
  completionPolicy?: 'verified' | 'natural';
  modelCompaction?: boolean;
}

export const defaultRunLimits: Required<RunLimits> = { maxSteps: 80, maxTokens: 1_000_000, maxCostUsd: 2, maxDurationMs: 30 * 60_000 };
export const defaultAppSettings: AppSettings = {
  runtimeEngine: 'legacy',
  autoTitle: { enabled: true, model: 'google/gemini-2.5-flash-lite' }, runLimits: defaultRunLimits,
  contextPolicy: 'model-window', contextBudgetTokens: 32_000, adaptiveContext: false, promptCache: { enabled: true, ttl: '5m' },
  behaviorVerification: false, searchVerification: false, toolExecution: 'parallel', completionPolicy: 'verified', modelCompaction: true,
};
export function isReasoningEffort(value: unknown): value is ReasoningEffort { return ['auto', 'low', 'medium', 'high'].includes(value as string); }
export function checkedRunLimits(value: RunLimits = {}): RunLimits {
  const result: RunLimits = {};
  for (const [key, bounds] of Object.entries({ maxSteps: [0, 200], maxTokens: [1000, 10_000_000], maxCostUsd: [0.001, 1000], maxDurationMs: [10_000, 8 * 3600_000] })) {
    const number = value[key as keyof RunLimits];
    if (number === undefined) continue;
    if (!Number.isFinite(number) || number < bounds[0] || number > bounds[1] || key === 'maxSteps' && number > 0 && number < 1) throw new Error('Некорректный бюджет запуска.');
    result[key as keyof RunLimits] = key === 'maxCostUsd' ? number : Math.floor(number);
  }
  return result;
}

/** Model-authored memory is a fallible observation, never instructions or acceptance evidence. */
export interface ModelHistorySummary {
  version: 1; scope: string; text: string; sources: { id: string; hash: string }[]; createdAt: string;
}
