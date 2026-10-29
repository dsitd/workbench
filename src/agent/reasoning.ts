import type { ModelConfig } from '../shared/types';
import { AgentError } from './errors';

type Detail = Record<string, unknown>;
export const REASONING_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 256;
const identityFields = new Set(['type', 'id', 'format', 'index']);
const fragments: Record<string, ReadonlySet<string>> = {
  'reasoning.text': new Set(['text', 'signature']),
  'reasoning.summary': new Set(['summary']),
  'reasoning.encrypted': new Set(['data']),
};

// Structured encoding prevents collisions when ':' appears in URL paths or model IDs.
export const providerId = (model: ModelConfig): string => JSON.stringify([model.kind, model.baseUrl, model.model]);

export function isOpenRouter(baseUrl: string): boolean {
  try { return new URL(baseUrl).origin === 'https://openrouter.ai'; }
  catch { return false; }
}

/** Include adjacent payload fragments in echo checks, even across separate blocks. */
function payloadStrings(details: Detail[]): string {
  const result: string[] = [];
  const stack: unknown[] = [];
  for (let index = details.length - 1; index >= 0; index--) {
    const values = Object.entries(details[index]).filter(([key]) => !identityFields.has(key)).map(([, value]) => value);
    for (let position = values.length - 1; position >= 0; position--) stack.push(values[position]);
  }
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'string') result.push(value);
    else if (value && typeof value === 'object') {
      const values = Object.values(value);
      for (let index = values.length - 1; index >= 0; index--) stack.push(values[index]);
    }
  }
  return result.join('');
}

/** Validate without normalizing: nonstreaming and persisted blocks must roundtrip exactly. */
export function checkedReasoning(value: unknown, credential?: string): Detail[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(detail => !detail || typeof detail !== 'object' || Array.isArray(detail)))
    throw new AgentError('API вернул некорректные reasoning-блоки. Повторите запрос.');
  const details = value as Detail[];
  const serialized = JSON.stringify(details);
  if (details.length > MAX_BLOCKS || Buffer.byteLength(serialized, 'utf8') > REASONING_BYTES)
    throw new AgentError('Размер reasoning-блоков превысил допустимый лимит. Сократите лимит ответа модели.');
  if (credential && (serialized.includes(credential) || payloadStrings(details).includes(credential)))
    throw new AgentError('API вернул credential в reasoning-блоках. Ответ отклонён; проверьте адрес API.');
  return details;
}

/**
 * OpenRouter streams fragments, including late signatures. Keep first appearance order;
 * never sort by index: endpoints may reuse index zero for several distinct blocks.
 * IDs disambiguate opaque blocks; unindexed encrypted blobs remain separate.
 */
export class ReasoningAccumulator {
  private readonly blocks: Detail[] = [];
  private bytes = 2;
  private credentialTail = '';
  constructor(private readonly credential?: string) {}

  add(value: unknown): void {
    const details = checkedReasoning(value, this.credential);
    if (!details) return;
    if (this.credential) {
      const payload = this.credentialTail + payloadStrings(details);
      if (payload.includes(this.credential))
        throw new AgentError('API вернул credential в reasoning-блоках. Ответ отклонён; проверьте адрес API.');
      this.credentialTail = payload.slice(-Math.max(0, this.credential.length - 1));
    }
    for (const delta of details) {
      if (delta.index !== undefined && (!Number.isInteger(delta.index) || (delta.index as number) < 0))
        throw new AgentError('API вернул некорректный индекс reasoning-блока.');
      const existing = this.find(delta);
      if (existing) {
        const before = Buffer.byteLength(JSON.stringify(existing));
        this.merge(existing, delta);
        this.bytes += Buffer.byteLength(JSON.stringify(existing)) - before;
      } else {
        this.blocks.push({ ...delta });
        this.bytes += Buffer.byteLength(JSON.stringify(delta)) + (this.blocks.length > 1 ? 1 : 0);
      }
      if (this.bytes > REASONING_BYTES || this.blocks.length > MAX_BLOCKS)
        throw new AgentError('Размер reasoning-блоков превысил допустимый лимит. Сократите лимит ответа модели.');
    }
  }

  finish(): Detail[] | undefined {
    return this.blocks.length ? checkedReasoning(this.blocks, this.credential) : undefined;
  }

  private find(delta: Detail): Detail | undefined {
    const compatible = (block: Detail) => delta.type === undefined || block.type === delta.type;
    // Different non-null IDs are always distinct, even if an endpoint reuses index.
    if (typeof delta.id === 'string' && delta.id) {
      const found = [...this.blocks].reverse().find(block => block.id === delta.id && compatible(block));
      if (found) return found;
      const last = this.blocks.at(-1);
      return last && !last.id && delta.index !== undefined && last.index === delta.index && compatible(last) ? last : undefined;
    }
    if (delta.index !== undefined) {
      const candidates = this.blocks.filter(block => block.index === delta.index && compatible(block));
      if (delta.type === undefined && candidates.length > 1)
        throw new AgentError('API вернул неоднозначный фрагмент reasoning-блока.');
      const last = candidates.at(-1);
      // Without an ID, text after a different block starts a new sequence. Only
      // metadata-only deltas (e.g. a late signature) can amend an earlier block.
      const hasText = typeof delta.text === 'string' || typeof delta.summary === 'string';
      if (hasText && last !== this.blocks.at(-1)) return undefined;
      // An opaque blob without an identity cannot safely be joined to another blob.
      if (delta.type === 'reasoning.encrypted' && !last?.id) return undefined;
      if (!hasText && candidates.length > 1 && delta.type !== 'reasoning.encrypted')
        throw new AgentError('API вернул неоднозначный фрагмент reasoning-блока.');
      return last;
    }
    const last = this.blocks.at(-1);
    if (delta.type === 'reasoning.encrypted' || !fragments[String(delta.type)]) return undefined;
    return last && compatible(last) ? last : undefined;
  }

  private merge(block: Detail, delta: Detail): void {
    const fields = fragments[String(block.type)];
    if (!fields) throw new AgentError('API вернул неподдерживаемые фрагменты reasoning-блока.');
    for (const [key, value] of Object.entries(delta)) {
      if (fields.has(key)) {
        if (value === null || value === undefined) {
          if (block[key] === undefined) Object.defineProperty(block, key, { value, enumerable: true, writable: true, configurable: true });
        } else if (typeof value === 'string' && (block[key] === undefined || block[key] === null || typeof block[key] === 'string')) {
          Object.defineProperty(block, key, { value: (block[key] ?? '') + value, enumerable: true, writable: true, configurable: true });
        } else throw new AgentError('API вернул некорректный фрагмент reasoning-блока.');
      } else if (block[key] === undefined || block[key] === null) {
        Object.defineProperty(block, key, { value, enumerable: true, writable: true, configurable: true });
      } else if (value !== null && value !== undefined && JSON.stringify(block[key]) !== JSON.stringify(value)) {
        throw new AgentError('API изменил структуру reasoning-блока внутри потока. Ответ отклонён.');
      }
    }
  }
}
