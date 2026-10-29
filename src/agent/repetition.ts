import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../shared/types';

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const repetitionText = 'Повторяющееся действие остановлено: одинаковые аргументы уже трижды дали тот же результат. Используйте новые данные или другой подход; не повторяйте выполненные изменения и отклонённые действия.';

/** Bounded fingerprints contain no stored arguments or tool output. Changed observations reset the count. */
export class RepetitionGuard {
  private observations = new Map<string, { output: string; count: number }>();
  private denied = 0;
  blocked(call: ToolCall): boolean {
    const repeated = (this.observations.get(this.key(call))?.count ?? 0) >= 3;
    if (repeated) this.denied++;
    else this.denied = 0;
    return repeated;
  }
  get exhausted(): boolean { return this.denied >= 2; }
  observe(call: ToolCall, result: ToolResult, permission?: string): void {
    const key = this.key(call), output = digest({ text: result.text, error: Boolean(result.error), attachments: result.attachmentIds });
    const previous = this.observations.get(key);
    if (permission === 'write' && !result.error) this.observations.clear();
    this.observations.delete(key);
    this.observations.set(key, { output, count: previous?.output === output ? previous.count + 1 : 1 });
    if (this.observations.size > 64) this.observations.delete(this.observations.keys().next().value!);
  }
  private key(call: ToolCall): string { return digest({ name: call.name, arguments: stable(call.arguments) }); }
}
