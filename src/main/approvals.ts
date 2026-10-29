import { randomUUID } from 'node:crypto';
import type { AgentEvent, ApprovalRequest } from '../shared/types';

export class ApprovalBroker {
  private pending = new Map<string, { request: ApprovalRequest; finish: (approved: boolean) => void }>();
  constructor(private emit: (event: AgentEvent) => void) {}
  /** An aborted signal dismisses this request so a stale card cannot outlive its action. */
  request(input: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const request = { ...input, id: input.id || randomUUID() };
    return new Promise(resolve => {
      const timer = setTimeout(() => this.respond(request.id, false), 5 * 60_000);
      const abort = () => this.respond(request.id, false);
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (approved: boolean) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(request.id);
        this.emit({ type: 'approval-dismissed', sessionId: request.sessionId, requestId: request.id });
        resolve(approved);
      };
      this.pending.set(request.id, { request, finish });
      this.emit({ type: 'approval', sessionId: request.sessionId, projectId: request.projectId, approval: request });
    });
  }
  respond(id: string, approved: boolean) { this.pending.get(id)?.finish(approved); }
  listRequests() { return [...this.pending.values()].map(item => ({ ...item.request })); }
  cancelSession(sessionId: string) { for (const item of [...this.pending.values()]) if (item.request.sessionId === sessionId) item.finish(false); }
  cancelAll() { for (const item of [...this.pending.values()]) item.finish(false); }
}
