import path from 'node:path';
import type { AgentDependencies } from '../shared/agent';
import type { Project, RuleDocument, ToolCall, ToolDefinition, ToolResult } from '../shared/types';
import { scopedRules } from './context';
import { checkAbort } from './errors';

/** A model must see applicable nested instructions before its mutation can execute. */
export async function preflightRules(
  deps: AgentDependencies, project: Project, call: ToolCall, definition: ToolDefinition,
  loadedRules: RuleDocument[], signal: AbortSignal,
): Promise<ToolResult | undefined> {
  if (!['write', 'command'].includes(definition.permission)) return;
  checkAbort(signal);
  const currentRules = await deps.loadInstructions(project);
  const args = { ...call.arguments };
  if (definition.permission === 'command' && !args.cwd) args.cwd = project.folders[0]?.path;
  const command = typeof args.command === 'string' ? args.command : '';
  const requested = typeof args.path === 'string' ? args.path : typeof args.cwd === 'string' ? args.cwd : project.folders[0]?.path ?? '';
  const absolute = path.resolve(project.folders[0]?.path ?? '.', requested);
  const applicable = scopedRules(currentRules, project, `${absolute}\n${command}`, [
    { id: 'preflight', role: 'assistant', content: '', createdAt: '', toolCalls: [{ ...call, arguments: args }] },
  ]);
  const missing = applicable.filter(rule => rule.content.trim() && !loadedRules.some(loaded => loaded.path === rule.path && loaded.content === rule.content));
  if (!missing.length) return;
  return {
    error: true,
    text: 'Инструмент не выполнен: применимые правила ещё не были в контексте модели или изменились. '
      + 'Сначала прочитайте их через read_file, учтите ограничения, затем повторите действие на следующем шаге.\n'
      + missing.map(rule => `Scope: ${rule.scope}; source: ${rule.path}`).join('\n'),
  };
}
