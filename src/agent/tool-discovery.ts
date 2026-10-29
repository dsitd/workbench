import type { ToolCall, ToolDefinition, ToolResult } from '../shared/types';
import { AgentError } from './errors';

const EAGER_LIMIT = 8;
const MAX_CATALOG = 512;
export const discoveryTool: ToolDefinition = {
  name: 'find_mcp_tools', permission: 'read',
  description: 'Find enabled project MCP tools by task, server, or tool name. This local metadata search does not contact or execute a server. Matching tools are loaded with full schemas on the NEXT model step; call this before using a tool not in the current catalog. A new search replaces the previous selection.',
  parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
};
const external = (tool: ToolDefinition) => tool.source?.kind === 'mcp' || tool.name.startsWith('mcp_');
const tokens = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];

/** Large MCP catalogs cost metadata locally; only an explicit selection costs model schema tokens. */
export class ToolDiscovery {
  private available: ToolDefinition[] = [];
  private selected: Set<string>;
  constructor(names: string[] = []) { this.selected = new Set(names.filter(name => typeof name === 'string').slice(0, EAGER_LIMIT)); }

  catalog(local: ToolDefinition[], additional: ToolDefinition[]): ToolDefinition[] {
    if (additional.length > MAX_CATALOG) throw new AgentError(`Каталог содержит больше ${MAX_CATALOG} внешних инструментов. Разделите подключения по проектам.`);
    const names = new Set<string>();
    for (const tool of [...local, ...additional, discoveryTool]) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new AgentError('Каталог содержит некорректное имя инструмента. Проверьте настройки подключённых серверов.');
      if (names.has(tool.name)) throw new AgentError('Каталог содержит повторяющиеся имена инструментов. Проверьте настройки подключённых серверов.');
      names.add(tool.name);
    }
    this.available = additional.filter(external).sort((a, b) => a.name.localeCompare(b.name));
    const active = new Set(this.available.map(tool => tool.name));
    this.selected = new Set([...this.selected].filter(name => active.has(name)));
    const deferred = this.available.length > EAGER_LIMIT;
    const chosen = deferred ? this.available.filter(tool => this.selected.has(tool.name)) : this.available;
    return [...local, ...additional.filter(tool => !external(tool)), ...chosen, ...(deferred ? [discoveryTool] : [])]
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get loadedNames(): string[] { return [...this.selected].sort(); }

  find(call: ToolCall): ToolResult {
    const query = call.arguments.query;
    const limit = call.arguments.limit ?? EAGER_LIMIT;
    if (typeof query !== 'string' || !query.trim() || query.length > 1000 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > EAGER_LIMIT)
      throw new AgentError('Укажите поисковый запрос и лимит от 1 до 8 MCP-инструментов.');
    const words = tokens(query);
    const ranked = this.available.map(tool => {
      const name = tool.name.toLowerCase(), server = tool.source?.serverName.toLowerCase() ?? '';
      const haystack = `${name} ${server} ${tool.description.toLowerCase()}`;
      const score = name === query.trim().toLowerCase() ? 1000 : words.reduce((sum, word) => sum + (haystack.includes(word) ? (name.includes(word) ? 4 : server.includes(word) ? 3 : 1) : 0), 0);
      return { tool, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, Number(limit));
    this.selected = new Set(ranked.map(item => item.tool.name));
    return { text: JSON.stringify({ totalAvailable: this.available.length, loadedForNextStep: ranked.map(({ tool }) => ({ name: tool.name, server: tool.source?.serverName, description: tool.description.slice(0, 400) })), note: 'Use the exact names and full schemas supplied in the next request. No external action has been performed.' }) };
  }
}
