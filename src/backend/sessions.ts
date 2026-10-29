import { randomUUID } from 'node:crypto';
import type { Session, SessionPatch } from '../shared/types';
import { agentMode, isAgentMode } from '../shared/modes';
import { checkedRunLimits, isReasoningEffort } from '../shared/runs';
import { StateStore, requireItem, validId } from './storage';

export const defaultChatTitle = 'Новый чат';
export function migrateChatTitle(session: Session): void {
  session.titleSource ??= ['Новая задача', defaultChatTitle].includes(session.title) ? 'default' : 'manual';
  if (session.titleSource === 'default' && session.title === 'Новая задача') session.title = defaultChatTitle;
}

/** Conversation metadata is independent of messages, runs and their costs. Archiving never deletes history. */
export class SessionService {
  constructor(private readonly store: StateStore) {}
  async list(projectId?: string): Promise<Session[]> {
    const state = await this.store.read();
    if (projectId) requireItem(state.projects, validId(projectId), 'Project');
    return state.sessions.filter(session => !projectId || session.projectId === projectId)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string): Promise<Session> { return requireItem((await this.store.read()).sessions, validId(id), 'Session'); }
  async create(projectId: string, fallbackModelId?: string): Promise<Session> {
    validId(projectId); if (fallbackModelId) validId(fallbackModelId);
    return this.store.mutate(state => {
      const project = requireItem(state.projects, projectId, 'Project');
      const defaults = project.chatDefaults;
      const latest = state.sessions.filter(item => item.projectId === projectId && !item.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const candidates = [defaults?.modelId, latest?.modelId, fallbackModelId];
      const model = candidates.map(id => state.models.find(item => item.id === id && item.enabled)).find(Boolean)
        ?? state.models.find(item => item.enabled && item.kind !== 'demo') ?? state.models.find(item => item.enabled);
      if (!model) throw new Error('Нет доступных моделей. Подключите модель в настройках.');
      const mode = agentMode(defaults?.mode ?? latest?.mode);
      const reasoningEffort = defaults?.reasoningEffort ?? latest?.reasoningEffort ?? model.reasoningEffort ?? 'auto';
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), projectId, modelId: model.id, title: defaultChatTitle, status: 'idle', summary: '', mode, reasoningEffort, titleSource: 'default', createdAt: now, updatedAt: now };
      project.chatDefaults = { modelId: model.id, mode, reasoningEffort };
      state.sessions.push(session); state.messages[session.id] = [];
      return session;
    });
  }
  async update(id: string, patch: Partial<Omit<Session, 'archivedAt'>> & SessionPatch): Promise<Session> {
    validId(id);
    if (patch.mode !== undefined && !isAgentMode(patch.mode)) throw new Error('Invalid chat mode.');
    if (patch.reasoningEffort !== undefined && !isReasoningEffort(patch.reasoningEffort)) throw new Error('Invalid reasoning effort.');
    if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw new Error('Invalid pinned chat flag.');
    if (patch.rememberSelection !== undefined && typeof patch.rememberSelection !== 'boolean') throw new Error('Invalid chat selection flag.');
    if (patch.status && !['idle', 'running', 'approval', 'completed', 'error', 'stopped'].includes(patch.status)) throw new Error('Invalid session status.');
    if (patch.archivedAt !== undefined && patch.archivedAt !== null && (typeof patch.archivedAt !== 'string' || patch.archivedAt.length > 40 || !Number.isFinite(Date.parse(patch.archivedAt)))) throw new Error('Некорректное время архивации чата.');
    const limits = patch.runLimits !== undefined ? checkedRunLimits(patch.runLimits) : undefined;
    return this.store.mutate(state => {
      const session = requireItem(state.sessions, id, 'Session');
      if (patch.modelId !== undefined) requireItem(state.models, validId(patch.modelId), 'Model');
      if (patch.archivedAt && ['running', 'approval'].includes(session.status)) throw new Error('Сначала остановите работу в чате, затем архивируйте его.');
      if (patch.title !== undefined) {
        if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 200) throw new Error('Название чата должно содержать от 1 до 200 символов.');
        session.title = patch.title.trim();
        session.titleSource = patch.titleSource ?? 'manual';
      }
      for (const key of ['modelId', 'status', 'mode', 'reasoningEffort', 'titleSource', 'titleAttempted', 'pinned'] as const) if (patch[key] !== undefined) Object.assign(session, { [key]: patch[key] });
      if (limits) session.runLimits = limits;
      if (patch.summary !== undefined) session.summary = patch.summary.slice(0, 100_000);
      if (patch.archivedAt === null) delete session.archivedAt; else if (patch.archivedAt !== undefined) session.archivedAt = patch.archivedAt;
      if (patch.rememberSelection || patch.modelId !== undefined || patch.mode !== undefined || patch.reasoningEffort !== undefined) {
        const project = requireItem(state.projects, session.projectId, 'Project');
        project.chatDefaults = { modelId: session.modelId, mode: agentMode(session.mode), reasoningEffort: session.reasoningEffort ?? 'auto' };
      }
      session.updatedAt = new Date().toISOString();
      return session;
    });
  }
}
