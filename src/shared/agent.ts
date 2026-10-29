import type { Attachment, ChatMessage, ContextReport, ModelConfig, Project, RuleDocument, Session, Skill, ToolCall, ToolContext, ToolDefinition, ToolResult, AgentEvent, ApprovalRequest, ReasoningEffort, RunRecord, AppSettings, ProjectMap } from './types';
import type { CacheUsage, VerificationResult } from './runs';
import type { OperationRecord } from './task-evidence';

export interface ModelImage { mimeType: string; base64: string; detail?: 'low' | 'high' | 'auto' }
export interface ModelMessage {
  role: ChatMessage['role']; content: string; toolCalls?: ToolCall[];
  toolCallId?: string; toolName?: string; images?: ModelImage[];
  providerItems?: Record<string, unknown>[]; reasoningDetails?: Record<string, unknown>[];
  providerId?: string; error?: boolean;
  /** Volatile quoted project data: never an explicit conversation cache boundary. */
  contextData?: boolean;
}
export interface ModelRequest {
  model: ModelConfig; system: string; messages: ModelMessage[];
  tools: ToolDefinition[]; signal: AbortSignal; apiKey?: string;
  /** Opaque app chat/revision ID used only by supported official provider routes. */
  sessionId?: string;
  /** Missing preserves provider defaults. Explicit false disables writes only where supported. */
  cachePolicy?: { enabled: boolean; ttl?: '5m' | '1h' };
  onDelta?: (text: string) => void;
  reasoningEffort?: ReasoningEffort;
  reasoningEnabled?: boolean;
  /** Session loop will pair these calls with errors, never execute incomplete arguments. */
  preserveTruncatedCalls?: boolean;
  /** A complete response with malformed arguments is paired with errors, never executed. */
  recoverInvalidToolCalls?: boolean;
  onRetry?: (retry: { attempt: number; status: number; delayMs: number }) => void;
  providerPriceLimit?: { prompt: number; completion: number };
}
export interface ModelResponse {
  content: string; toolCalls: ToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } & CacheUsage;
  providerItems?: Record<string, unknown>[];
  reasoningDetails?: Record<string, unknown>[];
  finishReason?: string; incomplete?: boolean;
}
export interface AgentDependencies {
  getSession(id: string): Promise<Session>;
  getProject(id: string): Promise<Project>;
  getModel(id: string): Promise<ModelConfig>;
  getMessages(id: string): Promise<ChatMessage[]>;
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>;
  updateSession(id: string, patch: Partial<Session>): Promise<Session>;
  loadInstructions(project: Project): Promise<RuleDocument[]>;
  listSkills(projectId: string): Promise<Skill[]>;
  readSkill(id: string): Promise<string>;
  getAttachment(id: string): Promise<Attachment>;
  resolveImage(id: string): Promise<ModelImage>;
  resolveCredential(model: ModelConfig): Promise<string | undefined>;
  tools: ToolDefinition[];
  listAdditionalTools?(project: Project, signal: AbortSignal): Promise<ToolDefinition[]>;
  approveTool?(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
  executeTool(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  emit(event: AgentEvent): void;
  saveContext(report: ContextReport): void;
  saveRun?(run: RunRecord): Promise<void>;
  getRun?(id: string): Promise<RunRecord | undefined>;
  getLatestModelSummary?(sessionId: string): Promise<RunRecord['modelSummary']>;
  getSettings?(): Promise<AppSettings>;
  createCheckpoint?(project: Project, sessionId: string, title: string, runId: string): Promise<string>;
  verifyRun?(run: RunRecord, signal: AbortSignal): Promise<VerificationResult>;
  retainToolOutput?(call: ToolCall, context: ToolContext, result: ToolResult): Promise<ToolResult>;
  beginOperation?(call: ToolCall, context: ToolContext): Promise<{ operation: OperationRecord; cachedResult?: ToolResult }>;
  finishOperation?(id: string, result: ToolResult): Promise<OperationRecord>;
  recoverToolResult?(call: ToolCall, context: ToolContext): Promise<ToolResult | undefined>;
  recoverOperation?(call: ToolCall, context: ToolContext): Promise<OperationRecord | undefined>;
  operationStates?(ids: string[], context: ToolContext): Promise<Pick<OperationRecord, 'id' | 'toolName' | 'toolCallId' | 'status'>[]>;
  getProjectContext?(project: Project, query: string, signal: AbortSignal, sessionId?: string, navigationPaths?: string[]): Promise<{ pins: { source: string; content: string }[]; map?: ProjectMap }>;
}
