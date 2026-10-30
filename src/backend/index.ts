import { randomUUID } from 'node:crypto';
import { normalizeFolders } from './access';
import { AttachmentService } from './attachments';
import { CommandService, sandboxAvailable, type WorkspaceCallbacks, type CommandRuntime } from './commands';
import { DiagnosticService } from './diagnostics';
import { FileService, FileConflictError, fileVersion } from './files';
import { RunStore } from './runs';
import { SessionService, migrateChatTitle } from './sessions';
import { GitService } from './git';
import { ProjectIndexService } from './project-index';
import { checkedPins, projectContext } from './project-context';
import { appSettings, projectFeatures } from './settings';
import { checkedRunLimits, isReasoningEffort } from '../shared/runs';
import { SkillService } from './skills';
import { requireItem, StateStore, validId } from './storage';
import { builtinTools } from './tools';
import { ToolRegistry } from './tool-registry';
import { contextTools } from './context-tools';
import { HistoryService } from './history';
import { ToolOutputStore } from './tool-output';
import { OperationStore } from './operations';
import { accessScope } from '../shared/task-evidence';
import { modelPresets } from '../shared/model-presets';
import { initializeFlashDefault } from './model-defaults';
import { modelCredentialSource } from '../shared/model-credentials';
import { agentMode, isAgentMode } from '../shared/modes';
import type { AppSettings, ContextPin, RunRecord, Attachment, Bootstrap, ChatMessage, ModelConfig, Project, ProjectInput, Session, SkillInput, SkillSource, ToolCall, ToolContext, ToolResult } from '../shared/types';

export { toolDefinitions } from './tools';
export { sandboxAvailable } from './commands';

function title(value: string, label: string, limit = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} must contain 1–${limit} characters.`);
  return value.trim();
}
const demoModel: ModelConfig = { id: 'demo', name: 'Демонстрация (без API)', kind: 'demo', baseUrl: '', model: 'local-demo', apiKeyEnv: '', contextWindow: 32_000, maxOutputTokens: 4000, vision: false, enabled: true };
const legacyDefaultModel: ModelConfig = {
  id: 'deepinfra-claude-sonnet-55', name: 'Claude Sonnet 5.5 · DeepInfra', kind: 'openai-compatible',
  baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'anthropic/claude-sonnet-5-5',
  apiKeyEnv: 'DEEPINFRA_API_KEY', contextWindow: 1_000_000, maxOutputTokens: 8192, vision: true, enabled: true,
};
function isLegacyDefault(model: ModelConfig): boolean {
  return Object.entries(legacyDefaultModel).every(([key, value]) => model[key as keyof ModelConfig] === value);
}

export class WorkspaceServices {
  readonly store: StateStore;
  readonly files: FileService;
  readonly attachments: AttachmentService;
  readonly skills: SkillService;
  readonly commands: CommandService;
  readonly diagnostics: DiagnosticService;
  readonly runs: RunStore;
  readonly sessions: SessionService;
  readonly git: GitService;
  readonly projectIndex: ProjectIndexService;
  readonly history: HistoryService;
  readonly outputs: ToolOutputStore;
  readonly operations: OperationStore;
  readonly toolRegistry = new ToolRegistry<WorkspaceServices>([...builtinTools, ...contextTools]);
  get tools() { return this.toolRegistry.definitions; }
  private initialization?: Promise<void>;

  constructor(dataDir: string, private callbacks: WorkspaceCallbacks, commandRuntime?: CommandRuntime) {
    this.store = new StateStore(dataDir);
    this.files = new FileService(this.store, projectId => callbacks.emit({ type: 'changes', projectId }));
    this.attachments = new AttachmentService(this.store);
    this.skills = new SkillService(this.store);
    this.commands = new CommandService(this.store.directory, callbacks, context => this.toolContext(context), commandRuntime);
    this.diagnostics = new DiagnosticService(this.files, this.commands);
    this.runs = new RunStore(dataDir);
    this.sessions = new SessionService(this.store);
    this.git = new GitService(this.files, this.commands);
    this.projectIndex = new ProjectIndexService(this.files);
    this.history = new HistoryService(id => this.getMessages(id));
    this.outputs = new ToolOutputStore(dataDir);
    this.operations = new OperationStore(dataDir, callbacks.approve, id => this.getMessages(id));
  }

  async bootstrap(hasCredential?: (id: string) => boolean): Promise<Bootstrap> {
    this.initialization ??= this.store.mutate(async state => {
      state.settings = appSettings(state.settings);
      for (const session of state.sessions) migrateChatTitle(session);
      const preset = modelPresets[0];
      for (const model of state.models) if (model.id === preset.id && model.model === preset.configuration.model && model.baseUrl === preset.configuration.baseUrl) {
        model.inputPricePerMillion ??= preset.configuration.inputPricePerMillion; model.outputPricePerMillion ??= preset.configuration.outputPricePerMillion;
        if (preset.configuration.cacheReadPricePerMillion !== undefined) model.cacheReadPricePerMillion ??= preset.configuration.cacheReadPricePerMillion;
        if (preset.configuration.cacheWritePricePerMillion !== undefined) model.cacheWritePricePerMillion ??= preset.configuration.cacheWritePricePerMillion;
      }
      if (!state.models.length) state.models.push(demoModel);
      const presetsRevision = state.modelPresetsRevision ?? (state.modelPresetsInitialized ? 1 : 0);
      if (presetsRevision < 2) {
        const providers = state.models.filter(model => model.kind !== 'demo');
        if (!providers.length || (providers.length === 1 && isLegacyDefault(providers[0]))) {
          const preset = modelPresets[0];
          if (!state.models.some(model => model.id === preset.id)) state.models.push({ id: preset.id, ...preset.configuration });
        }
        state.modelPresetsRevision = 2;
        state.modelPresetsInitialized = true;
      }
      const used = state.flashDefaultInitialized ? new Set<string>() : await this.store.messageSessions();
      initializeFlashDefault(state, id => used.has(id), hasCredential);
      // Recover once on application startup; later UI refreshes must not stop live runs.
      for (const session of state.sessions) if (['running', 'approval'].includes(session.status)) session.status = 'stopped';
    }).then(async () => { await this.runs.recover(); await this.operations.recover(); });
    await this.initialization;
    const current = await this.store.read();
    return { projects: current.projects, sessions: current.sessions, models: current.models, skills: current.skills, mcpServers: current.mcpServers ?? [], settings: appSettings(current.settings), version: '0.5.1', platform: process.platform, sandboxAvailable: await sandboxAvailable() };
  }

  async getProject(id: string): Promise<Project> { return requireItem((await this.store.read()).projects, validId(id), 'Project'); }
  async listProjects(): Promise<Project[]> { return (await this.store.read()).projects; }

  async createProject(input: ProjectInput): Promise<Project> {
    const name = title(input.name, 'Project name');
    const folders = await normalizeFolders(input.folders);
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name, folders, internet: input.internet === true, commandPolicy: input.commandPolicy === 'sandbox' ? 'sandbox' : 'ask', instructions: typeof input.instructions === 'string' ? input.instructions.slice(0, 100_000) : '', ...projectFeatures(input), createdAt: now, updatedAt: now };
    await this.store.mutate(state => { state.projects.push(project); });
    this.callbacks.emit({ type: 'refresh', projectId: project.id });
    return project;
  }

  async saveProject(input: Project): Promise<Project> {
    const existing = await this.getProject(input.id);
    const folders = await normalizeFolders(input.folders);
    if (typeof input.instructions !== 'string' || input.instructions.length > 100_000) throw new Error('Project instructions must be at most 100000 characters.');
    const project: Project = { ...existing, name: title(input.name, 'Project name'), folders, internet: input.internet === true, commandPolicy: input.commandPolicy === 'sandbox' ? 'sandbox' : 'ask', instructions: input.instructions, ...projectFeatures(input), updatedAt: new Date().toISOString() };
    await this.store.mutate(state => { state.projects[state.projects.findIndex(value => value.id === existing.id)] = project; });
    this.callbacks.emit({ type: 'refresh', projectId: project.id });
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    await this.getProject(id);
    const installed = (await this.store.read()).skills.filter(skill => skill.projectId === id);
    for (const skill of installed) await this.skills.remove(skill.id);
    const removed = await this.store.mutate(state => {
      const owned = { sessions: state.sessions.filter(value => value.projectId === id).map(value => value.id), changes: state.changes.filter(value => value.projectId === id).map(value => value.id) };
      state.projects = state.projects.filter(value => value.id !== id);
      state.sessions = state.sessions.filter(value => value.projectId !== id);
      state.changes = state.changes.filter(value => value.projectId !== id);
      if (state.checkpoints) state.checkpoints = state.checkpoints.filter(value => value.projectId !== id);
      for (const server of state.mcpServers ?? []) server.projectIds = server.projectIds.filter(projectId => projectId !== id);
      return owned;
    });
    // Private per-project records outlive workspace.json otherwise. Attachments are global (no project owner) and stay.
    await this.store.discardMessages(removed.sessions); await this.store.discardChanges(removed.changes);
    await this.operations.removeProject(id); await this.runs.removeProject(id);
    this.callbacks.emit({ type: 'refresh' });
  }

  async listSessions(projectId?: string): Promise<Session[]> { return this.sessions.list(projectId); }
  async getSession(id: string): Promise<Session> { return this.sessions.get(id); }
  async createSession(projectId: string, modelId?: string): Promise<Session> { return this.sessions.create(projectId, modelId); }
  async updateSession(id: string, patch: Parameters<SessionService['update']>[1]): Promise<Session> { return this.sessions.update(id, patch); }
  async getMessages(id: string): Promise<ChatMessage[]> { await this.store.view(state => { requireItem(state.sessions, validId(id), 'Session'); }); return this.store.messages(id); }
  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    if (!message || !['user', 'assistant', 'tool', 'system'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 5_000_000) throw new Error('Invalid conversation message.');
    await this.store.appendMessage(validId(sessionId), state => {
      const session = requireItem(state.sessions, sessionId, 'Session');
      if (message.attachmentIds) for (const id of message.attachmentIds) requireItem(state.attachments, validId(id), 'Attachment');
      const project = requireItem(state.projects, session.projectId, 'Project');
      session.updatedAt = new Date().toISOString();
      return { ...message, accessScope: accessScope(project) };
    });
  }

  async listModels(): Promise<ModelConfig[]> { return (await this.store.read()).models; }
  async getModel(id: string): Promise<ModelConfig> { return requireItem((await this.store.read()).models, validId(id), 'Model'); }
  async saveModel(input: ModelConfig): Promise<ModelConfig> {
    const id = input.id ? validId(input.id) : randomUUID();
    if (!['demo', 'openai-compatible', 'openai-responses', 'anthropic'].includes(input.kind)) throw new Error('Invalid model provider.');
    if (input.kind !== 'demo') {
      const url = new URL(input.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Model URL must use HTTP(S) without credentials.');
      if (input.apiKeyEnv && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(input.apiKeyEnv)) throw new Error('Credential environment variable name is invalid.');
    }
    if (!Number.isFinite(input.contextWindow) || input.contextWindow < 4096 || input.contextWindow > 2_000_000) throw new Error('Context window must be between 4096 and 2000000 tokens.');
    if (!Number.isFinite(input.maxOutputTokens) || input.maxOutputTokens < 64 || input.maxOutputTokens >= input.contextWindow) throw new Error('Output token budget must be positive and smaller than context window.');
    if (input.reasoningEffort !== undefined && !isReasoningEffort(input.reasoningEffort)) throw new Error('Invalid model reasoning effort.');
    for (const price of [input.inputPricePerMillion, input.outputPricePerMillion, input.cacheReadPricePerMillion, input.cacheWritePricePerMillion]) if (price !== undefined && (!Number.isFinite(price) || price < 0 || price > 100000)) throw new Error('Invalid model price.');
    const model: ModelConfig = { ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.inputPricePerMillion !== undefined ? { inputPricePerMillion: input.inputPricePerMillion } : {}), ...(input.outputPricePerMillion !== undefined ? { outputPricePerMillion: input.outputPricePerMillion } : {}),
      ...(input.cacheReadPricePerMillion !== undefined ? { cacheReadPricePerMillion: input.cacheReadPricePerMillion } : {}), ...(input.cacheWritePricePerMillion !== undefined ? { cacheWritePricePerMillion: input.cacheWritePricePerMillion } : {}),
      id, name: title(input.name, 'Model name'), kind: input.kind, baseUrl: input.baseUrl, model: title(input.model, 'Model identifier', 250), apiKeyEnv: input.apiKeyEnv, contextWindow: Math.floor(input.contextWindow), maxOutputTokens: Math.floor(input.maxOutputTokens), vision: input.vision === true, enabled: input.enabled === true };
    if (input.credentialModelId !== undefined) model.credentialModelId = validId(input.credentialModelId);
    await this.store.mutate(state => {
      const models = [...state.models.filter(value => value.id !== id), model];
      // Validate dependents too: a source endpoint cannot change under a shared key.
      for (const configured of models) modelCredentialSource(configured, models);
      const index = state.models.findIndex(value => value.id === id); if (index < 0) state.models.push(model); else state.models[index] = model;
    });
    return model;
  }
  async deleteModel(id: string): Promise<void> {
    await this.store.mutate(state => {
      requireItem(state.models, validId(id), 'Model');
      if (state.models.some(model => model.credentialModelId === id)) throw new Error('Этот профиль предоставляет ключ другим моделям. Сначала смените их профиль ключа.');
      if (state.sessions.some(session => session.modelId === id)) throw new Error('This model is used by existing sessions. Select another model in those sessions first.');
      state.models = state.models.filter(model => model.id !== id);
    });
  }

  async importImages(paths: string[] = []): Promise<Attachment[]> { return this.attachments.import(paths); }
  async getAttachment(id: string) { return this.attachments.get(id); }
  async resolveAttachment(id: string) { return this.attachments.resolve(id); }
  async resolveImage(id: string) { return this.attachments.image(id); }
  async listFiles(projectId: string, path?: string) { return this.files.list(await this.getProject(projectId), path); }
  async readFile(projectId: string, path: string) { return this.files.read(await this.getProject(projectId), path); }
  async writeFile(projectId: string, path: string, content: string, expectedVersion?: string | null) {
    try { await this.files.write(await this.getProject(projectId), path, content, undefined, { expectedVersion }); return { ok: true as const }; }
    catch (error) { if (error instanceof FileConflictError) return { ok: false as const, conflict: error.conflict }; throw error; }
  }
  async searchFiles(projectId: string, query: string, path?: string, maxResults?: number) { return this.files.search(await this.getProject(projectId), query, path, maxResults); }
  async getChanges(projectId: string) { await this.getProject(projectId); return this.files.changes(projectId); }
  async revertChange(projectId: string, id: string) { return this.files.revert(await this.getProject(projectId), id); }
  async getRules(projectId: string) { return this.files.rules(await this.getProject(projectId)); }
  async loadInstructions(project: Project) { return this.files.rules(await this.getProject(project.id)); }
  async saveRule(projectId: string, path: string, content: string, expectedVersion?: string | null) {
    const project = await this.getProject(projectId);
    if (path === `project:${projectId}`) {
      const conflict = await this.store.mutate(state => {
        const current = requireItem(state.projects, projectId, 'Project'); const version = fileVersion(current.instructions);
        if (expectedVersion !== undefined && expectedVersion !== version) return { path, expectedVersion, currentVersion: version, currentContent: current.instructions };
        if (content.length > 100000) throw new Error('Project instructions too large.');
        current.instructions = content; current.updatedAt = new Date().toISOString();
        return undefined;
      });
      if (conflict) return { ok: false as const, conflict };
      return { path, content, version: fileVersion(content), scope: 'Project settings', writable: true };
    }
    if (!/(?:^|[\\/])AGENTS\.md$/.test(path)) throw new Error('Only AGENTS.md can be edited as a rule document.');
    const result = await this.writeFile(projectId, path, content, expectedVersion);
    if (!result.ok) return result;
    return (await this.files.rules(project)).find(rule => rule.path === path) ?? { path, content, scope: path.replace(/[\\/]AGENTS\.md$/, ''), writable: true };
  }
  async listSkills(projectId?: string) { if (projectId) await this.getProject(projectId); return this.skills.list(projectId); }
  async installSkill(source: SkillSource, projectId?: string) { const installed = await this.skills.install(source, projectId); this.callbacks.emit({ type: 'refresh', projectId }); return installed; }
  async createSkill(input: SkillInput) { const skill = await this.skills.create(input); this.callbacks.emit({ type: 'refresh', projectId: input.projectId }); return skill; }
  async saveSkill(id: string, content: string) { const skill = await this.skills.save(id, content); this.callbacks.emit({ type: 'refresh', projectId: skill.projectId }); return skill; }
  async setSkillEnabled(id: string, enabled: boolean) { await this.skills.setEnabled(id, enabled); this.callbacks.emit({ type: 'refresh' }); }
  async removeSkill(id: string) { await this.skills.remove(id); this.callbacks.emit({ type: 'refresh' }); }
  async readSkill(id: string) { return this.skills.read(id); }
  async exportSkill(id: string) { return this.skills.export(id); }

  async getSettings(): Promise<AppSettings> { return appSettings((await this.store.read()).settings); }
  async saveSettings(input: AppSettings): Promise<AppSettings> { const settings = appSettings(input); if (settings.autoTitle.credentialModelId) await this.getModel(settings.autoTitle.credentialModelId); await this.store.mutate(state => { state.settings = settings; }); return settings; }
  async saveRun(run: RunRecord): Promise<void> { const session = await this.getSession(run.sessionId); if (session.projectId !== run.projectId) throw new Error('Run belongs to another project.'); await this.runs.save(run); this.callbacks.emit({ type: 'run', projectId: run.projectId, sessionId: run.sessionId, run }); }
  async getRun(id: string) { return this.runs.get(id); }
  async listRuns(projectId?: string, sessionId?: string) { if (projectId) await this.getProject(projectId); if (sessionId) await this.getSession(sessionId); return this.runs.list(projectId, sessionId); }
  async createCheckpoint(project: Project, sessionId: string, name: string, runId: string): Promise<string> { return (await this.files.createCheckpoint(await this.getProject(project.id), sessionId, name.slice(0,160), runId)).id; }
  async listCheckpoints(projectId: string, sessionId?: string) { await this.getProject(projectId); if (sessionId && (await this.getSession(sessionId)).projectId !== projectId) throw new Error('Session belongs to another project.'); return this.files.checkpoints(projectId, sessionId); }
  async revertCheckpoint(projectId: string, id: string) { return this.files.revertCheckpoint(await this.getProject(projectId), id); }
  async getGitStatus(projectId: string) { return this.git.status(await this.getProject(projectId)); }
  async getGitDiff(projectId: string, root: string, file?: string, staged?: boolean) { return this.git.diff(await this.getProject(projectId), root, file, staged); }
  async getProjectMap(projectId: string) { return this.projectIndex.build(await this.getProject(projectId)); }
  async getProjectContext(project: Project, query: string, signal: AbortSignal, sessionId?: string, navigationPaths?: string[]) { return projectContext(this.files, this.projectIndex, await this.getProject(project.id), query, signal, sessionId, navigationPaths); }
  async setContextPins(projectId: string, input: ContextPin[]): Promise<ContextPin[]> { const project = await this.getProject(projectId); const pins = checkedPins(input); for (const pin of pins) await this.files.resolvePath(project, pin.path); await this.saveProject({ ...project, pins }); return pins; }
  async saveProjectMemory(projectId: string, content: string): Promise<void> { await this.saveProject({ ...await this.getProject(projectId), memory: content }); }
  async listProcesses(projectId: string, sessionId?: string) { await this.getProject(projectId); if (sessionId && (await this.getSession(sessionId)).projectId !== projectId) throw new Error('Session belongs to another project.'); return this.commands.listProcesses(projectId, sessionId); }
  async stopProcess(projectId: string, processId: string) { await this.getProject(projectId); await this.commands.stopProcess(projectId, processId); }
  async automaticTitle(sessionId: string, name: string): Promise<void> { await this.store.mutate(state => { const session = requireItem(state.sessions, sessionId, 'Session'); if (session.titleSource === 'default' && ['Новая задача', 'Новый чат'].includes(session.title)) { session.title = title(name, 'Chat title', 80); session.titleSource = 'automatic'; } }); this.callbacks.emit({ type: 'refresh', sessionId }); }

  private async toolContext(context: ToolContext): Promise<ToolContext> {
    if (context.signal.aborted) throw new Error('Task cancelled.');
    const project = await this.getProject(context.project.id);
    const scope = (value: Project) => JSON.stringify([value.folders, value.internet, value.commandPolicy]);
    if (scope(project) !== scope(context.project)) throw new Error('Project folders changed or access permissions changed during this task. Stop and restart the session before using the new settings.');
    const session = await this.getSession(context.sessionId);
    if (session.projectId !== project.id) throw new Error('Session does not belong to this project.');
    const mode = agentMode(session.mode);
    if (context.mode !== undefined && agentMode(context.mode) !== mode) throw new Error('Chat mode changed during this task. Stop and restart the session.');
    return { ...context, project, mode };
  }

  async executeTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    try {
      const current = await this.toolContext(context);
      return await this.toolRegistry.execute(call, current, this);
    } catch (error) { return { text: (error as Error).message || 'Tool failed.', error: true }; }
  }
}
