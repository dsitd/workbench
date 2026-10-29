import type { ModelConfig } from './types';

export interface ModelPreset {
  id: string; label: string; provider: string; configuration: Omit<ModelConfig, 'id' | 'hasKey'>; sourceUrl: string;
}

// OpenRouter metadata verified 2026-10-29. Output is an application budget.
export const flashPreset: ModelPreset = {
  id: 'openrouter-deepseek-flash', label: 'DeepSeek V4.1 Flash 1017', provider: 'OpenRouter',
  configuration: {
    name: 'DeepSeek V4.1 Flash 1017', kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash-1017',
    apiKeyEnv: 'OPENROUTER_API_KEY', contextWindow: 1_048_576, maxOutputTokens: 16_384,
    vision: true, enabled: true, reasoningEffort: 'high',
    // Peak rates for conservative estimates; reported API cost takes precedence.
    inputPricePerMillion: 0.3, outputPricePerMillion: 1.2, cacheReadPricePerMillion: 0.006,
  },
  sourceUrl: 'https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017',
};

// Public provider metadata checked on 2026-10-07. Output is an application budget.
export const modelPresets: ModelPreset[] = [{
  id: 'openrouter-claude-sonnet-55', label: 'Claude Sonnet 5.5', provider: 'OpenRouter',
  configuration: {
    name: 'Claude Sonnet 5.5', kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5',
    apiKeyEnv: 'OPENROUTER_API_KEY', contextWindow: 1_000_000, maxOutputTokens: 8192,
    vision: true, enabled: true,
    inputPricePerMillion: 2, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.2,
  },
  sourceUrl: 'https://openrouter.ai/anthropic/claude-sonnet-5.5',
}, {
  id: 'openrouter-claude-opus-55', label: 'Claude Opus 5.5', provider: 'OpenRouter',
  configuration: {
    name: 'Claude Opus 5.5', kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5.5',
    apiKeyEnv: 'OPENROUTER_API_KEY', contextWindow: 1_000_000, maxOutputTokens: 8192,
    vision: true, enabled: true,
  },
  sourceUrl: 'https://openrouter.ai/anthropic/claude-opus-5.5',
}, {
  id: 'openrouter-gpt-6-luna', label: 'GPT-6 Luna', provider: 'OpenRouter',
  configuration: {
    name: 'GPT-6 Luna', kind: 'openai-responses',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna',
    apiKeyEnv: 'OPENROUTER_API_KEY', contextWindow: 1_050_000, maxOutputTokens: 16_384,
    vision: true, enabled: true, reasoningEffort: 'medium',
    inputPricePerMillion: 0.1, outputPricePerMillion: 0.5, cacheReadPricePerMillion: 0.01, cacheWritePricePerMillion: 0.125,
  },
  sourceUrl: 'https://openrouter.ai/openai/gpt-6-luna',
}, {
  // OpenRouter metadata checked on 2026-10-10; output is an application budget.
  id: 'openrouter-gpt-61-sol', label: 'GPT-6.1 Sol', provider: 'OpenRouter',
  configuration: {
    name: 'GPT-6.1 Sol', kind: 'openai-responses',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6.1-sol',
    apiKeyEnv: 'OPENROUTER_API_KEY', contextWindow: 1_050_000, maxOutputTokens: 16_384,
    vision: true, enabled: true, reasoningEffort: 'medium',
    inputPricePerMillion: 2, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.1, cacheWritePricePerMillion: 2.5,
  },
  sourceUrl: 'https://openrouter.ai/openai/gpt-6.1-sol',
}, flashPreset];
