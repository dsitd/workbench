import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../shared/types';
import { ignoreMissing, isValidId, validId } from './durable-files';

interface SessionLog { messages: ChatMessage[]; ids: Set<unknown>; valid: number; bytes: number; terminated: boolean }

/** One JSON object per line. Only an unparsable final line (a torn append) is ignored; earlier damage is reported. */
export function parseMessageLog(buffer: Buffer): SessionLog {
  const messages: ChatMessage[] = [];
  let start = 0, valid = 0, terminated = true, line = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start), end = newline < 0 ? buffer.length : newline;
    line++;
    let value: unknown, parsed = true;
    try { value = JSON.parse(buffer.subarray(start, end).toString('utf8')); } catch { parsed = false; }
    if (!parsed && end + 1 >= buffer.length) break;
    if (!parsed || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Conversation history is damaged at line ${line}. Existing data was preserved.`);
    messages.push(value as ChatMessage);
    valid = Math.min(end + 1, buffer.length); terminated = newline >= 0;
    start = end + 1;
  }
  return { messages, ids: new Set(messages.map(message => message.id)), valid, bytes: buffer.length, terminated };
}
export function serializeMessages(messages: readonly ChatMessage[]): string { return messages.map(message => `${JSON.stringify(message)}\n`).join(''); }

/** Append-only per-session history. Operations of one session are ordered; other sessions proceed independently. */
export class MessageLog {
  private lanes = new Map<string, Promise<unknown>>();
  private cache = new Map<string, SessionLog>();
  constructor(readonly directory: string, private readonly limit = 64) {}
  file(id: string): string { return path.join(this.directory, `${validId(id)}.jsonl`); }

  private lane<T>(id: string, operation: () => Promise<T>): Promise<T> {
    validId(id);
    const pending = (this.lanes.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    this.lanes.set(id, settled);
    void settled.then(() => { if (this.lanes.get(id) === settled) this.lanes.delete(id); });
    return pending;
  }
  private async load(id: string): Promise<SessionLog> {
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached; }
    let buffer = Buffer.alloc(0);
    try { buffer = await readFile(this.file(id)); } catch (error) { ignoreMissing(error); }
    const log = parseMessageLog(buffer);
    this.cache.set(id, log);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return log;
  }

  read(id: string): Promise<ChatMessage[]> { return this.lane(id, async () => structuredClone((await this.load(id)).messages)); }
  /** `prepare` validates and commits metadata; the line is appended only after it succeeds. */
  append(id: string, prepare: (ids: ReadonlySet<unknown>) => Promise<ChatMessage>): Promise<void> {
    return this.lane(id, async () => {
      const log = await this.load(id);
      const message = await prepare(log.ids);
      const text = `${log.terminated ? '' : '\n'}${JSON.stringify(message)}\n`;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const handle = await open(this.file(id), 'a', 0o600);
        try {
          // Drop a torn final line first, so it never becomes damage in the middle of the log.
          if (log.bytes !== log.valid) { await handle.truncate(log.valid); log.bytes = log.valid; }
          try { await handle.writeFile(text); }
          catch (error) { await handle.truncate(log.valid).catch(() => undefined); throw error; }
        } finally { await handle.close(); }
      } catch (error) { this.cache.delete(id); throw error; }
      log.messages.push(message); log.ids.add(message.id);
      log.valid = log.bytes = log.valid + Buffer.byteLength(text); log.terminated = true;
    });
  }
  remove(ids: Iterable<string>): Promise<void[]> {
    return Promise.all([...new Set(ids)].map(id => this.lane(id, async () => { this.cache.delete(id); await unlink(this.file(id)).catch(ignoreMissing); })));
  }
  /** Sessions with a nonempty log, from file names and sizes only. */
  async sessions(): Promise<Set<string>> {
    const found = new Set<string>();
    let names: string[] = [];
    try { names = await readdir(this.directory); } catch (error) { ignoreMissing(error); }
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : '';
      if (!isValidId(id)) continue;
      try { if ((await stat(path.join(this.directory, name))).size > 0) found.add(id); } catch { /* removed concurrently */ }
    }
    for (const [id, log] of this.cache) if (log.messages.length) found.add(id);
    return found;
  }
}
