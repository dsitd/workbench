import type { Project, ToolResult } from './types';

export const accessScope = (project: Project): string => JSON.stringify([project.folders, project.internet, project.commandPolicy]);
export interface TaskCriterion {
  id: string; text: string; sourceQuote: string; sourceMessageId: string;
  toolName?: string; expectedText?: string;
  evidence?: { toolCallId: string; messageId: string; revision: number; recordedAt: string; scope?: string };
}
export interface TaskNote {
  /** Optional for records saved before structured task memory was introduced. */
  id?: string;
  text: string;
  kind: 'objective' | 'constraint' | 'decision' | 'rejected_hypothesis' | 'finding' | 'open_question' | 'next_step';
  rationale?: string;
  sourceQuote?: string;
  sourceMessageIds: string[];
  scope?: string;
}
export interface ToolObservation { toolCallId: string; messageId: string; toolName: string; revision: number; error: boolean; scope?: string }
export interface OperationRecord {
  id: string; projectId: string; sessionId: string; runId?: string; toolCallId: string; toolName: string;
  fingerprint: string; scope: string; status: 'running' | 'confirmed' | 'failed' | 'uncertain' | 'not-executed';
  startedAt: string; updatedAt: string; result?: ToolResult; evidenceMessageId?: string;
}
export class OperationPendingError extends Error {
  constructor(readonly operation: Pick<OperationRecord, 'id' | 'toolName' | 'toolCallId' | 'status'>) {
    super(`Operation ${operation.id} has an uncertain external effect. Inspect current state and use reconcile_operation before repeating it. No new action was performed.`);
  }
}
