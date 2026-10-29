import type { AgentDependencies } from '../shared/agent';
import { AgentError } from './errors';
import { AgentRuntime as WorkbenchRuntime, type RuntimeOptions as EngineOptions } from './runtime';

export interface RuntimeOptions extends EngineOptions { engine?: 'legacy' }
interface RunInput { sessionId: string; text: string; attachmentIds: string[]; parentRunId?: string }
interface ActiveRun { promise: Promise<void>; stopped: boolean; runtime?: WorkbenchRuntime }

/** Owns per-session exclusivity and validates compatibility before dispatch. */
export class AgentRuntime {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly deps: AgentDependencies, private readonly options: RuntimeOptions = {}) {}
  run(input: RunInput): Promise<void> {
    if (!input.text.trim() && !input.attachmentIds.length) return Promise.reject(new AgentError('Введите задачу или прикрепите изображение.'));
    return this.start(input);
  }
  resume(sessionId: string, runId: string): Promise<void> {
    return this.start({ sessionId, text: '', attachmentIds: [], parentRunId: runId });
  }
  private async start(input: RunInput): Promise<void> {
    if (this.active.has(input.sessionId)) throw new AgentError('В этом чате уже выполняется задача. Остановите её или дождитесь результата.');
    const active: ActiveRun = { stopped: false, promise: Promise.resolve() };
    this.active.set(input.sessionId, active);
    active.promise = Promise.resolve().then(async () => {
      const parentEngine = input.parentRunId ? (await this.deps.getRun?.(input.parentRunId))?.engine ?? 'legacy' : undefined;
      if (parentEngine && parentEngine !== 'legacy')
        throw new AgentError('Этот запуск использовал несовместимый движок. Отправьте новую задачу; журнал предыдущего запуска сохранён.');
      if (active.stopped) return;
      active.runtime = new WorkbenchRuntime(this.deps, this.options);
      await (input.parentRunId ? active.runtime.resume(input.sessionId, input.parentRunId) : active.runtime.run(input));
    });
    try { await active.promise; } finally { if (this.active.get(input.sessionId) === active) this.active.delete(input.sessionId); }
  }
  async enqueue(_sessionId: string, _text: string, _attachmentIds: string[], kind: 'steering' | 'follow-up'): Promise<void> {
    if (kind !== 'steering' && kind !== 'follow-up') throw new AgentError('Неизвестный тип сообщения.');
    throw new AgentError('Отправьте сообщение после завершения текущей задачи.');
  }
  async stop(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId); if (!active) return;
    active.stopped = true;
    if (active.runtime) await active.runtime.stop(sessionId);
    await active.promise.catch(() => undefined);
  }
}
