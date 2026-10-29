import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig, McpTool, Project, ToolDefinition, ToolResult } from '../../shared/types';
import { validId } from '../storage';
import { redactCommandOutput } from '../commands';

export const SERVER_TOOL_LIMIT = 128;
export const PROJECT_TOOL_LIMIT = 64;
export const MESSAGE_LIMIT = 2 * 1024 * 1024;
export class McpFailure extends Error {}
export type SecretValues = { bearerToken?: string; env: Record<string, string>; oauthValues?: string[] };
export const failure = (error: unknown, aborted = false): string => aborted ? 'MCP operation cancelled.' : error instanceof McpFailure ? error.message : 'MCP connection or tool request failed. Check the server, credentials and transport settings.';

export function redact(value: string, secrets: SecretValues): string {
  for (const secret of [secrets.bearerToken, ...Object.values(secrets.env), ...(secrets.oauthValues ?? [])].filter((item): item is string => Boolean(item))) value = value.split(secret).join('[credential redacted]');
  return redactCommandOutput(value);
}
function text(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || value.includes('\0')) throw new McpFailure(`${label} is invalid.`);
  return value.trim();
}
function strings(value: unknown, label: string, maximum: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new McpFailure(`${label} is invalid.`);
  const items = value.map(item => text(item, label, length));
  if (new Set(items).size !== items.length) throw new McpFailure(`${label} contains duplicates.`);
  return items;
}
export function loopback(url: URL): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
export function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new McpFailure('MCP endpoint must be a valid URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new McpFailure('MCP URL must not contain credentials, query parameters or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new McpFailure('MCP requires HTTPS; HTTP is allowed only for an explicit loopback endpoint.');
  return url;
}
export function envName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,63}$/.test(value) && !/^(?:PATH|HOME|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|LD_.+|DYLD_.+|BASH_ENV|ENV|SHELLOPTS|ZDOTDIR|PYTHONPATH|PYTHONHOME|npm_config_.+)$/i.test(value);
}
export function normalizeServer(input: McpServerConfig, previous?: McpServerConfig): McpServerConfig {
  const id = input.id ? validId(input.id) : randomUUID();
  if (!['stdio', 'http'].includes(input.transport)) throw new McpFailure('Unknown MCP transport.');
  const projectIds = strings(input.projectIds, 'MCP projects', 100, 100).map(validId);
  const envNames = strings(input.envNames, 'MCP environment names', 32, 64);
  if (envNames.some(name => !envName(name))) throw new McpFailure('MCP environment names contain a reserved or invalid variable.');
  const bearerTokenEnv = text(input.bearerTokenEnv, 'MCP token environment name', 64, true);
  if (bearerTokenEnv && !envName(bearerTokenEnv)) throw new McpFailure('MCP token environment name is invalid.');
  const command = input.transport === 'stdio' ? text(input.command, 'MCP executable', 4096) : '';
  if (command && /[\r\n]/.test(command)) throw new McpFailure('MCP executable must be a single executable name or path.');
  if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new McpFailure('MCP arguments are invalid.');
  const args = input.transport === 'stdio' ? [...input.args] : [];
  if (JSON.stringify(args).length > 16_384 || redactCommandOutput(JSON.stringify([command, ...args])) !== JSON.stringify([command, ...args])) throw new McpFailure('Use MCP environment variables for credentials instead of executable arguments.');
  const url = input.transport === 'http' ? endpoint(text(input.url, 'MCP endpoint', 4096)).href : '';
  const identity = { transport: input.transport, command, args, url, envNames, bearerTokenEnv };
  const changed = previous && canonical(identity) !== canonical({ transport: previous.transport, command: previous.command, args: previous.args, url: previous.url, envNames: previous.envNames, bearerTokenEnv: previous.bearerTokenEnv });
  const tools = changed ? [] : previous?.tools ?? [];
  const enabledTools = changed ? [] : strings(input.enabledTools, 'Enabled MCP tools', PROJECT_TOOL_LIMIT, 128);
  if (enabledTools.some(name => !tools.some(tool => tool.name === name))) throw new McpFailure('Discover an MCP tool before enabling it.');
  return { id, name: text(input.name, 'MCP name', 120), transport: input.transport, enabled: input.enabled === true, projectIds, command, args, url, envNames, bearerTokenEnv, enabledTools, tools: structuredClone(tools), ...(changed ? {} : previous?.checkedAt ? { checkedAt: previous.checkedAt } : {}) };
}
export function canonical(value: unknown): string {
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 24) throw new McpFailure('MCP JSON nesting exceeds the supported limit.');
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
export function normalizeTools(value: unknown, secrets: SecretValues): McpTool[] {
  if (!Array.isArray(value) || value.length > SERVER_TOOL_LIMIT) throw new McpFailure(`MCP discovery exceeds ${SERVER_TOOL_LIMIT} tools. Reduce the server catalogue.`);
  const names = new Set<string>();
  const tools = value.map(item => {
    const name = text(item?.name, 'MCP tool name', 128);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || names.has(name) || redact(name, secrets) !== name) throw new McpFailure('MCP tool names are invalid, duplicate or contain protected data.');
    names.add(name);
    const schema = item?.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') throw new McpFailure('MCP tools must provide an object input schema.');
    const encoded = canonical(schema);
    if (encoded.length > 24_000 || redact(encoded, secrets) !== encoded) throw new McpFailure('MCP tool schema is too large or contains protected data.');
    return { name, description: redact(typeof item.description === 'string' ? item.description : '', secrets).slice(0, 2000), inputSchema: JSON.parse(encoded), ...(typeof item.annotations?.readOnlyHint === 'boolean' ? { readOnlyHint: item.annotations.readOnlyHint } : {}) };
  });
  if (JSON.stringify(tools).length > 768_000) throw new McpFailure('MCP discovery catalogue is too large.');
  return tools;
}
export function toolName(serverId: string, original: string): string {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `mcp_${hash(serverId)}_${original.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32)}_${hash(original)}`;
}
export function definition(server: McpServerConfig, tool: McpTool): ToolDefinition {
  return { name: toolName(server.id, tool.name), description: `MCP server ${server.name}. ${tool.description}${tool.readOnlyHint ? ' The server claims this tool is read-only; this hint is untrusted.' : ''}`, parameters: structuredClone(tool.inputSchema), permission: 'mcp', source: { kind: 'mcp', serverId: server.id, serverName: server.name, toolName: tool.name } };
}
export function projectRights(project: Project): string { return canonical({ id: project.id, folders: project.folders, internet: project.internet, commandPolicy: project.commandPolicy }); }
export function fingerprint(server: McpServerConfig, project: Project): string { return canonical({ server, project: projectRights(project) }); }
export function renderResult(result: Record<string, unknown>, secrets: SecretValues): ToolResult {
  const lines: string[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') lines.push(item.text);
    else if (item?.type === 'resource' && typeof item.resource?.text === 'string') lines.push(item.resource.text);
    else lines.push(`[Unsupported MCP content: ${typeof item?.type === 'string' ? item.type.slice(0, 40) : 'unknown'}; binary payload omitted]`);
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') lines.push(JSON.stringify(result.structuredContent));
  const output = redact(lines.join('\n') || '[MCP tool returned no text]', secrets);
  return { text: output, ...(result.isError === true ? { error: true } : {}) };
}
