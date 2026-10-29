import type { ModelMessage, ModelRequest } from '../shared/agent';
import type { ModelConfig } from '../shared/types';
import { anthropicBody, chatBody, responsesBody } from './mappings';

/** Conservative UTF-8 heuristic; not a provider tokenizer or a billing estimate. */
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
const signal = new AbortController().signal;

/** Use the actual protocol mapper so native items and display copies are never counted twice.
 * Count each message separately (conservative for Anthropic's merged turns). Image payloads
 * keep the existing fixed reserve instead of charging base64 bytes as text tokens.
 */
export function messageTokens(model: ModelConfig, message: ModelMessage): number {
  const request: ModelRequest = { model, system: '', tools: [], signal, messages: [{ ...message, images: undefined }] };
  const wire = model.kind === 'openai-responses' ? responsesBody(request).input
    : model.kind === 'anthropic' ? anthropicBody(request).messages
    : (chatBody(request).messages as unknown[]).slice(1);
  return estimateTokens(JSON.stringify(wire)) + 16 + (message.images?.length ?? 0) * 4096;
}
