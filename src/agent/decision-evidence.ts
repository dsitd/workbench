import type { ChatMessage } from '../shared/types';

type RecordValue = Record<string, unknown>;
interface Row { pointer: string; value: number; identifiers?: string[]; available?: boolean }
export interface Comparison {
  collection: string; metric: string; aggregation: 'value' | 'sum of all components';
  count: number; ascending: Row[];
}
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const escape = (v: string) => v.replace(/~/g, '~0').replace(/\//g, '~1');
const moneyKey = /^(?:price|prices|cost|costs|amount|amounts)$/i;
const referenceKey = /(?:^|_)(?:id|number)$/i;
const MAX_VIEW = 6000;

/** Numeric projections of a SINGLE observed collection. No eligibility inference,
 * hidden catalogue lookup, cross-object merge, or execution authority is added.
 */
export function comparisonView(text: string): Comparison[] {
  if (text.length > 160_000) return [];
  let root: unknown;
  try { root = JSON.parse(text); } catch { return []; }
  const views: Comparison[] = [];
  let visited = 0;
  function monetaryLeaves(value: RecordValue, prefix = '', monetary = false, depth = 0): Map<string, number> {
    const out = new Map<string, number>();
    if (depth > 4) return out;
    for (const [key, child] of Object.entries(value)) {
      const pointer = prefix + '/' + escape(key), applies = monetary || moneyKey.test(key);
      if (applies && typeof child === 'number' && Number.isFinite(child)) out.set(pointer, child);
      else if (record(child)) for (const [path, number] of monetaryLeaves(child, pointer, applies, depth + 1)) out.set(path, number);
    }
    return out;
  }
  function compare(entries: [string, unknown][], collection: string) {
    if (entries.length < 2 || entries.length > 100) return;
    const compound = entries.every(([, v]) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(record));
    if (!compound && !entries.every(([, v]) => record(v))) return;
    const parts = entries.map(([, v]) => compound ? v as RecordValue[] : [v as RecordValue]);
    // Currency is never converted or assumed interchangeable, including partial metadata.
    const currencies = parts.flat().map(v => JSON.stringify(v.currency ?? null));
    if (new Set(currencies).size !== 1) return;
    const maps = parts.map(group => group.map(v => monetaryLeaves(v)));
    const metrics = [...maps[0][0].keys()].filter(key => maps.every(group => group.every(m => m.has(key))));
    for (const metric of metrics.slice(0, 6)) {
      const ascending = entries.map(([key], index): Row => {
        const values = maps[index].map(m => m.get(metric)!);
        // Suppress floating point addition noise; never round to an assumed currency unit.
        const value = compound ? Number(values.reduce((sum, v) => sum + v, 0).toPrecision(15)) : values[0];
        const identifiers = parts[index].flatMap(v => Object.entries(v)
          .filter(([k, value]) => referenceKey.test(k) && typeof value === 'string' && value.length <= 100)
          .map(([, value]) => value as string)).slice(0, 6);
        return { pointer: collection + '/' + escape(key), value,
          ...(identifiers.length ? { identifiers } : {}),
          ...(!compound && typeof parts[index][0].available === 'boolean' ? { available: parts[index][0].available as boolean } : {}) };
      }).sort((a, b) => a.value - b.value);
      if (ascending.some(row => !Number.isFinite(row.value))) continue;
      const view: Comparison = { collection, metric, aggregation: compound ? 'sum of all components' : 'value', count: entries.length, ascending };
      // Omit an entire view rather than give a misleading incomplete candidate list.
      if (JSON.stringify([...views, view]).length <= MAX_VIEW) views.push(view);
    }
  }
  function walk(value: unknown, pointer = '', depth = 0) {
    if (++visited > 2000 || depth > 8 || views.length >= 8) return;
    if (Array.isArray(value)) {
      compare(value.map((v, i) => [String(i), v]), pointer);
      // A list of component lists has already been compared as whole options.
      // Do not rank individual components as alternative complete options.
      if (value.every(Array.isArray)) return;
      value.forEach((v, i) => walk(v, pointer + '/' + i, depth + 1));
    } else if (record(value)) {
      const entries = Object.entries(value);
      compare(entries, pointer);
      for (const [key, child] of entries) walk(child, pointer + '/' + escape(key), depth + 1);
    }
  }
  walk(root); return views;
}

export function comparisonEvidence(message: Pick<ChatMessage, 'role' | 'content' | 'error'>): string {
  if (message.role !== 'tool' || message.error) return '';
  const views = comparisonView(message.content);
  if (!views.length) return '';
  return '\n[Workbench computed comparisons — quoted data derived only from this tool result. '
    + 'Pointers refer to the original JSON; each list covers exactly its named collection. '
    + 'Prices are not eligibility, user preference, availability or authorization. Apply the requested scope and constraints before choosing; '
    + 'do not merge different objects or infer that a state change occurred.]\n' + JSON.stringify(views);
}
