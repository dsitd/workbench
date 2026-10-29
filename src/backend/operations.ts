import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatMessage, ToolCall, ToolContext, ToolResult } from '../shared/types';
import { accessScope, OperationPendingError, type OperationRecord } from '../shared/task-evidence';
import { PrivateRecords } from './private-records';
import { nonEvidenceTools } from '../shared/evidence-policy';
import type { WorkspaceCallbacks } from './commands';

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Operation arguments are too deeply nested.');
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item, depth + 1)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const idFor = (call: ToolCall, context: ToolContext) => 'op_' + digest(JSON.stringify([context.project.id, context.sessionId, context.assistantMessageId ?? '', call.id]));
export type OperationStart = { operation: OperationRecord; cachedResult?: ToolResult };
type PendingOperation = Pick<OperationRecord, 'id' | 'projectId' | 'sessionId' | 'fingerprint' | 'status' | 'toolName' | 'toolCallId'>;
const isPending = (record: OperationRecord) => ['running', 'uncertain'].includes(record.status);

/** Confirmed calls replay receipts. Uncertain identical effects require observed reconciliation. */
export class OperationStore {
  private records: PrivateRecords<OperationRecord>;
  private queue: Promise<unknown> = Promise.resolve();
  // Running/uncertain operations only; loaded once from disk, then kept in sync by `persist` inside `serial`.
  private active?: Map<string, PendingOperation>;
  constructor(dataDir: string, private approve: WorkspaceCallbacks['approve'], private messages: (sessionId: string) => Promise<ChatMessage[]>) {
    this.records = new PrivateRecords(path.join(dataDir, 'operations'));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation); this.queue = pending.catch(() => undefined); return pending;
  }
  private track(active: Map<string, PendingOperation>, record: OperationRecord): void {
    if (!isPending(record)) { active.delete(record.id); return; }
    const { id, projectId, sessionId, fingerprint, status, toolName, toolCallId } = record;
    active.set(id, { id, projectId, sessionId, fingerprint, status, toolName, toolCallId });
  }
  /** Call only inside `serial`. */
  private async pendingIndex(): Promise<Map<string, PendingOperation>> {
    if (!this.active) { const active = new Map<string, PendingOperation>(); for (const record of await this.records.list()) this.track(active, record); this.active = active; }
    return this.active;
  }
  private async persist(record: OperationRecord): Promise<void> { await this.records.save(record); if (this.active) this.track(this.active, record); }
  async begin(call: ToolCall, context: ToolContext): Promise<OperationStart> {
    return this.serial(async () => {
      if (context.signal.aborted) throw new Error('Task cancelled.');
      const id = idFor(call, context), scope = accessScope(context.project);
      const fingerprint = digest(canonical([scope, call.name, call.arguments]));
      const previous = await this.records.get(id);
      if (previous && previous.fingerprint !== fingerprint) throw new Error('An operation ID cannot be reused with different arguments or access rights.');
      if (previous && ['confirmed', 'failed'].includes(previous.status) && previous.result) return { operation: previous, cachedResult: structuredClone(previous.result) };
      const uncertain = [...(await this.pendingIndex()).values()].find(record => record.projectId === context.project.id && record.sessionId === context.sessionId
        && record.fingerprint === fingerprint);
      if (uncertain) throw new OperationPendingError({ id: uncertain.id, toolName: uncertain.toolName, toolCallId: uncertain.toolCallId, status: uncertain.status });
      const now = new Date().toISOString();
      const operation: OperationRecord = { id, projectId: context.project.id, sessionId: context.sessionId, runId: context.runId,
        toolCallId: call.id, toolName: call.name, fingerprint, scope, status: 'running', startedAt: now, updatedAt: now };
      await this.persist(operation);
      return { operation };
    });
  }
  async finish(id: string, result: ToolResult): Promise<OperationRecord> {
    return this.serial(async () => {
      const record = await this.records.get(id);
      if (!record || record.status !== 'running') throw new Error('Operation is not running.');
      const observedFailure = record.toolName === 'run_command' && Number.isInteger(result.commandExit?.code) && result.commandExit!.code > 0;
      record.status = result.error ? observedFailure ? 'failed' : 'uncertain' : 'confirmed'; record.result = structuredClone(result); record.updatedAt = new Date().toISOString();
      await this.persist(record); return record;
    });
  }
  async recover(): Promise<void> {
    await this.serial(async () => {
      const active = new Map<string, PendingOperation>();
      for (const record of await this.records.list()) {
        if (record.status === 'running') { record.status = 'uncertain'; record.updatedAt = new Date().toISOString(); await this.records.save(record); }
        this.track(active, record);
      }
      this.active = active;
    });
  }
  /** Deleting a project removes its receipts; sessions are only archived, so their receipts stay with the project. */
  async removeProject(projectId: string): Promise<number> {
    return this.serial(async () => {
      let removed = 0;
      for (const record of await this.records.list()) if (record.projectId === projectId) { await this.records.remove(record.id); this.active?.delete(record.id); removed++; }
      return removed;
    });
  }
  async recoveredResult(call: ToolCall, context: ToolContext): Promise<ToolResult | undefined> {
    const record = await this.recoveredOperation(call, context);
    return record && ['confirmed', 'failed'].includes(record.status) ? record.result : undefined;
  }
  async recoveredOperation(call: ToolCall, context: ToolContext): Promise<OperationRecord | undefined> {
    await this.queue;
    const record = await this.records.get(idFor(call, context));
    if (record?.scope === accessScope(context.project)
      && record.fingerprint === digest(canonical([record.scope, call.name, call.arguments]))) return record;
  }
  private async owned(id: string, context: ToolContext): Promise<OperationRecord> {
    const record = await this.records.get(id);
    if (!record || record.projectId !== context.project.id || record.sessionId !== context.sessionId || record.scope !== accessScope(context.project)) throw new Error('Operation is unavailable in the current chat or access scope.');
    return record;
  }
  async inspect(id: string, context: ToolContext): Promise<ToolResult> {
    await this.queue;
    const record = await this.owned(id, context);
    return { text: JSON.stringify({ operationId: record.id, toolName: record.toolName, status: record.status, startedAt: record.startedAt,
      updatedAt: record.updatedAt, result: record.result, evidenceMessageId: record.evidenceMessageId,
      note: 'Confirmed means a tool receipt was durably saved. It does not prove all task requirements. An uncertain effect must be inspected before a retry.' }) };
  }
  async states(ids: string[], context: ToolContext): Promise<Pick<OperationRecord, 'id' | 'toolName' | 'toolCallId' | 'status'>[]> {
    await this.queue;
    const records = [];
    for (const id of ids) { const record = await this.owned(id, context); records.push({ id: record.id, toolName: record.toolName, toolCallId: record.toolCallId, status: record.status }); }
    return records;
  }
  async reconcile(id: string, outcome: 'confirmed' | 'not-executed', evidenceCallId: string, context: ToolContext): Promise<ToolResult> {
    await this.queue;
    const record = await this.owned(id, context);
    if (record.status !== 'uncertain') throw new Error('Only an uncertain operation can be reconciled.');
    const history = await this.messages(context.sessionId);
    const evidence = history.find(message => message.role === 'tool' && message.toolCallId === evidenceCallId && !message.error
      && message.accessScope === record.scope && message.toolCallId !== record.toolCallId && Date.parse(message.createdAt) >= Date.parse(record.startedAt));
    if (!evidence || !evidence.toolName || nonEvidenceTools.has(evidence.toolName)) throw new Error('Supply a successful fresh observation of current state, not a summary or the interrupted action itself.');
    if (outcome === 'not-executed') {
      const approved = await this.approve({ id: 'reconcile_' + digest(id + evidence.id), projectId: context.project.id, sessionId: context.sessionId,
        kind: 'write', title: 'Разрешить повтор действия с неизвестным результатом',
        description: `Operation: ${id}\nTool: ${record.toolName}\nThe agent observed current state and claims the interrupted action had no effect. Approving permits a later retry; this confirmation performs no external action.\nObservation: ${evidence.toolName} (${evidence.id})` }, context.signal);
      if (!approved || context.signal.aborted) throw new Error('Retry authorization was declined. The operation remains uncertain.');
    }
    return this.serial(async () => {
      const current = await this.owned(id, context);
      if (current.status !== 'uncertain' || context.signal.aborted) throw new Error('Operation state changed or task was cancelled.');
      current.status = outcome; current.evidenceMessageId = evidence.id; current.updatedAt = new Date().toISOString();
      if (outcome === 'confirmed') current.result = { text: `Existing effect was observed by ${evidence.toolName} [${evidence.id}]. Inspect that observation for the result.` };
      await this.persist(current);
      return { text: JSON.stringify({ operationId: id, status: outcome, evidenceMessageId: evidence.id, actionRepeated: false }) };
    });
  }
}
