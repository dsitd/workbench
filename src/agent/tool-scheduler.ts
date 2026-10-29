import type { ToolCall, ToolDefinition } from '../shared/types';

const independentReads = new Set(['read_file', 'list_files', 'search_files', 'read_skill_resource']);
/** Only native reads can overlap. Everything else is a barrier; results commit in declaration order. */
export async function scheduleTools(calls: ToolCall[], definitions: ToolDefinition[], parallel: boolean,
  execute: (call: ToolCall) => Promise<() => Promise<void>>, concurrency = 4): Promise<void> {
  const safe = (call: ToolCall) => parallel && independentReads.has(call.name)
    && definitions.some(tool => tool.name === call.name && tool.permission === 'read' && tool.source?.kind !== 'mcp');
  for (let index = 0; index < calls.length;) {
    const batch = [calls[index++]];
    const signatures = new Set([JSON.stringify([batch[0].name, batch[0].arguments])]);
    if (safe(batch[0])) while (index < calls.length && batch.length < concurrency && safe(calls[index])) {
      const signature = JSON.stringify([calls[index].name, calls[index].arguments]);
      if (signatures.has(signature)) break;
      signatures.add(signature); batch.push(calls[index++]);
    }
    // Drain all started reads even if one fails unexpectedly, before recovery creates missing results.
    const results = await Promise.allSettled(batch.map(execute));
    // Stop at the first failed commit: recovery then fills the remaining IDs in declaration order.
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      await result.value();
    }
  }
}
