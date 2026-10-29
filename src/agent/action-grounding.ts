import type { ChatMessage, ToolCall, ToolDefinition } from '../shared/types';

const keyName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const referenceKey = (key: string) => /(?:^|_)(?:ids?|email|emails|number)$/.test(keyName(key));
const recoveryTools = new Set(['get_operation', 'reconcile_operation']);

/** References to existing objects must come from user input or observed data.
 * Values for newly created free-form content (paths, names, text, dates) are not references.
 */
export function referenceArguments(call: ToolCall): { path: string; key: string; value: string }[] {
  if (recoveryTools.has(call.name)) return [];
  const out: { path: string; key: string; value: string }[] = [];
  const visit = (value: unknown, key: string, path: string) => {
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, key, `${path}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, item] of Object.entries(value)) visit(item, k, path ? `${path}.${k}` : k);
    else if (typeof value === 'string' && value && referenceKey(key)) {
      if (keyName(key) === 'id' && /(?:^|_)(?:create|add|new)(?:_|$)/i.test(call.name)) return;
      out.push({ path, key: keyName(key), value });
    }
  };
  visit(call.arguments, '', ''); return out;
}

export function referenceError(call: ToolCall, history: ChatMessage[]): string | undefined {
  const references = referenceArguments(call);
  if (!references.length) return;
  const corpus = history.filter(m => m.role === 'user' || m.role === 'tool' && !m.error)
    .map(m => m.content + (m.attachmentIds?.length ? '\n' + JSON.stringify(m.attachmentIds) : '')).join('\n');
  const missing = references.filter(({ value, key }) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A sentence-ending period is punctuation; an internal dot followed by a
    // token character still extends the reference (e.g. an email suffix).
    return !new RegExp(`(?<![\\p{L}\\p{N}_@.#+-])${escaped}(?![\\p{L}\\p{N}_@#+-]|\\.[\\p{L}\\p{N}_@#+-])`, /emails?$/.test(key) ? 'iu' : 'u').test(corpus);
  });
  if (!missing.length) return;
  return 'Reference check: action not executed. These reference arguments were not found exactly in customer input or successful tool observations: '
    + missing.map(v => `${v.path}=${JSON.stringify(v.value)}`).join(', ')
    + '. Copy the exact value from the source, or first obtain it with a lookup. Assistant claims and failed calls do not establish an identifier. Do not guess or repeat the same unsupported value.';
}

/** External object mutations, rather than ordinary file edits or commands. */
export function needsActionReview(call: ToolCall, definition: ToolDefinition): boolean {
  if (!referenceArguments(call).length) return false;
  if (definition.permission === 'write') return true;
  return definition.permission === 'mcp' && !/(?:^|_)(?:get|list|search|find|read|fetch|check|describe)(?:_|$)/i.test(call.name);
}
