import type { ModelRequest, ModelResponse } from '../shared/agent';
import type { ToolCall } from '../shared/types';
import { AgentError, safeError } from './errors';
import { ModelBudgetError, ModelGenerationFailure } from './provider-failure';
import { requestJson, parseArguments, type Fetcher, type Json } from './http';
import { anthropicBody, chatBody, responsesBody } from './mappings';
import { demoResponse } from './demo';
import { CredentialRedactor } from './redaction';
import { checkedReasoning, isOpenRouter, ReasoningAccumulator } from './reasoning';

interface PartialCall { id: string; name: string; arguments: string | Json }
export type ProviderResponse = ModelResponse & { providerItems?: Json[] };
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const tokenCount = (value: unknown): number | undefined => number(value) !== undefined && Number.isSafeInteger(value) && (value as number) <= 100_000_000 ? value as number : undefined;

/** Missing usage stays unknown; malformed counts never poison the run budget. */
function usageOf(source: Json | undefined, input: string, output: string, openRouter = false, nativeAnthropic = false): ModelResponse['usage'] {
  const inputTokens = tokenCount(source?.[input]), outputTokens = tokenCount(source?.[output]);
  const costUsd = openRouter ? number(source?.cost) : undefined;
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return;
  const details = source?.[input === 'prompt_tokens' ? 'prompt_tokens_details' : 'input_tokens_details'];
  let cacheReadTokens = tokenCount(nativeAnthropic ? source?.cache_read_input_tokens : details?.cached_tokens);
  let cacheWriteTokens = tokenCount(nativeAnthropic ? source?.cache_creation_input_tokens : details?.cache_write_tokens);
  // Native Anthropic input_tokens excludes read/write caching. OpenRouter Chat and Responses
  // already include those tokens, so their cache details must never increase the input total.
  const inclusiveInput = inputTokens !== undefined ? inputTokens + (nativeAnthropic ? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) : 0) : undefined;
  if (inclusiveInput === undefined || !nativeAnthropic && (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > inclusiveInput) {
    cacheReadTokens = undefined; cacheWriteTokens = undefined;
  }
  return { ...(inclusiveInput !== undefined ? { inputTokens: inclusiveInput } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens === undefined || cacheWriteTokens === undefined ? { cacheDetailsPartial: true } : {}) };
}

/** Usage frames are snapshots of one call, not additional charges or token deltas. */
function retainUsage(previous: ModelResponse['usage'], reported: ModelResponse['usage']): ModelResponse['usage'] {
  if (!reported) return previous;
  const merged = { ...previous, ...reported };
  if (!reported.cacheDetailsPartial) delete merged.cacheDetailsPartial;
  return merged;
}

function checkedItems(value: unknown, key?: string): Json[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128 || value.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new AgentError('API вернул некорректные блоки контекста.');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new AgentError('Блоки контекста API превышают 2 МБ.');
  const strings: string[] = [];
  const collect = (item: unknown) => {
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) item.forEach(collect);
    else if (item && typeof item === 'object') Object.values(item).forEach(collect);
  };
  collect(value);
  if (key && (serialized.includes(key) || strings.join('').includes(key)))
    throw new AgentError('API вернул credential в структурированном ответе. Ответ отклонён; проверьте адрес API.');
  return value;
}

export async function generate(request: ModelRequest, fetcher?: Fetcher): Promise<ProviderResponse> {
  if (request.model.kind === 'demo') return demoResponse(request);
  if (!request.apiKey && request.model.kind !== 'openai-compatible')
    throw new AgentError('Добавьте API-ключ в настройках выбранной модели.');
  const calls = new Map<number, PartialCall>();
  const nativeBlocks = new Map<number, Json>();
  let content = '', usage: ModelResponse['usage'], complete = false, finishReason: string | undefined;
  let providerItems: Json[] | undefined, reasoningDetails: ModelResponse['reasoningDetails'];
  const reasoning = new ReasoningAccumulator(request.apiKey);
  const redactor = new CredentialRedactor(request.apiKey, request.onDelta);
  const text = (delta: unknown) => {
    if (typeof delta !== 'string' || !delta) return;
    content += delta; redactor.delta(delta);
  };
  const addCall = (index: number, item: Partial<Json>) => {
    const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
    current.id = typeof item.id === 'string' ? item.id : current.id;
    current.name += typeof item.name === 'string' ? item.name : '';
    if (typeof item.arguments === 'string') current.arguments = typeof current.arguments === 'string' ? current.arguments + item.arguments : item.arguments;
    else if (item.arguments) current.arguments = item.arguments;
    calls.set(index, current);
  };
  let json: Json | undefined;
  try {
    if (request.model.kind === 'anthropic') {
      json = await requestJson(request, 'messages', anthropicBody(request), {
        'x-api-key': request.apiKey!, 'anthropic-version': '2023-06-01',
      }, event => {
        if (event.type === 'error') usage = retainUsage(usage, usageOf(event.usage, 'input_tokens', 'output_tokens', false, true));
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (!block || nativeBlocks.size >= 128 || nativeBlocks.has(event.index)) throw new AgentError('API вернул некорректные блоки потока.');
          nativeBlocks.set(event.index, { ...block });
          if (block.type === 'tool_use') addCall(event.index, { id: block.id, name: block.name, arguments: Object.keys(block.input ?? {}).length ? block.input : '' });
          if (block.type === 'text') text(block.text);
        }
        if (event.type === 'content_block_delta') {
          const block = nativeBlocks.get(event.index);
          if (!block) throw new AgentError('API вернул delta без блока.');
          const delta = event.delta;
          if (delta?.type === 'text_delta') { text(delta.text); block.text = (block.text ?? '') + delta.text; }
          if (delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
          if (delta?.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
          if (delta?.type === 'input_json_delta') addCall(event.index, { arguments: delta.partial_json });
        }
        if (event.type === 'message_start') usage = usageOf({ output_tokens: 0, ...event.message?.usage }, 'input_tokens', 'output_tokens', false, true);
        if (event.type === 'message_delta') {
          if (usage && event.usage?.output_tokens !== undefined) {
            const output = tokenCount(event.usage.output_tokens);
            if (output === undefined) usage = undefined; else usage.outputTokens = output;
          }
          if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        }
        if (event.type === 'message_stop') complete = true;
      }, fetcher);
      if (json) {
        usage = usageOf(json.usage, 'input_tokens', 'output_tokens', false, true);
        finishReason = json.stop_reason;
        providerItems = checkedItems(json.content ?? [], request.apiKey);
        for (const [index, block] of (providerItems ?? []).entries()) {
          if (block.type === 'text') text(block.text);
          if (block.type === 'tool_use') addCall(index, { id: block.id, name: block.name, arguments: block.input });
        }
      } else {
        for (const [index, block] of nativeBlocks) {
          if (block.type === 'tool_use' && !['max_tokens', 'pause_turn'].includes(finishReason ?? '')) block.input = parseArguments(calls.get(index)?.arguments || '{}');
        }
        providerItems = checkedItems([...nativeBlocks.values()], request.apiKey);
      }
    } else if (request.model.kind === 'openai-responses') {
      json = await requestJson(request, 'responses', responsesBody(request), auth(request), event => {
        if (event.type === 'response.output_text.delta') text(event.delta);
        if (event.type === 'response.failed' || event.type === 'error') {
          usage = retainUsage(usage, usageOf(event.response?.usage ?? event.usage, 'input_tokens', 'output_tokens', isOpenRouter(request.model.baseUrl)));
          return;
        }
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          json = event.response; complete = true;
          usage = retainUsage(usage, usageOf(json?.usage, 'input_tokens', 'output_tokens', isOpenRouter(request.model.baseUrl)));
        }
      }, fetcher) ?? json;
      if (json) {
        usage = retainUsage(usage, usageOf(json.usage, 'input_tokens', 'output_tokens', isOpenRouter(request.model.baseUrl)));
        finishReason = json.status === 'incomplete' ? json.incomplete_details?.reason ?? 'incomplete' : json.status;
        providerItems = checkedItems(json.output ?? [], request.apiKey);
        let fullText = '';
        for (const [index, item] of (providerItems ?? []).entries()) {
          if (item.type === 'function_call') addCall(index, { id: item.call_id, name: item.name, arguments: item.arguments });
          if (item.type === 'message') fullText += (item.content ?? []).filter((part: Json) => part.type === 'output_text').map((part: Json) => part.text).join('');
        }
        if (!content) text(fullText); else content = fullText || content;
        if (json.status === 'failed') throw new AgentError('API не завершил ответ. Повторите запрос.');
      }
    } else {
      json = await requestJson(request, 'chat/completions', chatBody(request), auth(request), event => {
        if (event.usage) usage = retainUsage(usage, usageOf(event.usage, 'prompt_tokens', 'completion_tokens', isOpenRouter(request.model.baseUrl)));
        for (const choice of event.choices ?? []) {
          if (choice.index && choice.index !== 0) continue;
          text(choice.delta?.content); reasoning.add(choice.delta?.reasoning_details);
          for (const call of choice.delta?.tool_calls ?? []) addCall(call.index, { id: call.id, name: call.function?.name, arguments: call.function?.arguments });
          if (choice.finish_reason) { finishReason = choice.finish_reason; complete = true; }
        }
      }, fetcher);
      if (json) {
        usage = usageOf(json.usage, 'prompt_tokens', 'completion_tokens', isOpenRouter(request.model.baseUrl));
        const choice = json.choices?.[0];
        if (!choice?.message) throw new AgentError('API вернул ответ без сообщения.');
        finishReason = choice.finish_reason;
        text(choice.message.content);
        reasoningDetails = checkedReasoning(choice.message.reasoning_details, request.apiKey);
        for (const [index, call] of (choice.message.tool_calls ?? []).entries()) addCall(index, { id: call.id, name: call.function?.name, arguments: call.function?.arguments });
      } else reasoningDetails = reasoning.finish();
    }
    if (!json && !complete) throw new AgentError('Поток API оборвался до завершения ответа.');
    const incomplete = ['length', 'max_tokens', 'max_output_tokens', 'incomplete', 'content_filter', 'pause_turn'].includes(finishReason ?? '');
    // A truncated JSON argument is never executable or replayed as a completed call.
    const toolCalls: ToolCall[] = incomplete && !request.preserveTruncatedCalls ? [] : [...calls.values()].map(call => {
      if (!call.id || !call.name) throw new AgentError('Модель вернула некорректный вызов инструмента.');
      let args: Record<string, unknown>;
      try { args = parseArguments(call.arguments || '{}'); }
      catch (error) {
        if (!incomplete && !request.recoverInvalidToolCalls) throw error;
        if (!incomplete) return { id: call.id, name: call.name, arguments: {}, argumentError: 'Invalid JSON tool arguments. No action in this batch was executed. Regenerate the intended calls with valid JSON objects; do not replay successful actions from earlier steps.' };
        args = {};
      }
      return { id: call.id, name: call.name, arguments: args };
    });
    if (toolCalls.length > 16) throw new AgentError('Модель запросила больше 16 инструментов за шаг. Разделите задачу на меньшие действия.');
    if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new AgentError('Модель вернула повторяющиеся идентификаторы инструментов.');
    const invalidBatch = toolCalls.some(call => call.argumentError);
    if (invalidBatch) for (const call of toolCalls) call.argumentError ??= 'Another call in this batch has invalid JSON arguments. This action was not executed. Regenerate the intended batch; earlier successful actions must not be repeated.';
    redactor.rejectEcho(toolCalls);
    return { content: redactor.text(content), toolCalls, usage, providerItems: incomplete || invalidBatch ? undefined : providerItems,
      reasoningDetails: incomplete ? undefined : reasoningDetails, finishReason, ...(incomplete ? { incomplete: true } : {}) };
  } catch (error) {
    if (error instanceof ModelBudgetError) throw error;
    throw new ModelGenerationFailure(safeError(error), usage);
  }
  finally { redactor.finish(); }
}

function auth(request: ModelRequest): Record<string, string> { return request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}; }
