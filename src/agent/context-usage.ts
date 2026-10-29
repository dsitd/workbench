import type { ModelMessage } from '../shared/agent';
import type { ContextUsageBaseline } from '../shared/context';
import type { ModelConfig, ToolDefinition } from '../shared/types';
import { contextHash } from './context-selection';
import { messageTokens } from './context-cost';
import { providerId } from './reasoning';

export interface ContextUsageInput {
  model: ModelConfig; system: string; tools: ToolDefinition[]; messages: ModelMessage[];
  /** Effective effort/cache options: changing request policy invalidates a prior measurement. */
  requestPolicy?: string;
}
const policyHash = (input: ContextUsageInput) => contextHash([input.system, input.tools, input.requestPolicy, input.model.reasoningEffort]);

export function captureContextUsage(input: ContextUsageInput, inputTokens: number | undefined): ContextUsageBaseline | undefined {
  if (!Number.isSafeInteger(inputTokens) || inputTokens! <= 0) return;
  const volatile = input.messages.findIndex(message => message.contextData);
  const stable = input.messages.slice(0, volatile < 0 ? undefined : volatile);
  if (!stable.length) return;
  return { version: 1, providerId: providerId(input.model), policyHash: policyHash(input), prefixHashes: stable.map(contextHash), inputTokens: inputTokens! };
}

/** Reuse reported usage only when the entire measured history is still an exact prefix.
 * The prior volatile tail remains charged in the baseline; count the new tail again
 * rather than subtracting a heuristic from a measured quantity (which could undercount).
 * Edits, compaction, model/policy changes fall back to the protocol-aware heuristic.
 */
export function measuredContextTokens(input: ContextUsageInput, baseline?: ContextUsageBaseline): number | undefined {
  if (!baseline || baseline.version !== 1 || !Number.isSafeInteger(baseline.inputTokens) || baseline.inputTokens <= 0
    || !baseline.prefixHashes.length || baseline.providerId !== providerId(input.model) || baseline.policyHash !== policyHash(input)
    || baseline.prefixHashes.length > input.messages.length
    || baseline.prefixHashes.some((hash, index) => input.messages[index].contextData || contextHash(input.messages[index]) !== hash)) return;
  const growth = input.messages.slice(baseline.prefixHashes.length).reduce((sum, message) => sum + messageTokens(input.model, message), 0);
  return baseline.inputTokens + growth + Math.max(512, Math.ceil(baseline.inputTokens * 0.05));
}
