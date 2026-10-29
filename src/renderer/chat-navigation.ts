import type { ModelConfig, Session } from '../shared/types';
import { flashPreset } from '../shared/model-presets';

export function projectChats(sessions: Session[], projectId: string, archived = false): Session[] {
  return sessions.filter(chat => chat.projectId === projectId && Boolean(chat.archivedAt) === archived)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
}

export function latestProjectChat(sessions: Session[], projectId: string): Session | undefined {
  return sessions.filter(chat => chat.projectId === projectId && !chat.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Only presence metadata is used here; credential values remain in the main process. */
export function fallbackChatModel(models: ModelConfig[]): ModelConfig | undefined {
  return models.find(model => model.enabled && model.id === flashPreset.id)
    ?? models.find(model => model.enabled && model.kind !== 'demo' && model.hasKey)
    ?? models.find(model => model.enabled && model.kind !== 'demo') ?? models.find(model => model.enabled);
}
