import type { AppSettings, ProjectInput } from '../shared/types';
import { checkedRunLimits, defaultAppSettings } from '../shared/runs';
import { checkedPins } from './project-context';

export function projectFeatures(input: ProjectInput) {
  const command = input.verificationCommand ?? '';
  if (typeof command !== 'string' || command.length > 8000) throw new Error('Команда проверки должна содержать не более 8000 символов.');
  const memory = input.memory ?? '';
  if (typeof memory !== 'string' || memory.length > 32_000) throw new Error('Память проекта должна содержать не более 32000 символов.');
  return { verificationCommand: command.trim(), verifyAfterRun: input.verifyAfterRun !== false,
    runLimits: checkedRunLimits(input.runLimits ?? {}), memory, pins: checkedPins(input.pins ?? []) };
}
export function appSettings(input?: AppSettings): AppSettings {
  if (!input) return structuredClone(defaultAppSettings);
  if (input.runtimeEngine !== undefined && !['pi', 'legacy'].includes(input.runtimeEngine)) throw new Error('Invalid runtime engine.');
  if (input.toolExecution !== undefined && !['parallel', 'sequential'].includes(input.toolExecution)) throw new Error('Invalid tool execution mode.');
  if (input.completionPolicy !== undefined && !['verified', 'natural'].includes(input.completionPolicy)) throw new Error('Invalid completion policy.');
  if (input.modelCompaction !== undefined && typeof input.modelCompaction !== 'boolean') throw new Error('Invalid model compaction setting.');
  if (input.behaviorVerification !== undefined && typeof input.behaviorVerification !== 'boolean') throw new Error('Некорректный режим проверки поведения.');
  if (input.searchVerification !== undefined && typeof input.searchVerification !== 'boolean') throw new Error('Некорректный режим поиска контрпримеров.');
  if (input.contextPolicy !== undefined && !['model-window', 'custom'].includes(input.contextPolicy)) throw new Error('Некорректный режим контекста.');
  if (input.adaptiveContext !== undefined && typeof input.adaptiveContext !== 'boolean') throw new Error('Некорректный режим адаптивного контекста.');
  if (input.promptCache !== undefined && (!input.promptCache || typeof input.promptCache.enabled !== 'boolean' || !['5m', '1h'].includes(input.promptCache.ttl))) throw new Error('Некорректные настройки кэширования.');
  if (input.contextBudgetTokens !== undefined && (!Number.isInteger(input.contextBudgetTokens) || input.contextBudgetTokens < 4000 || input.contextBudgetTokens > 1_000_000)) throw new Error('Целевой контекст должен быть от 4000 до 1000000 токенов.');
  if (!input.autoTitle || typeof input.autoTitle.enabled !== 'boolean' || typeof input.autoTitle.model !== 'string'
    || !input.autoTitle.model.trim() || input.autoTitle.model.length > 250) throw new Error('Некорректные настройки названий чатов.');
  if (input.autoTitle.credentialModelId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.autoTitle.credentialModelId)) throw new Error('Некорректный профиль модели для названий.');
  return { autoTitle: { enabled: input.autoTitle.enabled, model: input.autoTitle.model.trim(), ...(input.autoTitle.credentialModelId !== undefined ? { credentialModelId: input.autoTitle.credentialModelId } : {}) },
    // Normalize saved settings to the supported application runtime.
    runtimeEngine: 'legacy',
    contextBudgetTokens: input.contextBudgetTokens ?? defaultAppSettings.contextBudgetTokens,
    contextPolicy: input.contextPolicy ?? 'model-window',
    adaptiveContext: false,
    toolExecution: input.toolExecution ?? 'parallel', completionPolicy: input.completionPolicy ?? 'verified', modelCompaction: input.modelCompaction ?? true,
    behaviorVerification: input.behaviorVerification ?? false,
    searchVerification: input.searchVerification ?? false,
    promptCache: input.promptCache ? { enabled: input.promptCache.enabled, ttl: input.promptCache.ttl } : structuredClone(defaultAppSettings.promptCache),
    runLimits: { ...defaultAppSettings.runLimits, ...checkedRunLimits(input.runLimits ?? {}) } };
}
