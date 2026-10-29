/** These tools describe claims, archives or runtime metadata, never current external state. */
export const nonEvidenceTools: ReadonlySet<string> = new Set([
  'explore_code', 'search_counterexamples', 'update_plan', 'find_mcp_tools', 'load_workspace_tools', 'list_attachments',
  'read_history', 'search_history', 'read_tool_output', 'search_tool_output',
  'get_operation', 'reconcile_operation', 'set_task_criteria', 'record_task_evidence',
  'record_task_note', 'check_completion', 'load_task_tools', 'finish_task',
]);
