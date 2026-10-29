import type { Bootstrap, ChatMessage, RunRecord, Session } from '../shared/types';

/** Follow-up verification and naming may outlive the agent's session status. */
export function isRunActive(run: RunRecord): boolean {
  return run.status === 'running' || run.phase === 'verification' || run.verification?.status === 'running';
}

/** Loaded history can arrive after streaming updates. Event state is newer. */
export function mergeLoadedMessages(loaded: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const byId = new Map(live.map((message) => [message.id, message]));
  const loadedIds = new Set(loaded.map((message) => message.id));
  return [...loaded.map((message) => byId.get(message.id) || message), ...live.filter((message) => !loadedIds.has(message.id))];
}

export interface LiveStatus { revision: number; status: Session['status']; updatedAt: string }
export function applyStatusUpdates(loaded: Bootstrap, requestRevision: number, updates: Map<string, LiveStatus>): Bootstrap {
  return { ...loaded, sessions: loaded.sessions.map((session) => {
    const update = updates.get(session.id);
    return update && update.revision > requestRevision ? { ...session, status: update.status, updatedAt: update.updatedAt } : session;
  }) };
}

export type SessionMetadata = Partial<Pick<Session, 'title' | 'titleSource' | 'modelId' | 'mode' | 'reasoningEffort' | 'runLimits' | 'pinned' | 'archivedAt'>>;
export interface LocalSessionUpdate { revision: number; metadata: SessionMetadata }
/** A refresh started before a user's save must not replace that acknowledged edit. */
export function applySessionUpdates(loaded: Bootstrap, requestRevision: number, updates: Map<string, LocalSessionUpdate>): Bootstrap {
  return { ...loaded, sessions: loaded.sessions.map((session) => {
    const update = updates.get(session.id);
    return update && update.revision > requestRevision ? { ...session, ...update.metadata } : session;
  }) };
}
