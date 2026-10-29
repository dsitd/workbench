import type { Fetcher } from '../agent/http';
import type { ChatMessage, ModelConfig, RunRecord, ToolCall } from '../shared/types';

export interface FileExpectation { path: string; equals?: string; includes?: string[]; excludes?: string[]; json?: unknown; missing?: boolean }
export interface EvalState { messages: ChatMessage[]; run?: RunRecord }
export interface EvalTurn { content?: string; calls?: ToolCall[] }
export interface EvalTask {
  id: string; category: 'coding' | 'context' | 'safety' | 'completion'; prompt: string;
  files: Record<string, string>; expected: FileExpectation[]; allowedChanges: string[];
  readOnly?: boolean; requiredTools?: string[]; requiredToolErrors?: string[];
  toolChecks?: { tool: string; includes: string[] }[]; answerIncludes?: string[];
  status?: RunRecord['status']; evidence?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
  turn(step: number, state: EvalState): EvalTurn;
}
export interface EvalTrace { callId: string; tool: string; error: boolean; resultCount: number; outputChars: number; archived: boolean }
export interface EvalResult {
  id: string; category: EvalTask['category']; passed: boolean; failures: string[]; status: RunRecord['status'] | 'missing';
  changedFiles: string[]; trace: EvalTrace[];
  metrics: { durationMs: number; steps: number; toolCalls: number; toolErrors: number; repeatedCalls: number; inputTokens: number; outputTokens: number; tokenSource?: string; costUsd?: number; costSource?: string };
}
export interface EvalOptions {
  /** A live run never falls back to fixture replies. The caller must authorize its transport. */
  live?: { model: ModelConfig; fetch?: Fetcher; resolveCredential?: () => Promise<string | undefined> };
  onCase?: (result: EvalResult) => void;
}
export interface EvalReport {
  suite: 'workbench-task-evals-v1'; mode: 'deterministic' | 'live'; model: string; startedAt: string;
  cases: EvalResult[]; passed: number; total: number; durationMs: number;
  scope: string;
}
