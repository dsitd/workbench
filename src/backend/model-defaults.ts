import { flashPreset } from '../shared/model-presets';
import { isOpenRouterCredentialProfile, modelCredentialSource } from '../shared/model-credentials';
import { agentMode } from '../shared/modes';
import type { WorkspaceState } from './storage';

/** One-time selection change; subsequent user choices and deletions remain authoritative. */
export function initializeFlashDefault(state: WorkspaceState, hasMessages: (sessionId: string) => boolean, hasCredential?: (id: string) => boolean): void {
  if (state.flashDefaultInitialized) return;
  let flash = state.models.find(model => model.id === flashPreset.id);
  if (!flash) {
    flash = { id: flashPreset.id, ...flashPreset.configuration };
    if (hasCredential) {
      const recent = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const candidates = [...recent.map(session => state.models.find(model => model.id === session.modelId)), ...state.models];
      for (const candidate of candidates) {
        if (!candidate || !isOpenRouterCredentialProfile(candidate)) continue;
        try {
          const source = modelCredentialSource(candidate, state.models);
          if (!hasCredential(source.id)) continue;
          flash.credentialModelId = source.id;
          break;
        }
        catch { /* Ignore invalid legacy references; never inspect credential values. */ }
      }
    }
    state.models.unshift(flash);
  }
  if (flash.enabled) {
    for (const project of state.projects) project.chatDefaults = {
      ...project.chatDefaults, mode: agentMode(project.chatDefaults?.mode), modelId: flash.id, reasoningEffort: flash.reasoningEffort ?? 'high',
    };
    for (const session of state.sessions) {
      if (hasMessages(session.id) || session.archivedAt || ['running', 'approval'].includes(session.status)) continue;
      session.modelId = flash.id;
      session.reasoningEffort = flash.reasoningEffort ?? 'high';
    }
  }
  state.flashDefaultInitialized = true;
}
