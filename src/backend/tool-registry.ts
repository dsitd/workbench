import { agentMode } from '../shared/modes';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../shared/types';
import { toolValidator, validateToolArguments } from '../shared/tool-schema';

export interface RegisteredTool<Host> {
  definition: ToolDefinition;
  execute(arguments_: Record<string, unknown>, context: ToolContext, host: Host): Promise<ToolResult>;
}

const runtimeToolNames = new Set(['update_plan', 'list_attachments', 'explore_code', 'verify_project', 'find_mcp_tools', 'set_task_criteria', 'record_task_evidence', 'record_task_note', 'check_completion', 'load_task_tools', 'load_workspace_tools']);

/** Definitions and handlers share one registration, so advertised tools cannot lack an implementation. */
export class ToolRegistry<Host> {
  private entries = new Map<string, RegisteredTool<Host>>();

  constructor(entries: RegisteredTool<Host>[] = []) { for (const entry of entries) this.register(entry); }

  register(entry: RegisteredTool<Host>): void {
    const definition = entry?.definition;
    if (!definition || typeof definition.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(definition.name)) throw new Error('Tool name must contain 1–64 letters, digits, underscores or hyphens and start with a letter or underscore.');
    if (this.entries.has(definition.name)) throw new Error(`Tool is already registered: ${definition.name}`);
    if (typeof definition.description !== 'string' || !definition.description.trim()) throw new Error('Tool description is required.');
    if (!['read', 'write', 'command', 'network', 'mcp'].includes(definition.permission)) throw new Error('Invalid tool permission.');
    if (runtimeToolNames.has(definition.name)) throw new Error(`Tool name is reserved by the runtime: ${definition.name}`);
    if (definition.permission === 'mcp' || definition.source !== undefined || /^mcp_/i.test(definition.name)) throw new Error('Native tools cannot use MCP permissions, names or sources. Use the MCP manager.');
    if (!definition.parameters || typeof definition.parameters !== 'object' || Array.isArray(definition.parameters) || definition.parameters.type !== 'object') throw new Error('Tool parameters must describe an object.');
    if (typeof entry.execute !== 'function') throw new Error('Tool handler is required.');
    toolValidator(definition.parameters);
    // Keep permission decisions independent of mutations to a caller-owned definition.
    this.entries.set(definition.name, { definition: structuredClone(definition), execute: entry.execute });
  }

  get definitions(): ToolDefinition[] { return [...this.entries.values()].map(entry => structuredClone(entry.definition)); }

  async execute(call: ToolCall, context: ToolContext, host: Host): Promise<ToolResult> {
    const entry = this.entries.get(call.name);
    if (context.readOnly && (!entry || entry.definition.permission !== 'read' || entry.definition.source?.kind === 'mcp' || /^mcp_/i.test(call.name))) throw new Error('Read-only delegated context can only use local read tools.');
    if (agentMode(context.mode) === 'plan' && (entry?.definition.permission === 'write' || entry?.definition.permission === 'command' || entry?.definition.permission === 'mcp' || entry?.definition.source || /^mcp_/i.test(call.name))) throw new Error('Plan mode cannot write files, run commands or execute MCP tools.');
    if (entry?.definition.permission === 'network' && !context.project.internet) throw new Error('Internet access is disabled for this project.');
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Tool arguments must be an object.');
    if (!entry) throw new Error(`Unknown tool: ${call.name}`);
    if (context.signal.aborted) throw new Error('Task cancelled.');
    validateToolArguments(entry.definition, call.arguments);
    return entry.execute(call.arguments, context, host);
  }
}
