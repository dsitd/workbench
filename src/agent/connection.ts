import { randomUUID } from 'node:crypto';
import type { ModelConnectionReport, ModelConfig, ToolDefinition } from '../shared/types';
import type { ModelMessage } from '../shared/agent';
import { generate } from './providers';
import { providerId } from './context';
import { checkAbort, safeError } from './errors';
import type { Fetcher } from './http';

const probeTool: ToolDefinition = {
  name: 'workbench_echo', permission: 'read',
  description: 'Connection test only. Return the supplied value unchanged. No files, commands or network actions are executed.',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
};

/** Two bounded API requests validate the same tool-call/result path as the harness. */
export async function testModelConnection(model: ModelConfig, apiKey?: string, fetcher?: Fetcher, signal?: AbortSignal): Promise<ModelConnectionReport> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  let toolCalling = false;
  let costUsd: number | undefined;
  const result = (ok: boolean, message: string): ModelConnectionReport => ({
    modelId: model.id, ok, toolCalling, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, message,
    ...(ok && costUsd !== undefined ? { costUsd } : {}),
  });
  try {
    checkAbort(controller.signal);
    if (model.kind === 'demo') return result(false, 'Для проверки API выберите подключённую модель.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(model.baseUrl).hostname);
    if (!apiKey && !local) return result(false, 'Введите API-ключ в настройках модели и сохраните его перед проверкой.');
    const reasoningProbe = new URL(model.baseUrl).origin === 'https://openrouter.ai'
      && model.kind === 'openai-compatible' && ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'].includes(model.model);
    const nativeReasoning = model.kind === 'anthropic' && (/^claude-(?:sonnet|opus)-5(?:-5)?(?:-|$)/.test(model.model) || (model.reasoningEffort !== undefined && model.reasoningEffort !== 'auto'));
    if ((reasoningProbe || nativeReasoning) && model.maxOutputTokens < 2048)
      return result(false, 'Для проверки Claude 5.5 через OpenRouter установите лимит ответа не менее 2048 токенов: он включает reasoning.');
    const value = `workbench-${randomUUID()}`;
    const configuration = { ...model, maxOutputTokens: Math.min(model.maxOutputTokens, reasoningProbe || nativeReasoning ? 2048 : 512) };
    const system = 'You are performing a minimal API connection check. Call the requested tool exactly once. After receiving its result, reply WORKBENCH_READY only. Do not use reasoning prose.';
    const messages: ModelMessage[] = [{ role: 'user', content: `Call workbench_echo once with value ${value}. Do not answer without calling this tool.` }];
    const request = { model: configuration, system, messages, tools: [probeTool], signal: controller.signal, apiKey,
      ...(reasoningProbe || nativeReasoning ? { reasoningEffort: 'low' as const } : {}),
      ...(reasoningProbe && model.model === 'anthropic/claude-sonnet-5.5' ? { providerPriceLimit: { prompt: 2, completion: 10 } } : {}),
    };
    const first = await generate(request, fetcher);
    if (first.incomplete) return result(false, 'Проверочный ответ обрезан лимитом вывода модели. Увеличьте maxOutputTokens; reasoning также входит в этот лимит.');
    if (first.toolCalls.length !== 1 || first.toolCalls[0].name !== probeTool.name || first.toolCalls[0].arguments.value !== value)
      return result(false, 'API отвечает, но проверочный вызов инструмента не выполнен. Проверьте поддержку tool calling выбранной моделью.');
    toolCalling = true;
    messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls, providerItems: first.providerItems,
      reasoningDetails: first.reasoningDetails, providerId: providerId(model) });
    messages.push({ role: 'tool', content: JSON.stringify({ value }), toolCallId: first.toolCalls[0].id, toolName: probeTool.name });
    const second = await generate({ ...request, tools: [] }, fetcher);
    if (second.incomplete) return result(false, 'Проверка получила инструмент, но итоговый ответ обрезан лимитом вывода модели. Увеличьте maxOutputTokens.');
    if (second.toolCalls.length || second.content.trim() !== 'WORKBENCH_READY')
      return result(false, 'Вызов инструмента получен, но модель не завершила проверку после его результата.');
    if (first.usage?.costUsd !== undefined && second.usage?.costUsd !== undefined) costUsd = first.usage.costUsd + second.usage.costUsd;
    return result(true, 'Подключение работает: модель вызвала инструмент, получила результат и завершила ответ.');
  } catch (error) {
    return result(false, timedOut ? 'Проверка API превысила 60 секунд.' : controller.signal.aborted ? 'Проверка API остановлена.' : safeError(error));
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
