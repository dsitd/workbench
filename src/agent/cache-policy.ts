import type { ModelRequest } from '../shared/agent';
import type { ModelConfig } from '../shared/types';
import type { Json } from './http';
import { AgentError } from './errors';

type Protocol = 'chat' | 'responses' | 'anthropic';
export interface PromptCacheCapability {
  strategy: 'anthropic-explicit' | 'openai-explicit' | 'implicit' | 'unsupported';
  canDisable: boolean;
  /** Claude Responses block conversion supports 5m only; Chat/native also accept 1h. */
  ttl?: 'claude' | '5m' | '30m';
}

function official(model: ModelConfig, origin: string, base: string, suffix: string): boolean {
  try {
    const url = new URL(model.baseUrl);
    const path = url.pathname.replace(/\/$/, '');
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash
      && (path === base || path === `${base}/${suffix}`);
  } catch { return false; }
}

function protocol(model: ModelConfig): Protocol | undefined {
  return model.kind === 'anthropic' ? 'anthropic' : model.kind === 'openai-responses' ? 'responses'
    : model.kind === 'openai-compatible' ? 'chat' : undefined;
}

function openRouter(model: ModelConfig): boolean {
  const kind = protocol(model);
  return kind !== undefined && kind !== 'anthropic'
    && official(model, 'https://openrouter.ai', '/api/v1', kind === 'chat' ? 'chat/completions' : 'responses');
}

function openAI(model: ModelConfig): boolean {
  const kind = protocol(model);
  return kind !== undefined && kind !== 'anthropic'
    && official(model, 'https://api.openai.com', '/v1', kind === 'chat' ? 'chat/completions' : 'responses');
}

function modernOpenAI(model: ModelConfig): boolean {
  const name = openRouter(model) && model.model.startsWith('openai/') ? model.model.slice(7) : openAI(model) ? model.model : '';
  const version = name.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  return Boolean(version && (Number(version[1]) > 5 || Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6));
}

/** Request capability, never a claim that an actual cache hit occurred. Browser-safe for settings UI. */
export function promptCacheCapability(model: ModelConfig): PromptCacheCapability {
  const kind = protocol(model);
  if (kind === 'anthropic' && /^claude-/.test(model.model) && official(model, 'https://api.anthropic.com', '/v1', 'messages'))
    return { strategy: 'anthropic-explicit', canDisable: true, ttl: 'claude' };
  if (openRouter(model) && /^anthropic\/claude-/.test(model.model))
    return { strategy: 'anthropic-explicit', canDisable: true, ttl: kind === 'responses' ? '5m' : 'claude' };
  if (modernOpenAI(model)) return { strategy: 'openai-explicit', canDisable: true, ttl: '30m' };
  if (openRouter(model) || openAI(model)) return { strategy: 'implicit', canDisable: false };
  return { strategy: 'unsupported', canDisable: false };
}

/** TTL only changes fallback pricing; a reported API cost remains authoritative. */
export function cacheBillingModel(model: ModelConfig, policy: ModelRequest['cachePolicy']): ModelConfig {
  if (!policy?.enabled || policy.ttl !== '1h' || promptCacheCapability(model).ttl !== 'claude') return model;
  const input = model.inputPricePerMillion, write = model.cacheWritePricePerMillion;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  // The configured cache-write price describes the ordinary 5-minute rate. Only
  // derive the documented 1-hour rate when that tariff is actually established.
  const standard = valid(input) && valid(write) && Math.abs(write - 1.25 * input) <= 1e-9 * Math.max(1, write);
  return { ...model, cacheWritePricePerMillion: standard ? 2 * input : undefined };
}

/** Worst-case input rate for a budget reservation, never a billed cost estimate. */
export function cacheReservationModel(model: ModelConfig, policy: ModelRequest['cachePolicy']): ModelConfig {
  const input = model.inputPricePerMillion;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return model;
  const capability = promptCacheCapability(model);
  const claude = capability.ttl === 'claude' || capability.ttl === '5m';
  const enabled = claude ? policy?.enabled === true
    : capability.strategy === 'openai-explicit' ? policy?.enabled !== false
    : !capability.canDisable;
  if (!enabled) return model;
  const multiplier = claude ? policy?.ttl === '1h' && capability.ttl === 'claude' ? 2 : 1.25
    : capability.strategy === 'openai-explicit' ? 1.25 : 1;
  const configured = model.cacheWritePricePerMillion;
  const inputPricePerMillion = Math.max(input, input * multiplier,
    typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? configured : 0);
  return inputPricePerMillion === input ? model : { ...model, inputPricePerMillion };
}

function session(request: ModelRequest): string | undefined {
  if (request.sessionId === undefined) return;
  if (typeof request.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(request.sessionId))
    throw new AgentError('Некорректный идентификатор сессии кеша.');
  return request.sessionId;
}

function markText(message: Json, type: string, marker: string, value: Json): boolean {
  if (typeof message.content === 'string') {
    if (!message.content.trim()) return false;
    message.content = [{ type, text: message.content, [marker]: { ...value } }];
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (block?.type !== type || typeof block.text !== 'string' || !block.text.trim()) continue;
    message.content[i] = { ...block, [marker]: { ...value } };
    return true;
  }
  return false;
}

function lastChatMessage(messages: Json[], marker: string, value: Json, candidates?: ReadonlySet<Json>): void {
  for (let i = messages.length - 1; i >= 0; i--)
    if ((!candidates || candidates.has(messages[i])) && ['user', 'tool'].includes(messages[i].role)
      && markText(messages[i], 'text', marker, value)) return;
}

function nativeMarkerCount(body: Json): number {
  const blocks = [...(Array.isArray(body.system) ? body.system : []), ...(body.tools ?? []),
    ...(body.messages ?? []).flatMap((message: Json) => message.content ?? [])];
  return blocks.filter(block => block && Object.hasOwn(block, 'cache_control')).length;
}

function nativeAnthropic(body: Json, value: Json, candidates?: ReadonlySet<Json>): void {
  let count = nativeMarkerCount(body);
  if (count > 4) throw new AgentError('Контекст содержит больше четырёх точек кеширования Claude.');
  if (typeof body.system === 'string' && body.system.trim() && count < 4) {
    body.system = [{ type: 'text', text: body.system, cache_control: { ...value } }]; count++;
  }
  if (count >= 4) return;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message.role !== 'user') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (candidates && !candidates.has(block)) continue;
      if (!['text', 'image', 'tool_result'].includes(block.type) || block.type === 'text' && !block.text?.trim()) continue;
      if (!block.cache_control) message.content[j] = { ...block, cache_control: { ...value } };
      return;
    }
  }
}

function explicitResponses(request: ModelRequest, body: Json, candidates?: ReadonlySet<Json>, preserveBoundaries = false): void {
  // Top-level instructions cannot contain a breakpoint. A developer input preserves
  // their priority and exposes the unchanged prefix as a supported input_text block.
  if (request.system.trim()) {
    body.input.unshift({ role: 'developer', content: [{ type: 'input_text', text: request.system,
      prompt_cache_breakpoint: { mode: 'explicit' } }] });
    delete body.instructions;
  }
  for (let i = body.input.length - 1; i >= 0; i--) {
    const item = body.input[i];
    if (candidates && !candidates.has(item)) continue;
    if (item.role === 'user' && markText(item, 'input_text', 'prompt_cache_breakpoint', { mode: 'explicit' })) {
      if (!preserveBoundaries) return;
      continue;
    }
    if (item.type === 'function_call_output' && typeof item.output === 'string' && item.output.trim()) {
      body.input[i] = { ...item, output: [{ type: 'input_text', text: item.output, prompt_cache_breakpoint: { mode: 'explicit' } }] };
      if (!preserveBoundaries) return;
    }
  }
}

/** Apply only documented controls to the mapped payload; signed reasoning stays untouched. */
export function applyCachePolicy(request: ModelRequest, body: Json, kind: Protocol, candidates?: ReadonlySet<Json>): Json {
  const capability = promptCacheCapability(request.model), policy = request.cachePolicy;
  if (capability.strategy === 'unsupported' || policy === undefined) return body;
  if (typeof policy.enabled !== 'boolean' || policy.ttl !== undefined && !['5m', '1h'].includes(policy.ttl))
    throw new AgentError('Некорректная настройка кеширования запроса.');
  if (!policy.enabled) {
    if (capability.strategy === 'openai-explicit') body.prompt_cache_options = { mode: 'explicit' };
    return body;
  }
  if (capability.ttl === '5m' && policy.ttl === '1h')
    throw new AgentError('Claude через Responses поддерживает стабильные точки кеша только на 5 минут. Для кеша на 1 час выберите Chat Completions или Anthropic Messages.');
  const id = session(request);
  if (id && openRouter(request.model)) body.session_id = id;
  else if (id && openAI(request.model)) body.prompt_cache_key = id;
  const control = { type: 'ephemeral', ...(policy.ttl === '1h' ? { ttl: '1h' } : {}) };
  if (capability.strategy === 'anthropic-explicit') {
    if (kind === 'anthropic') nativeAnthropic(body, control, candidates);
    // OpenRouter converts these supported Responses markers to default 5m
    // Claude cache_control. Automatic caching would include the volatile tail.
    else if (kind === 'responses') explicitResponses(request, body, candidates);
    else { markText(body.messages[0], 'text', 'cache_control', control); lastChatMessage(body.messages, 'cache_control', control, candidates); }
  } else if (capability.strategy === 'openai-explicit') {
    // OpenRouter's Responses/Chat contract only accepts explicit mode. The
    // upstream OpenAI API also accepts implicit mode, so retain it there.
    body.prompt_cache_options = { mode: openRouter(request.model) ? 'explicit' : 'implicit', ttl: '30m' };
    // Modern OpenAI explicit lookup needs the old boundary to remain present.
    // Moving a single marker to the new tail makes an unchanged conversation
    // miss its earlier cache write. Claude has a different four-marker limit.
    if (kind === 'responses') explicitResponses(request, body, candidates, true);
    else {
      markText(body.messages[0], 'text', 'prompt_cache_breakpoint', { mode: 'explicit' });
      for (const message of body.messages)
        if ((!candidates || candidates.has(message)) && ['user', 'tool'].includes(message.role))
          markText(message, 'text', 'prompt_cache_breakpoint', { mode: 'explicit' });
    }
  }
  return body;
}
