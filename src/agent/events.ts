import type { AgentDependencies } from '../shared/agent';
import type { AgentEvent } from '../shared/types';

/** Persisted facts and tool execution do not depend on a renderer receiving a notification. */
export function emitSafely(emit: AgentDependencies['emit'], event: AgentEvent): void {
  try { emit(event); } catch { /* Closing or failing UI transports cannot roll back stored facts. */ }
}
