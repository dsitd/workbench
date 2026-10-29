import type { ModelConfig } from '../shared/types';
import { isOpenRouterCredentialProfile } from '../shared/model-credentials';

/** A title uses the selected helper's protocol, with credentials scoped to the validated router. */
export function titleModel(source: ModelConfig, identifier: string, profiles: ModelConfig[]): ModelConfig {
  if (!isOpenRouterCredentialProfile(source)) throw new Error('Название чата требует официального профиля OpenRouter.');
  const configured = profiles.find(model => model.enabled && model.model === identifier && isOpenRouterCredentialProfile(model));
  const responses = configured?.kind === 'openai-responses' || identifier === 'openai/gpt-6-luna';
  return { ...source, kind: responses ? 'openai-responses' : 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: identifier,
    contextWindow: 32_000, maxOutputTokens: 128, reasoningEffort: 'auto',
    inputPricePerMillion: undefined, outputPricePerMillion: undefined, cacheReadPricePerMillion: undefined, cacheWritePricePerMillion: undefined };
}
