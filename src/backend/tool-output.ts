import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolCall, ToolContext, ToolResult } from '../shared/types';
import { accessScope } from '../shared/task-evidence';
import { PrivateRecords } from './private-records';

interface StoredOutput { id: string; projectId: string; sessionId: string; runId?: string; toolCallId: string; toolName: string; scope: string; text: string; sha256: string; createdAt: string }
export class ToolOutputStore {
  private records: PrivateRecords<StoredOutput>;
  constructor(dataDir: string) { this.records = new PrivateRecords(path.join(dataDir, 'tool-output')); }
  async retain(call: ToolCall, context: ToolContext, result: ToolResult): Promise<ToolResult> {
    if (result.text.length <= 18_000) return result;
    if (Buffer.byteLength(result.text) > 8 * 1024 * 1024) throw new Error('Tool output exceeds 8 MiB. Narrow the query before continuing.');
    const record: StoredOutput = { id: randomUUID(), projectId: context.project.id, sessionId: context.sessionId, runId: context.runId,
      toolCallId: call.id, toolName: call.name, scope: accessScope(context.project), text: result.text,
      sha256: createHash('sha256').update(result.text).digest('hex'), createdAt: new Date().toISOString() };
    await this.records.save(record);
    const reference = `\n[Full tool output saved: resultId=${record.id}; totalChars=${record.text.length}. Use read_tool_output or search_tool_output in this chat to retrieve omitted details.]`;
    return { ...result, outputRef: record.id, text: result.text.slice(0, 12_000) + '\n[Middle output stored locally]\n' + result.text.slice(-3000) + reference };
  }
  private async owned(id: string, context: ToolContext): Promise<StoredOutput> {
    if (context.signal.aborted) throw new Error('Task cancelled.');
    const record = await this.records.get(id);
    if (!record || record.projectId !== context.project.id || record.sessionId !== context.sessionId || record.scope !== accessScope(context.project)) throw new Error('Tool output is unavailable in this chat or its access scope changed.');
    return record;
  }
  async read(id: string, context: ToolContext, offset = 0, length = 8000): Promise<ToolResult> {
    const record = await this.owned(id, context);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 12_000) throw new Error('Use a nonnegative offset and length from 1 to 12000.');
    return { text: JSON.stringify({ resultId: id, toolName: record.toolName, sha256: record.sha256, totalChars: record.text.length, offset,
      nextOffset: offset + length < record.text.length ? offset + length : null, text: record.text.slice(offset, offset + length) }) };
  }
  async search(id: string, query: string, context: ToolContext, offset = 0, limit = 20): Promise<ToolResult> {
    const record = await this.owned(id, context);
    if (!query.trim() || query.length > 500 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('Supply a bounded literal query, offset and limit.');
    const matches: { offset: number; excerpt: string }[] = [];
    const lower = record.text.toLowerCase(), needle = query.toLowerCase();
    let position = lower.indexOf(needle, offset), nextOffset: number | null = null;
    while (position >= 0 && matches.length < limit) {
      matches.push({ offset: position, excerpt: record.text.slice(Math.max(0, position - 80), position + query.length + 120) });
      position = lower.indexOf(needle, position + Math.max(1, needle.length));
    }
    if (position >= 0) nextOffset = position;
    return { text: JSON.stringify({ resultId: id, totalChars: record.text.length, matches, nextOffset }) };
  }
}
