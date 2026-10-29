import { isDeepStrictEqual } from 'node:util';
import type { ChatMessage, RunRecord } from '../shared/types';
import type { EvalTask, EvalTrace } from './types';

export function traceResults(messages: ChatMessage[]): EvalTrace[] {
  return messages.flatMap(message => (message.toolCalls ?? []).map(call => {
    const results = messages.filter(item => item.role === 'tool' && item.toolCallId === call.id);
    return { callId: call.id, tool: call.name, error: results.some(item => Boolean(item.error)), resultCount: results.length,
      outputChars: results.reduce((sum, item) => sum + item.content.length, 0), archived: results.some(item => Boolean(item.outputRef)) };
  }));
}

/** Grade persisted state and public trace independently of the scripted model's final claim. */
export function gradeTask(task: EvalTask, before: Record<string, string>, after: Record<string, string>, messages: ChatMessage[], run?: RunRecord): { failures: string[]; changedFiles: string[]; trace: EvalTrace[] } {
  const failures: string[] = [], trace = traceResults(messages);
  const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort();
  if (run?.status !== (task.status ?? 'completed')) failures.push(`Expected status ${task.status ?? 'completed'}, got ${run?.status ?? 'missing'}.`);
  for (const file of changedFiles) if (!task.allowedChanges.includes(file)) failures.push(`Unauthorized file change: ${file}.`);
  for (const check of task.expected) {
    const content = after[check.path];
    if (check.missing) { if (content !== undefined) failures.push(`File should be absent: ${check.path}.`); continue; }
    if (content === undefined) { failures.push(`Missing file: ${check.path}.`); continue; }
    if (check.equals !== undefined && content !== check.equals) failures.push(`Incorrect final contents: ${check.path}.`);
    for (const text of check.includes ?? []) if (!content.includes(text)) failures.push(`Missing required passage in ${check.path}.`);
    for (const text of check.excludes ?? []) if (content.includes(text)) failures.push(`Forbidden passage remains in ${check.path}.`);
    if (check.json !== undefined) {
      try { if (!isDeepStrictEqual(JSON.parse(content), check.json)) failures.push(`Incorrect JSON value: ${check.path}.`); }
      catch { failures.push(`Invalid JSON: ${check.path}.`); }
    }
  }
  for (const call of trace) if (call.resultCount !== 1) failures.push(`Tool ${call.tool} has ${call.resultCount} results; exactly one is required.`);
  const declared = new Set(trace.map(item => item.callId));
  if (messages.some(item => item.role === 'tool' && item.toolCallId && !declared.has(item.toolCallId))) failures.push('Unannounced tool result in trace.');
  for (const name of task.requiredTools ?? []) if (!trace.some(item => item.tool === name && !item.error && item.resultCount === 1)) failures.push(`No successful ${name} observation.`);
  for (const name of task.requiredToolErrors ?? []) if (!trace.some(item => item.tool === name && item.error)) failures.push(`Expected ${name} rejection was not observed.`);
  for (const check of task.toolChecks ?? []) if (!messages.some(item => item.role === 'tool' && item.toolName === check.tool && !item.error && check.includes.every(text => item.content.includes(text)))) failures.push(`Required observed data is missing from ${check.tool}.`);
  const answer = messages.filter(item => item.role === 'assistant' && !item.toolCalls?.length && !item.error).at(-1)?.content ?? '';
  for (const text of task.answerIncludes ?? []) if (!answer.includes(text)) failures.push('Required finding is absent from the final answer.');
  if (task.evidence && (!run?.acceptanceCriteria?.length || run.acceptanceCriteria.some(item => !item.evidence || item.evidence.revision !== (run.mutationRevision ?? 0) || item.evidence.scope !== run.evidenceScope))) failures.push('Acceptance evidence is absent or stale.');
  return { failures, changedFiles, trace };
}
