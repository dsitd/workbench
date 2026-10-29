import type { ModelRequest } from '../shared/agent';
import { AgentError, checkAbort } from './errors';
import { ModelBudgetError } from './provider-failure';

export type Fetcher = typeof fetch;
export type Json = Record<string, any>;

/** Failure metadata is numeric billing data only; error bodies never reach provider callbacks. */
function failureUsage(value: unknown): Json | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Json, result: Json = {};
  const numeric = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0;
  for (const field of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'cost', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
    if (numeric(source[field])) result[field] = source[field];
  for (const field of ['prompt_tokens_details', 'input_tokens_details']) {
    const details: Json = {};
    for (const name of ['cached_tokens', 'cache_write_tokens']) if (numeric(source[field]?.[name])) details[name] = source[field][name];
    if (Object.keys(details).length) result[field] = details;
  }
  return Object.keys(result).length ? result : undefined;
}

/** A cancelled or already committed request is never submitted again. */
export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Operation stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function retryDelay(value: string | null, attempt: number, now = Date.now()): number | undefined {
  if (value !== null) {
    const seconds = Number(value);
    const date = Date.parse(value);
    const delay = Number.isFinite(seconds) && value.trim() !== '' ? seconds * 1000 : date - now;
    // Do not retry earlier than the server requested, or hold a task indefinitely.
    if (Number.isFinite(delay) && delay >= 0) return delay <= 10_000 ? delay : undefined;
  }
  return Math.min(4000, 500 * 2 ** (attempt - 1));
}

export function endpoint(base: string, resource: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new AgentError('Некорректный URL API.'); }
  if (url.username || url.password || url.search || url.hash)
    throw new AgentError('URL API не должен содержать пароль, параметры или фрагмент.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    throw new AgentError('Для внешнего API требуется HTTPS; HTTP разрешён только на localhost.');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/' + resource) ? path : `${path}/${resource}`;
  return url.href;
}

export async function requestJson(
  request: ModelRequest, resource: string, body: Json, headers: Record<string, string>,
  onEvent: (event: Json) => void, fetcher: Fetcher = fetch, timeoutMs = 120_000,
): Promise<Json | undefined> {
  checkAbort(request.signal);
  const url = endpoint(request.model.baseUrl, resource);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 24 * 1024 * 1024)
    throw new AgentError('Запрос превышает 24 МБ. Выберите меньше изображений за один шаг.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const activity = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); };
  activity();
  try {
    let response: Response;
    for (let attempt = 0;; attempt++) {
      checkAbort(controller.signal);
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...headers }, body: serialized,
      });
      if (response.ok || attempt >= 2 || ![429, 502, 503, 504, 529].includes(response.status)) break;
      const delayMs = retryDelay(response.headers.get('retry-after'), attempt + 1);
      if (delayMs === undefined) break;
      await response.body?.cancel();
      await request.onRetry?.({ attempt: attempt + 1, status: response.status, delayMs });
      await waitForRetry(delayMs, controller.signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Servers sometimes echo Authorization/request headers in their error bodies.
      if (response.status === 402) throw new ModelBudgetError();
      const guidance = response.status === 429 ? 'API ограничил частоту запросов. Подождите и повторите позже.'
        : [502, 503, 504, 529].includes(response.status) ? 'API временно недоступен или перегружен. Повторите позже.'
        : response.status === 413 ? 'API отклонил размер запроса. Сократите контекст или число выбранных изображений.'
        : 'Проверьте модель, адрес и доступ.';
      throw new AgentError(`API вернул HTTP ${response.status}. ${guidance}`);
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.body) throw new AgentError('API вернул пустой поток.');
      await parseSse(response.body, onEvent, controller.signal, activity);
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AgentError('API вернул пустой ответ.');
    let data = '';
    const decoder = new TextDecoder();
    const abortRead = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', abortRead, { once: true });
    try {
      for (;;) {
        checkAbort(controller.signal);
        const { done, value } = await reader.read();
        checkAbort(controller.signal);
        if (done) break;
        activity();
        data += decoder.decode(value, { stream: true });
        if (data.length > 8 * 1024 * 1024) throw new AgentError('Ответ API слишком большой.');
      }
      data += decoder.decode();
      try { return JSON.parse(data) as Json; }
      catch { throw new AgentError('API вернул некорректный JSON.'); }
    } finally {
      controller.signal.removeEventListener('abort', abortRead);
      await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
  } catch (error) {
    if (request.signal.aborted) throw new DOMException('Operation stopped', 'AbortError');
    if (timedOut) throw new AgentError(`API не ответил: ${Math.ceil(timeoutMs / 1000)} секунд без новых данных. Повторите запрос.`);
    if (error instanceof AgentError) throw error;
    throw new AgentError('Не удалось связаться с API. Проверьте адрес и подключение.');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}

export async function parseSse(body: ReadableStream<Uint8Array>, onEvent: (event: Json) => void, signal: AbortSignal, onActivity?: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', consumed = 0;
  const abortRead = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abortRead, { once: true });
  function dispatch(frame: string) {
    const data = frame.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event: Json;
    try { event = JSON.parse(data); }
    catch { throw new AgentError('API вернул некорректное событие потока.'); }
    if (event.type === 'error' || event.error || event.type === 'response.failed') {
      const usage = failureUsage(event.usage), responseUsage = failureUsage(event.response?.usage);
      if (usage || responseUsage) onEvent({ type: event.type === 'response.failed' ? 'response.failed' : 'error',
        ...(usage ? { usage } : {}), ...(responseUsage ? { response: { usage: responseUsage } } : {}) });
      throw new AgentError('API прервал генерацию. Повторите запрос.');
    }
    onEvent(event);
  }
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      onActivity?.();
      consumed += value.length;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      if (consumed > 48 * 1024 * 1024 || buffer.length > 2 * 1024 * 1024)
        throw new AgentError('Поток API превысил допустимый размер.');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } finally {
    signal.removeEventListener('abort', abortRead);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

export function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(typeof value === 'string' ? value : '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Provider truncation must never execute partial arguments. */ }
  throw new AgentError('Модель вернула неполные аргументы инструмента. Повторите запрос.');
}
