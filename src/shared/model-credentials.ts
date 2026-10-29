import type { ModelConfig } from './types';

/** Only the official OpenRouter API may share a model credential across profiles. */
export function isOpenRouterCredentialProfile(model: ModelConfig): boolean {
  if (!['openai-compatible', 'openai-responses'].includes(model.kind)) return false;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === 'https://openrouter.ai' && /^\/api\/v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash && !url.port;
  } catch { return false; }
}

/** Validate metadata before any key is decrypted; references are one hop only. */
export function modelCredentialSource(model: ModelConfig, models: readonly ModelConfig[]): ModelConfig {
  const reference = model.credentialModelId;
  if (reference === undefined) return model;
  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(reference)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(model.id) || reference === model.id)
    throw new Error('Некорректная ссылка на профиль ключа модели.');
  const source = models.find(item => item.id === reference);
  if (!source) throw new Error('Профиль ключа модели не найден. Выберите существующий профиль OpenRouter.');
  if (source.credentialModelId !== undefined)
    throw new Error('Ссылки на ключ модели допускают только один уровень.');
  if (!isOpenRouterCredentialProfile(model) || !isOpenRouterCredentialProfile(source))
    throw new Error('Общий ключ доступен только профилям официального API OpenRouter.');
  return source;
}
