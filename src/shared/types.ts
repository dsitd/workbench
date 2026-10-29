import type { McpConnectionReport, McpConnectionStatus, McpSecretsInput, McpServerConfig } from './mcp';
import type { AgentMode } from './modes';
import type { AppSettings, PlanItem, ReasoningEffort, RunLimits, RunRecord, VerificationResult } from './runs';
import type { CommandProcess, CommandUpdate, ContextPin, FileWriteResult, GitDiff, GitStatus, ProjectMap, TaskCheckpoint } from './workspace';
export type { AppSettings, PlanItem, ReasoningEffort, RunLimits, RunRecord, RunStep, RunUsage, TitleSettings, VerificationResult } from './runs';
export type { CommandProcess, CommandUpdate, ContextPin, FileConflict, FileWriteResult, GitDiff, GitFileStatus, GitRootStatus, GitStatus, ProjectMap, ProjectMapFile, TaskCheckpoint } from './workspace';
export type { McpConnectionReport, McpConnectionStatus, McpSecretsInput, McpServerConfig, McpTool, McpTransport } from './mcp';
export type { AgentMode } from './modes';

export type AccessMode = 'read' | 'write';
export type SessionStatus = 'idle' | 'running' | 'approval' | 'completed' | 'error' | 'stopped';
export type ModelKind = 'demo' | 'openai-compatible' | 'openai-responses' | 'anthropic';

export interface ProjectFolder { path: string; access: AccessMode }
export interface ChatDefaults { modelId: string; mode: AgentMode; reasoningEffort: ReasoningEffort }
export interface Project {
  id: string; name: string; folders: ProjectFolder[]; internet: boolean;
  commandPolicy: 'ask' | 'sandbox'; instructions: string; createdAt: string; updatedAt: string;
  verificationCommand?: string; verifyAfterRun?: boolean; runLimits?: RunLimits; memory?: string; pins?: ContextPin[];
  chatDefaults?: ChatDefaults;
}
export interface ProjectInput {
  name: string; folders: ProjectFolder[]; internet?: boolean;
  commandPolicy?: 'ask' | 'sandbox'; instructions?: string;
  verificationCommand?: string; verifyAfterRun?: boolean; runLimits?: RunLimits; memory?: string; pins?: ContextPin[];
}
export interface ModelConfig {
  id: string; name: string; kind: ModelKind; baseUrl: string; model: string;
  apiKeyEnv: string; contextWindow: number; maxOutputTokens: number;
  vision: boolean; enabled: boolean; hasKey?: boolean;
  /** References another saved OpenRouter profile; never contains a credential value. */
  credentialModelId?: string;
  reasoningEffort?: ReasoningEffort; inputPricePerMillion?: number; outputPricePerMillion?: number;
  cacheReadPricePerMillion?: number; cacheWritePricePerMillion?: number;
}
export interface ModelConnectionReport {
  modelId: string; ok: boolean; toolCalling: boolean;
  checkedAt: string; latencyMs: number; message: string;
  costUsd?: number;
}
export interface Session {
  id: string; projectId: string; title: string; modelId: string; status: SessionStatus;
  createdAt: string; updatedAt: string; summary: string; mode?: AgentMode;
  reasoningEffort?: ReasoningEffort; runLimits?: RunLimits; titleSource?: 'default' | 'automatic' | 'manual'; titleAttempted?: boolean;
  pinned?: boolean; archivedAt?: string;
}
export type SessionPatch = Partial<Pick<Session, 'title' | 'modelId' | 'mode' | 'reasoningEffort' | 'runLimits' | 'pinned'>> & { archivedAt?: string | null; rememberSelection?: boolean };
export interface Attachment {
  id: string; name: string; mimeType: string; size: number; createdAt: string;
  width?: number; height?: number;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; argumentError?: string }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string;
  createdAt: string; attachmentIds?: string[]; toolCalls?: ToolCall[];
  toolCallId?: string; toolName?: string; error?: boolean;
  providerItems?: Record<string, unknown>[]; reasoningDetails?: Record<string, unknown>[]; providerId?: string;
  imageDetail?: 'low' | 'high' | 'auto';
  /** Local activity metadata; never an additional provider instruction or model step. */
  runtimeKind?: 'verification';
  accessScope?: string; outputRef?: string;
}
export interface Skill {
  id: string; name: string; description: string; source: string; projectId?: string;
  enabled: boolean; installedAt: string; path: string;
}
export interface RuleDocument { path: string; content: string; scope: string; writable: boolean; version?: string }
export interface FileEntry {
  path: string; name: string; kind: 'file' | 'directory'; writable: boolean;
  size?: number; content?: string;
  version?: string;
}
export interface FileChange {
  id: string; projectId: string; path: string; before: string | null; after: string | null;
  createdAt: string; sessionId?: string;
  checkpointId?: string;
}
export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  permission: 'read' | 'write' | 'command' | 'network' | 'mcp';
  source?: { kind: 'mcp'; serverId: string; serverName: string; toolName: string };
}
export interface ToolResult { text: string; error?: boolean; attachmentIds?: string[]; imageDetail?: 'low' | 'high' | 'auto'; outputRef?: string;
  /** Backend-only receipt from run_command; nonzero exits can still have partial side effects. */
  commandExit?: { code: number };
}
export interface ToolContext { project: Project; sessionId: string; signal: AbortSignal; mode?: AgentMode; runId?: string; checkpointId?: string; readOnly?: boolean; operationId?: string; assistantMessageId?: string }
export interface ApprovalRequest {
  id: string; sessionId: string; projectId: string; title: string;
  description: string; kind: 'command' | 'write' | 'mcp' | 'tool';
}
export interface ContextSection {
  name: string; tokens: number; reason: string; source?: string;
}
export interface ContextReport {
  sessionId: string; estimatedTokens: number; budget: number; reserve: number;
  heuristicTokens?: number; estimationSource?: 'heuristic' | 'reported-plus-growth';
  sections: ContextSection[]; omittedMessages: number; selectedSkills: string[];
  attachmentCount: number; summaryUsed: boolean;
}
export interface AgentEvent {
  type: 'message' | 'delta' | 'status' | 'tool-start' | 'tool-end' | 'approval' | 'approval-dismissed' | 'context' | 'error' | 'changes' | 'refresh' | 'run' | 'command';
  sessionId?: string; projectId?: string; message?: ChatMessage; messageId?: string;
  text?: string; status?: SessionStatus; toolCall?: ToolCall; result?: ToolResult;
  approval?: ApprovalRequest; context?: ContextReport; error?: string;
  requestId?: string;
  run?: RunRecord; command?: CommandUpdate;
}
export interface Bootstrap {
  projects: Project[]; sessions: Session[]; models: ModelConfig[]; skills: Skill[];
  version: string; platform: string; sandboxAvailable: boolean;
  approvals?: ApprovalRequest[];
  mcpServers?: McpServerConfig[];
  settings?: AppSettings;
}
export interface SkillSource { kind: 'folder' | 'github'; location?: string; folder?: string; ref?: string }
export interface SkillInput { name: string; description: string; content: string; projectId?: string }

export interface WorkbenchAPI {
  bootstrap(): Promise<Bootstrap>;
  chooseFolders(): Promise<string[]>;
  createProject(input: ProjectInput): Promise<Project>;
  saveProject(project: Project): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  listSessions(projectId?: string): Promise<Session[]>;
  createSession(projectId: string, modelId?: string): Promise<Session>;
  updateSession(sessionId: string, patch: SessionPatch): Promise<Session>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  sendMessage(sessionId: string, text: string, attachmentIds: string[]): Promise<void>;
  stopRun(sessionId: string): Promise<void>;
  importImages(paths?: string[]): Promise<Attachment[]>;
  pasteImages(): Promise<Attachment[]>;
  resolveAttachment(id: string): Promise<string>;
  listFiles(projectId: string, path?: string): Promise<FileEntry[]>;
  readFile(projectId: string, path: string): Promise<FileEntry>;
  writeFile(projectId: string, path: string, content: string, expectedVersion?: string | null): Promise<FileWriteResult>;
  getChanges(projectId: string): Promise<FileChange[]>;
  revertChange(projectId: string, changeId: string): Promise<void>;
  getRules(projectId: string): Promise<RuleDocument[]>;
  saveRule(projectId: string, path: string, content: string, expectedVersion?: string | null): Promise<RuleDocument | { ok: false; conflict: import('./workspace').FileConflict }>;
  listSkills(projectId?: string): Promise<Skill[]>;
  createSkill(input: SkillInput): Promise<Skill>;
  saveSkill(id: string, content: string): Promise<Skill>;
  installSkill(source: SkillSource, projectId?: string): Promise<Skill[]>;
  setSkillEnabled(id: string, enabled: boolean): Promise<void>;
  removeSkill(id: string): Promise<void>;
  readSkill(id: string): Promise<string>;
  exportSkill(id: string): Promise<string | undefined>;
  saveModel(model: ModelConfig, apiKey?: string): Promise<ModelConfig>;
  testModel(modelId: string): Promise<ModelConnectionReport>;
  deleteModel(id: string): Promise<void>;
  listMcpServers(): Promise<McpServerConfig[]>;
  saveMcpServer(server: McpServerConfig, secrets?: McpSecretsInput): Promise<McpServerConfig>;
  deleteMcpServer(id: string): Promise<void>;
  testMcpServer(id: string, projectId: string): Promise<McpConnectionReport>;
  getMcpStatus(id: string, projectId: string): Promise<McpConnectionStatus>;
  disconnectMcpServer(id: string, projectId?: string): Promise<void>;
  respondApproval(id: string, approved: boolean): Promise<void>;
  getContext(sessionId: string): Promise<ContextReport | undefined>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  listRuns(projectId?: string, sessionId?: string): Promise<RunRecord[]>;
  continueRun(sessionId: string, runId?: string): Promise<void>;
  verifyRun(sessionId: string, runId?: string): Promise<VerificationResult>;
  getGitStatus(projectId: string): Promise<GitStatus>;
  getGitDiff(projectId: string, root: string, path?: string, staged?: boolean): Promise<GitDiff>;
  listCheckpoints(projectId: string, sessionId?: string): Promise<TaskCheckpoint[]>;
  revertCheckpoint(projectId: string, checkpointId: string): Promise<void>;
  listProcesses(projectId: string, sessionId?: string): Promise<CommandProcess[]>;
  stopProcess(projectId: string, processId: string): Promise<void>;
  getProjectMap(projectId: string): Promise<ProjectMap>;
  setContextPins(projectId: string, pins: ContextPin[]): Promise<ContextPin[]>;
  saveProjectMemory(projectId: string, content: string): Promise<void>;
  getFilePath(file: File): string;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
