import type { ToolDefinition } from '../shared/types';

const deferred = new Set(['search_history', 'read_history', 'search_tool_output', 'read_tool_output', 'get_operation', 'reconcile_operation', 'list_processes']);
export const workspaceDiscoveryName = 'load_workspace_tools';

/** Discovery only narrows an already permission-filtered catalog, never grants access. */
export function workspaceToolCatalog(local: ToolDefinition[], selected: readonly string[] = []): ToolDefinition[] {
  const available = local.filter(tool => deferred.has(tool.name));
  if (!available.length) return local;
  const loaded = new Set(selected);
  return [...local.filter(tool => !deferred.has(tool.name) || loaded.has(tool.name)), {
    name: workspaceDiscoveryName, permission: 'read',
    description: 'Load workspace helpers for the NEXT step only when needed: search_history/read_history for earlier messages; search_tool_output/read_tool_output for archived output; get_operation/reconcile_operation for uncertain effects; list_processes for command status. Loading metadata executes no action. A new selection replaces the previous one.',
    parameters: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: available.length, uniqueItems: true,
      items: { type: 'string', enum: available.map(tool => tool.name) } } }, required: ['names'], additionalProperties: false },
  }];
}
