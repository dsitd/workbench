import type { ModelRequest } from '../shared/agent';
import { isReasoningEffort } from '../shared/runs';
import { AgentError } from './errors';
import { isOpenRouter } from './reasoning';

export function requestEffort(request: ModelRequest) {
  const effort = request.reasoningEffort ?? request.model.reasoningEffort ?? 'auto';
  if (!isReasoningEffort(effort)) throw new AgentError('Неизвестный уровень reasoning. Выберите Auto, Low, Medium или High.');
  return effort === 'auto' ? undefined : effort;
}

export function chatReasoning(request: ModelRequest): Record<string, unknown> {
  const effort = requestEffort(request);
  if (isOpenRouter(request.model.baseUrl)) {
    if (request.reasoningEnabled === false && /^anthropic\/claude-(?:sonnet|opus)-5\.5$/.test(request.model.model))
      throw new AgentError('У Claude 5.5 reasoning обязателен. Используйте Low, Medium или High.');
    // Flash accepts low/high/max; map the application's Medium choice to High.
    const mappedEffort = request.model.model === 'deepseek/deepseek-v4.1-flash-1017' && effort === 'medium' ? 'high' : effort;
    const reasoning = { ...(mappedEffort ? { effort: mappedEffort } : {}), ...(request.reasoningEnabled !== undefined ? { enabled: request.reasoningEnabled } : {}) };
    return Object.keys(reasoning).length ? { reasoning } : {};
  }
  return effort ? { reasoning_effort: effort } : {};
}

export function anthropicReasoning(request: ModelRequest): Record<string, unknown> {
  const effort = requestEffort(request);
  if (!effort) return {};
  const model = request.model.model;
  const adaptive = /^claude-(?:(?:sonnet|opus)-4-6|opus-4-[78]|(?:sonnet|opus)-5(?:-5)?|(?:fable|mythos)-5(?:-1)?)(?:-|$)/.test(model);
  if (adaptive) return { thinking: { type: 'adaptive' }, output_config: { effort } };
  if (/^claude-opus-4-5(?:-|$)/.test(model)) {
    if (request.model.maxOutputTokens <= 1024) throw new AgentError('Reasoning этой модели требует maxOutputTokens больше 1024.');
    const ratio = effort === 'low' ? 0.2 : effort === 'medium' ? 0.5 : 0.8;
    return { thinking: { type: 'enabled', budget_tokens: Math.min(request.model.maxOutputTokens - 1, Math.max(1024, Math.floor(request.model.maxOutputTokens * ratio))) }, output_config: { effort } };
  }
  throw new AgentError('Эта модель Anthropic не поддерживает уровни effort. Выберите Auto или современную модель с adaptive thinking.');
}
