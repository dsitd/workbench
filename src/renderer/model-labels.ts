import type { ModelConfig } from '../shared/types';

/** Keep existing profile names intact while omitting provider suffixes in model labels. */
export function modelLabel(name: string): string {
  return name.replace(/\s*[·•]\s*OpenRouter\s*$/i, '').replace(/\s*\(без API\)\s*$/i, '').trim();
}

export function chatModelOptions(models: ModelConfig[], selectedId: string) {
  const enabled = models.filter(model => model.enabled);
  const hasRealModels = enabled.some(model => model.kind !== 'demo');
  return enabled.filter(model => model.kind !== 'demo' || model.id === selectedId || !hasRealModels)
    .map(model => ({ value: model.id, label: modelLabel(model.name) }));
}
