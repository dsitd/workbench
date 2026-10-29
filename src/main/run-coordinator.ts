import { randomUUID } from 'node:crypto';
import type { AgentEvent, ModelConfig, RunRecord, RunUsage, VerificationResult } from '../shared/types';
import type { WorkspaceServices } from '../backend';
import type { CredentialVault } from './credentials';
import { generateTitle } from '../agent/title';
import { titleModel } from '../agent/title-model';
import { estimateTokens } from '../agent/context';
import { ModelGenerationFailure } from '../agent/provider-failure';
import { agentMode } from '../shared/modes';
import { isOpenRouterCredentialProfile } from '../shared/model-credentials';
import { verifyProjectRun } from '../backend/verification';
import { freshVerification } from '../agent/verification';

function openRouter(model: ModelConfig): boolean {
  return model.enabled && isOpenRouterCredentialProfile(model);
}
function cacheUsage(usage?: Pick<RunUsage, 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheDetailsPartial'>) {
  return { ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage?.cacheDetailsPartial ? { cacheDetailsPartial: true } : {}) };
}
/** Coordinates local verification and inexpensive naming after the agent has stopped. */
export class RunCoordinator {
  private controllers = new Map<string, AbortController>();
  constructor(private workspace: WorkspaceServices, private vault: CredentialVault, private emit: (event: AgentEvent) => void) {}
  begin(sessionId: string): AbortSignal { const controller = new AbortController(); this.controllers.set(sessionId, controller); return controller.signal; }
  end(sessionId: string): void { this.controllers.delete(sessionId); }
  stop(sessionId: string): void { this.controllers.get(sessionId)?.abort(); }
  stopAll(): void { for (const controller of this.controllers.values()) controller.abort(); }

  async afterRun(sessionId: string, signal: AbortSignal): Promise<void> {
    const session = await this.workspace.getSession(sessionId);
    const run = (await this.workspace.listRuns(session.projectId, sessionId)).find(item => item.kind !== 'title');
    if (!run) return;
    await this.refreshFiles(run);
    const project = await this.workspace.getProject(session.projectId);
    if (!signal.aborted && run.engine !== 'pi' && run.status === 'completed' && agentMode(session.mode) !== 'plan' && project.verificationCommand && project.verifyAfterRun !== false && !freshVerification(run, project))
      await this.verify(sessionId, run.id, signal);
    if (!signal.aborted) await this.name(sessionId, signal);
  }
  private async refreshFiles(run: RunRecord): Promise<void> {
    run.changedFiles = run.checkpointId ? [...new Set((await this.workspace.getChanges(run.projectId)).filter(change => change.checkpointId === run.checkpointId).map(change => change.path))] : [];
    await this.workspace.saveRun(run);
  }
  async verify(sessionId: string, runId: string | undefined, signal: AbortSignal): Promise<VerificationResult> {
    const session = await this.workspace.getSession(sessionId), project = await this.workspace.getProject(session.projectId);
    const run = runId ? await this.workspace.getRun(runId) : (await this.workspace.listRuns(project.id, sessionId)).find(item => item.kind !== 'title');
    if (!run || run.sessionId !== sessionId || run.projectId !== project.id || run.kind === 'title' || run.status === 'running') throw new Error('Выберите завершённый запуск этого чата для проверки.');
    return verifyProjectRun(this.workspace, run, session, project, signal);
  }
  async verifyActiveRun(run: RunRecord, signal: AbortSignal): Promise<VerificationResult> {
    const session = await this.workspace.getSession(run.sessionId), project = await this.workspace.getProject(session.projectId);
    if (run.projectId !== project.id || run.status !== 'running' || run.kind === 'title') throw new Error('Проверка не относится к активной задаче.');
    return verifyProjectRun(this.workspace, run, session, project, signal);
  }
  private async name(sessionId: string, signal: AbortSignal): Promise<void> {
    const session = await this.workspace.getSession(sessionId), settings = await this.workspace.getSettings();
    if (!settings.autoTitle.enabled || session.titleSource !== 'default' || session.titleAttempted || !['Новая задача', 'Новый чат'].includes(session.title)) return;
    const models = await this.workspace.listModels();
    const source = settings.autoTitle.credentialModelId ? models.find(item => item.id === settings.autoTitle.credentialModelId) : models.find(item => item.id === session.modelId && openRouter(item)) ?? models.find(openRouter);
    if (!source || !openRouter(source)) return;
    const apiKey = await this.vault.resolve(source, models); if (!apiKey || signal.aborted) return;
    const messages = await this.workspace.getMessages(sessionId), first = messages.find(item => item.role === 'user'); if (!first) return;
    const final = [...messages].reverse().find(item => item.role === 'assistant' && !item.toolCalls?.length && !item.error);
    await this.workspace.updateSession(sessionId, { titleAttempted: true });
    const model = titleModel(source, settings.autoTitle.model, models);
    const run: RunRecord = { id: randomUUID(), projectId: session.projectId, sessionId, modelId: source.id, modelIdentifier: model.model, kind: 'title', status: 'running', phase: 'naming', startedAt: new Date().toISOString(), steps: 0, stepLog: [], usage: { inputTokens: 0, outputTokens: 0, tokenSource: 'estimated', costSource: 'unknown' }, limits: { maxSteps: 1, maxDurationMs: 30_000 } };
    await this.workspace.saveRun(run);
    try {
      const title = await generateTitle({ model, apiKey, firstUser: first.content, finalAnswer: final?.content ?? '', signal });
      const input = title.usage?.inputTokens ?? estimateTokens(first.content.slice(0,2000) + (final?.content ?? '').slice(0,2000) + ' '.repeat(300)), output = title.usage?.outputTokens ?? estimateTokens(title.title);
      const apiCost = title.usage?.costUsd;
      const knownPrice = model.model === 'google/gemini-2.5-flash-lite';
      run.usage = { inputTokens: input, outputTokens: output, ...cacheUsage(title.usage), tokenSource: title.usage?.inputTokens !== undefined && title.usage.outputTokens !== undefined ? 'reported' : 'estimated', costUsd: apiCost ?? (knownPrice ? (input * 0.1 + output * 0.4) / 1_000_000 : undefined), costSource: apiCost !== undefined ? 'api' : knownPrice ? 'estimated' : 'unknown' };
      run.steps = 1; run.status = 'completed';
      if (!signal.aborted) await this.workspace.automaticTitle(sessionId, title.title);
    } catch (error) {
      if (error instanceof ModelGenerationFailure && error.usage) run.usage = {
        inputTokens: error.usage.inputTokens ?? estimateTokens(first.content.slice(0, 2000) + (final?.content ?? '').slice(0, 2000) + ' '.repeat(300)),
        outputTokens: error.usage.outputTokens ?? 0, ...cacheUsage(error.usage),
        tokenSource: error.usage.inputTokens !== undefined && error.usage.outputTokens !== undefined ? 'reported' : 'estimated',
        costUsd: error.usage.costUsd, costSource: error.usage.costUsd !== undefined ? 'api' : 'unknown' };
      run.status = signal.aborted ? 'stopped' : 'error'; run.error = 'Название не получено; чат и результаты работы сохранены.'; }
    finally { run.finishedAt = new Date().toISOString(); run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt); run.phase = 'final'; await this.workspace.saveRun(run); this.emit({ type: 'refresh', sessionId }); }
  }
}
