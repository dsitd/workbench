import type { ChatMessage } from '../shared/types';
import { readReference } from './context-state';

/** A pure-read group is removable only when a later successful read has the same version and range. */
export function distinctReadGroups(groups: ChatMessage[][]): { groups: ChatMessage[][]; omitted: ChatMessage[][] } {
  const seen = new Set<string>(), retained: ChatMessage[][] = [], omitted: ChatMessage[][] = [];
  for (const group of [...groups].reverse()) {
    const calls = group[0].toolCalls ?? [];
    const mutation = calls.some(call => ['write_file', 'edit_file', 'run_command', 'start_background_command'].includes(call.name) || call.name.startsWith('mcp_'));
    if (mutation || group.some(message => message.error)) seen.clear();
    const comment = group[0].content.trim();
    const simpleProgress = !comment || /^(?:Читаю|Смотрю|Проверяю|Открываю|Прочитаю|Reading|Inspecting|Checking|Opening|Let me (?:read|inspect)|I'll (?:read|inspect))[^\n.!?]{0,150}[.!?]?$/i.test(comment);
    const references = group.slice(1).map(readReference);
    const pureRead = calls.length > 0 && calls.every(call => call.name === 'read_file') && references.length === calls.length && references.every(Boolean) && simpleProgress;
    const keys = pureRead ? references.map(reference => JSON.stringify(reference)) : [];
    if (pureRead && keys.every(key => seen.has(key))) omitted.push(group);
    else { retained.push(group); keys.forEach(key => seen.add(key)); }
  }
  return { groups: retained.reverse(), omitted: omitted.reverse() };
}

/** Preserve file/version headers and late errors instead of silently retaining only the prefix. */
export function boundedToolOutput(text: string, limit = 18_000): string {
  if (text.length <= limit) return text;
  const marker = '\n[Middle output omitted to fit context. The beginning and end are preserved; request a narrower file range or search for details.]\n';
  if (limit <= marker.length) return marker.slice(0, Math.max(0, limit));
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room * 0.72), tail = room - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

export function navigationPaths(history: ChatMessage[], pinnedPaths: string[] = []): string[] {
  const values = [...pinnedPaths];
  for (const message of history.slice(-24)) for (const call of message.toolCalls ?? []) for (const key of ['path', 'cwd']) {
    const value = call.arguments[key];
    if (typeof value === 'string' && value.length <= 2000) values.push(value);
  }
  return [...new Set(values)].slice(-24);
}
