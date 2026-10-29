import type { Project, RunRecord, ToolCall, ToolResult } from '../shared/types';
import { checkAbort } from './errors';

export interface HookContext { project: Project; sessionId: string; runId: string; signal: AbortSignal }
export interface RuntimeHooks {
  beforeTool?(context: HookContext & { call: ToolCall }): void | Promise<void>;
  afterTool?(context: HookContext & { call: ToolCall; result: ToolResult }): void | Promise<void>;
  finishTurn?(context: HookContext & { run: RunRecord }): void | { continueWith: string } | Promise<void | { continueWith: string }>;
  beforeComplete?(context: HookContext & { run: RunRecord }): void | Promise<void>;
}
/** Hooks receive detached observations; they cannot alter arguments, grants, or execution results. */
export async function invokeHooks<K extends keyof RuntimeHooks>(hooks: readonly RuntimeHooks[] | undefined, kind: K, input: Parameters<NonNullable<RuntimeHooks[K]>>[0]): Promise<void> {
  for (const hook of hooks ?? []) {
    checkAbort(input.signal);
    const { signal, ...data } = input;
    const callback = hook[kind] as ((context: typeof input) => void | Promise<void>) | undefined;
    if (callback) {
      let abort!: () => void;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DOMException('Runtime hook cancelled', 'AbortError'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        await Promise.race([cancelled, Promise.resolve().then(() => {
          checkAbort(signal); return callback({ ...structuredClone(data), signal } as typeof input);
        })]);
      } finally { signal.removeEventListener('abort', abort); }
    }
    checkAbort(input.signal);
  }
}

/** A finish hook may request another model turn, but cannot declare success or bypass gates. */
export async function finishTurnHooks(hooks: readonly RuntimeHooks[] | undefined, input: HookContext & { run: RunRecord }): Promise<string | undefined> {
  const reasons: string[] = [];
  for (const hook of hooks ?? []) {
    if (!hook.finishTurn) continue;
    await invokeHooks([{ beforeComplete: async context => {
      const result = await hook.finishTurn!(context);
      if (result !== undefined) {
        if (!result || typeof result.continueWith !== 'string' || !result.continueWith.trim() || result.continueWith.length > 8000)
          throw new Error('finishTurn must return a nonempty continueWith string up to 8000 characters, or nothing.');
        reasons.push(result.continueWith);
      }
    } }], 'beforeComplete', input);
  }
  const text = reasons.join('\n\n');
  if (text.length > 16000) throw new Error('Combined finish hooks exceed 16000 characters.');
  return text || undefined;
}
