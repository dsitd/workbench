export class AgentError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentError'; }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Operation stopped', 'AbortError');
}

/** Runtime boundaries never forward arbitrary transport/server errors. */
export function safeError(error: unknown): string {
  if (error instanceof AgentError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'Работа остановлена.';
  return 'Операция завершилась ошибкой. Проверьте настройки и повторите задачу.';
}
