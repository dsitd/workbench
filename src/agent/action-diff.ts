import type { ModelMessage } from '../shared/agent';
import type { ToolCall } from '../shared/types';

type ObjectValue = Record<string, unknown>;
export interface ObservedActionDiff {
  sourceToolCallId: string; sourceToolName: string; selector: ObjectValue;
  equal: string[]; different: Record<string, { observed: unknown; proposed: unknown }>; notInObservation: string[];
}
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const reference = (key: string) => /(?:^|_)(?:id|number)$/i.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
const own = (v: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(v, key);
// Arguments often project a stored object: omitted display fields do not mean a change.
function equalProjection(observed: unknown, proposed: unknown): boolean {
  if (Array.isArray(proposed)) return Array.isArray(observed) && proposed.length === observed.length && proposed.every((v, i) => equalProjection(observed[i], v));
  if (object(proposed)) return object(observed) && Object.keys(proposed).every(k => own(observed, k) && equalProjection(observed[k], proposed[k]));
  return Object.is(observed, proposed);
}

/** Compare exact argument projections with observations identified by the SOURCE
 * call's selector, not a foreign ID merely mentioned inside its returned data.
 * This is an observed field comparison, never policy eligibility or proof of freshness.
 */
export function observedActionDiff(action: ToolCall, history: ModelMessage[]): ObservedActionDiff[] {
  const calls = new Map<string, ToolCall>();
  const snapshots = new Map<string, { source: ToolCall; selector: ObjectValue; value: ObjectValue }>();
  for (const message of history) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool') continue;
    const source = calls.get(message.toolCallId ?? '');
    if (!source) continue;
    const refs = Object.entries(source.arguments).filter(([key, value]) => reference(key) && typeof value === 'string');
    if (!refs.length || !refs.some(([key, value]) => action.arguments[key] === value)) continue;
    const selector = Object.fromEntries(refs.sort(([a], [b]) => a.localeCompare(b)));
    // Any later result on an overlapping target invalidates an older snapshot,
    // including errors with an unknown outcome and opaque success acknowledgements.
    for (const [key, old] of snapshots) if (Object.entries(old.selector).some(([k, v]) => selector[k] === v)) snapshots.delete(key);
    if (!refs.every(([key, value]) => action.arguments[key] === value)) continue;
    if (message.error || message.content.length > 160_000) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(message.content); } catch { continue; }
    const matches = (v: unknown): v is ObjectValue => object(v) && refs.every(([k, val]) => own(v, k) && v[k] === val);
    const found: ObjectValue[] = [];
    let visited = 0;
    function visit(value: unknown, depth = 0) {
      if (++visited > 500 || depth > 5 || found.length > 1) return;
      if (matches(value)) { found.push(value); return; }
      if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
      else if (object(value)) Object.values(value).forEach(v => visit(v, depth + 1));
    }
    visit(parsed);
    if (found.length === 1 && visited <= 500) snapshots.set(JSON.stringify(selector), { source, selector, value: found[0] });
  }
  const out: ObservedActionDiff[] = [];
  for (const { source, selector, value } of snapshots.values()) {
    const diff: ObservedActionDiff = { sourceToolCallId: source.id, sourceToolName: source.name, selector, equal: [], different: {}, notInObservation: [] };
    for (const [key, proposed] of Object.entries(action.arguments)) {
      if (own(selector, key)) continue;
      if (!own(value, key)) diff.notInObservation.push(key);
      else if (equalProjection(value[key], proposed)) diff.equal.push(key);
      else diff.different[key] = { observed: value[key], proposed };
    }
    if ((diff.equal.length || Object.keys(diff.different).length) && JSON.stringify([...out, diff]).length <= 6000) out.push(diff);
  }
  return out;
}
