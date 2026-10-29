import { Client, StreamableHTTPClientTransport, type AuthProvider, type FetchLike, type RequestOptions } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import type { McpConnectionReport, McpConnectionStatus, McpServerConfig, Project, ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../shared/types';
import { agentMode, type AgentMode } from '../../shared/modes';
import { validateToolArguments } from '../../shared/tool-schema';
import type { WorkspaceCallbacks } from '../commands';
import { requireItem, StateStore, validId, type WorkspaceState } from '../storage';
import { originFetch } from './http';
import { createStdio, type ManagedTransport, type StdioFactory } from './stdio';
import { canonical, definition, endpoint, failure, fingerprint, loopback, McpFailure, normalizeServer, normalizeTools, PROJECT_TOOL_LIMIT, projectRights, redact, renderResult, toolName, type SecretValues } from './safety';

export type ResolveMcpSecrets = (server: McpServerConfig) => Promise<SecretValues>;
export interface McpManagerOptions {
  stdioFactory?: StdioFactory; fetch?: FetchLike; timeoutMs?: number;
  authProvider?: (server: McpServerConfig, project: Project, signal: AbortSignal, interactive: boolean, secrets: SecretValues) => AuthProvider;
}
interface Connection {
  key: string; serverId: string; projectId: string; signature: string; controller: AbortController;
  client: Client; secrets: SecretValues; managed?: ManagedTransport; ready: Promise<void>; connected: boolean; closing?: Promise<void>;
}
interface Operation { key: string; controller: AbortController }

function cancellation(): DOMException { return new DOMException('MCP cancelled', 'AbortError'); }
async function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancellation();
  let abort: () => void = () => undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { abort = () => reject(cancellation()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

export class McpManager {
  private connections = new Map<string, Connection>();
  private operations = new Set<Operation>();
  private closed = false;
  private readonly timeout: number;
  constructor(readonly store: StateStore, private callbacks: WorkspaceCallbacks, private resolveSecrets: ResolveMcpSecrets, private options: McpManagerOptions = {}) {
    this.timeout = Math.max(100, Math.min(options.timeoutMs ?? 60_000, 120_000));
  }
  private key(id: string, projectId: string, scope = 'probe'): string { return `${id}:${projectId}:${scope}`; }
  private begin(id: string, projectId: string, external?: AbortSignal, scope = 'probe') {
    if (this.closed) throw new McpFailure('MCP manager is closed.');
    const operation = { key: this.key(id, projectId, scope), controller: new AbortController() };
    this.operations.add(operation);
    const signal = external ? AbortSignal.any([external, operation.controller.signal]) : operation.controller.signal;
    return { key: operation.key, signal, finish: () => this.operations.delete(operation) };
  }
  private requestOptions(signal: AbortSignal): RequestOptions { return { signal, timeout: this.timeout, maxTotalTimeout: this.timeout, resetTimeoutOnProgress: false }; }
  async listServers(): Promise<McpServerConfig[]> { return (await this.store.read()).mcpServers ?? []; }
  async saveServer(input: McpServerConfig): Promise<McpServerConfig> {
    const saved = await this.store.mutate(state => {
      const servers = state.mcpServers ??= [];
      const previous = servers.find(server => server.id === input.id);
      if (!previous && servers.length >= 32) throw new McpFailure('At most 32 MCP servers can be configured.');
      const server = normalizeServer(input, previous);
      if (server.projectIds.some(id => !state.projects.some(project => project.id === id))) throw new McpFailure('MCP project assignment no longer exists.');
      const index = servers.findIndex(item => item.id === server.id);
      if (index < 0) servers.push(server); else servers[index] = server;
      return server;
    });
    await this.disconnect(saved.id);
    this.callbacks.emit({ type: 'refresh' });
    return saved;
  }
  async deleteServer(id: string): Promise<void> {
    await this.store.mutate(state => {
      requireItem(state.mcpServers ?? [], validId(id), 'MCP server');
      state.mcpServers = state.mcpServers!.filter(server => server.id !== id);
    });
    await this.disconnect(id);
    this.callbacks.emit({ type: 'refresh' });
  }
  private async reconcile(state: WorkspaceState): Promise<void> {
    await Promise.all([...this.connections.values()].filter(connection => {
      const server = state.mcpServers?.find(item => item.id === connection.serverId);
      const project = state.projects.find(item => item.id === connection.projectId);
      return !server || !project || !server.projectIds.includes(project.id) || fingerprint(server, project) !== connection.signature;
    }).map(connection => this.release(connection)));
  }
  private async context(serverId: string, projectId: string, original?: Project, sessionId?: string): Promise<{ server: McpServerConfig; project: Project }> {
    const state = await this.store.read();
    await this.reconcile(state);
    const server = requireItem(state.mcpServers ?? [], validId(serverId), 'MCP server');
    const project = requireItem(state.projects, validId(projectId), 'Project');
    if (!server.projectIds.includes(project.id)) throw new McpFailure('MCP server is not assigned to this project.');
    if (original && projectRights(original) !== projectRights(project)) throw new McpFailure('Project access changed. Restart the task before calling MCP.');
    for (const folder of project.folders) if (await realpath(folder.path) !== folder.path) throw new McpFailure('Project folder identity changed. Re-select the folder before using MCP.');
    if (sessionId && requireItem(state.sessions, validId(sessionId), 'Session').projectId !== project.id) throw new McpFailure('MCP session does not belong to this project.');
    if (server.transport === 'http' && !project.internet && !loopback(endpoint(server.url))) throw new McpFailure('Internet access is disabled for this project. Remote MCP servers are unavailable.');
    return { server, project };
  }
  private async acquire(server: McpServerConfig, project: Project, signal: AbortSignal, scope = 'probe', resolved?: SecretValues): Promise<Connection> {
    if (signal.aborted) throw cancellation();
    const key = this.key(server.id, project.id, scope);
    const signature = fingerprint(server, project);
    let connection = this.connections.get(key);
    if (connection && (connection.signature !== signature || connection.controller.signal.aborted)) { await this.release(connection); connection = undefined; }
    if (connection) { this.connections.delete(key); this.connections.set(key, connection); }
    else {
      if (this.connections.size >= 32) {
        // Chat connections stay open between runs; evict the least recently used idle one instead of failing.
        const busy = new Set([...this.operations].map(operation => operation.key));
        const idle = [...this.connections.values()].find(item => !busy.has(item.key));
        if (!idle) throw new McpFailure('Too many active MCP connections. Disconnect unused servers before starting another connection.');
        await this.release(idle);
      }
      const client = new Client({ name: 'Workbench', version: '0.3.0' }, { capabilities: { roots: { listChanged: false } }, listMaxPages: 4 });
      const current: Connection = { key, serverId: server.id, projectId: project.id, signature, controller: new AbortController(), client, secrets: { env: {} }, ready: Promise.resolve(), connected: false };
      this.connections.set(key, current);
      const lifetime = current.controller.signal;
      client.onerror = () => undefined;
      // A closed transport (for example a crashed stdio server) is stale; the next acquire reconnects.
      client.onclose = () => { current.connected = false; current.controller.abort(); };
      current.ready = (async () => {
        try {
          current.secrets = resolved ?? await interruptible(this.resolveSecrets(server), AbortSignal.any([signal, lifetime]));
          if (!current.secrets.env || typeof current.secrets.env !== 'object') throw new McpFailure('MCP credential resolver returned an invalid environment.');
          if (server.transport === 'stdio') current.managed = await createStdio(this.store.directory, server, project, current.secrets, this.options.stdioFactory);
          else {
            const url = endpoint(server.url);
            if (current.secrets.bearerToken && (typeof current.secrets.bearerToken !== 'string' || current.secrets.bearerToken.length > 8192 || /[\r\n]/.test(current.secrets.bearerToken))) throw new McpFailure('MCP bearer credential is invalid.');
            current.managed = { transport: new StreamableHTTPClientTransport(url, {
              authProvider: !current.secrets.bearerToken ? this.options.authProvider?.(server, project, AbortSignal.any([signal, lifetime]), scope === 'probe', current.secrets) : undefined,
              fetch: originFetch(url, lifetime, this.options.fetch, this.timeout), requestInit: { redirect: 'error', headers: current.secrets.bearerToken ? { Authorization: `Bearer ${current.secrets.bearerToken}` } : {} },
              redirectPolicy: 'same-origin', onInsufficientScope: 'throw', reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
            }), cleanup: async () => undefined };
          }
          if (signal.aborted || lifetime.aborted) throw cancellation();
          client.setRequestHandler('roots/list', async () => ({ roots: project.folders.map(folder => ({ uri: pathToFileURL(folder.path).href, name: `Project folder (${folder.access})` })) }));
          const connectOptions = this.requestOptions(AbortSignal.any([signal, lifetime]));
          if (scope === 'probe' && this.options.authProvider && server.transport === 'http') connectOptions.timeout = connectOptions.maxTotalTimeout = 5 * 60_000;
          await client.connect(current.managed.transport, connectOptions);
          if (signal.aborted || lifetime.aborted) throw cancellation();
          current.connected = true;
        } catch (error) {
          current.connected = false; current.controller.abort();
          await current.client.close().catch(() => undefined); await current.managed?.cleanup().catch(() => undefined);
          if (this.connections.get(key) === current) this.connections.delete(key);
          throw error;
        }
      })();
      connection = current;
    }
    await interruptible(connection.ready, signal);
    if (!connection.connected) throw new McpFailure('MCP connection is closed.');
    return connection;
  }
  async discover(id: string, projectId: string, external?: AbortSignal): Promise<McpConnectionReport> {
    const started = Date.now();
    const operation = this.begin(id, projectId, external);
    const timer = setTimeout(() => { void this.disconnectKey(operation.key); }, this.options.authProvider ? 5 * 60_000 : this.timeout);
    try {
      const { server, project } = await this.context(id, projectId);
      const signature = fingerprint(server, project);
      const connection = await this.acquire(server, project, operation.signal);
      const result = await connection.client.listTools(undefined, { ...this.requestOptions(operation.signal), cacheMode: 'refresh' });
      const tools = normalizeTools(result.tools, connection.secrets);
      const saved = await this.store.mutate(state => {
        const current = requireItem(state.mcpServers ?? [], id, 'MCP server');
        const currentProject = requireItem(state.projects, projectId, 'Project');
        if (operation.signal.aborted || fingerprint(current, currentProject) !== signature) throw new McpFailure('MCP settings changed during discovery. Retry the connection check.');
        current.enabledTools = current.enabledTools.filter(name => tools.some(tool => tool.name === name && canonical(tool.inputSchema) === canonical(current.tools.find(previous => previous.name === name)?.inputSchema)));
        current.tools = tools; current.checkedAt = new Date().toISOString();
        return current;
      });
      connection.signature = fingerprint(saved, project);
      this.callbacks.emit({ type: 'refresh' });
      return { serverId: id, projectId, ok: true, message: `Подключение установлено. Найдено инструментов: ${tools.length}. Включите те, которые хотите использовать.`, tools, checkedAt: saved.checkedAt!, latencyMs: Date.now() - started };
    } catch (error) {
      const message = failure(error, operation.signal.aborted);
      await this.disconnectKey(operation.key);
      return { serverId: id, projectId, ok: false, message, tools: [], checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    } finally { clearTimeout(timer); operation.finish(); }
  }
  async catalog(project: Project, signal?: AbortSignal): Promise<ToolDefinition[]> {
    if (signal?.aborted) throw cancellation();
    const state = await this.store.read();
    await this.reconcile(state);
    const current = requireItem(state.projects, project.id, 'Project');
    if (projectRights(current) !== projectRights(project)) throw new McpFailure('Project access changed. Refresh MCP tools before proceeding.');
    const tools: ToolDefinition[] = [];
    for (const server of state.mcpServers ?? []) {
      if (!server.enabled || !server.projectIds.includes(project.id) || (server.transport === 'http' && !project.internet && !loopback(endpoint(server.url)))) continue;
      for (const tool of server.tools) if (server.enabledTools.includes(tool.name)) tools.push(definition(server, tool));
    }
    if (tools.length > PROJECT_TOOL_LIMIT) throw new McpFailure(`This project enables more than ${PROJECT_TOOL_LIMIT} MCP tools. Disable some tools before starting the task.`);
    return tools;
  }
  private async mode(context: ToolContext, expected?: AgentMode): Promise<AgentMode> {
    const session = requireItem((await this.store.read()).sessions, validId(context.sessionId), 'Session');
    if (session.projectId !== context.project.id) throw new McpFailure('MCP session does not belong to this project.');
    const current = agentMode(session.mode);
    if ((context.mode !== undefined && agentMode(context.mode) !== current) || (expected !== undefined && current !== expected)) throw new McpFailure('Chat mode changed. Restart the MCP tool call.');
    if (current === 'plan') throw new McpFailure('Plan mode cannot execute MCP tools.');
    return current;
  }
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (context.readOnly) return { text: 'Read-only delegated context cannot execute MCP tools.', error: true };
    const state = await this.store.read();
    const owner = state.mcpServers?.find(server => server.tools.some(tool => toolName(server.id, tool.name) === call.name));
    if (!owner) return { text: 'MCP tool is unknown or its server was removed.', error: true };
    let operation: ReturnType<McpManager['begin']>;
    try { operation = this.begin(owner.id, context.project.id, context.signal, context.sessionId); }
    catch (error) { return { text: failure(error), error: true }; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const mode = await this.mode(context);
      const initial = await this.context(owner.id, context.project.id, context.project, context.sessionId);
      const tool = initial.server.tools.find(tool => toolName(owner.id, tool.name) === call.name)!;
      if (!initial.server.enabled || !initial.server.enabledTools.includes(tool.name)) throw new McpFailure('MCP server or tool is disabled.');
      if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || canonical(call.arguments).length > 8000) throw new McpFailure('MCP tool arguments are invalid or exceed the 8000-character approval limit.');
      const signature = fingerprint(initial.server, initial.project);
      if (operation.signal.aborted) throw cancellation();
      const secrets = await interruptible(this.resolveSecrets(initial.server), operation.signal);
      const destination = initial.server.transport === 'http' ? `Endpoint: ${initial.server.url}` : `Executable: ${initial.server.command}`;
      const description = redact(`Server: ${initial.server.name}\n${destination}\nTool: ${tool.name}\nArguments: ${JSON.stringify(call.arguments)}\n${tool.readOnlyHint ? 'The server claims this tool is read-only. This hint is untrusted; approval is required.' : 'The tool can perform actions with the server permissions.'}`, secrets);
      const approved = mode === 'bypass' || await interruptible(this.callbacks.approve({ id: randomUUID(), sessionId: context.sessionId, projectId: context.project.id, kind: 'mcp', title: redact(`Call MCP tool: ${initial.server.name}`, secrets), description }, operation.signal), operation.signal);
      if (!approved) throw new McpFailure('MCP tool call was declined.');
      const current = await this.context(owner.id, context.project.id, context.project, context.sessionId);
      await this.mode(context, mode);
      if (operation.signal.aborted) throw cancellation();
      if (fingerprint(current.server, current.project) !== signature) throw new McpFailure('MCP settings changed while awaiting approval. Restart the tool call.');
      timer = setTimeout(() => { void this.disconnectKey(operation.key); }, this.timeout);
      const connection = await this.acquire(current.server, current.project, operation.signal, context.sessionId, secrets);
      const listed = await connection.client.listTools(undefined, { ...this.requestOptions(operation.signal), cacheMode: 'refresh' });
      const actual = normalizeTools(listed.tools, connection.secrets).find(item => item.name === tool.name);
      if (!actual || canonical(actual.inputSchema) !== canonical(tool.inputSchema)) throw new McpFailure('MCP tool schema changed. Discover and enable it again before using it.');
      try { validateToolArguments({ parameters: actual.inputSchema as Record<string, unknown> }, call.arguments); }
      catch { throw new McpFailure('MCP tool arguments do not match the advertised schema. No tool action was performed.'); }
      const final = await this.context(owner.id, context.project.id, context.project, context.sessionId);
      await this.mode(context, mode);
      if (fingerprint(final.server, final.project) !== signature || operation.signal.aborted) throw new McpFailure('MCP access changed before execution. Restart the tool call.');
      const result = await connection.client.callTool({ name: tool.name, arguments: call.arguments }, this.requestOptions(operation.signal));
      return renderResult(result as Record<string, unknown>, connection.secrets);
    } catch (error) {
      const message = failure(error, operation.signal.aborted);
      await this.disconnectKey(operation.key);
      return { text: message, error: true };
    } finally { if (timer) clearTimeout(timer); operation.finish(); }
  }
  async status(id: string, projectId: string): Promise<McpConnectionStatus> {
    await this.reconcile(await this.store.read());
    return { serverId: id, projectId, connected: [...this.connections.values()].some(connection => connection.serverId === id && connection.projectId === projectId && connection.connected) };
  }
  private async release(connection: Connection): Promise<void> {
    connection.closing ??= (async () => {
      connection.controller.abort(); connection.connected = false;
      if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key);
      await connection.client.close().catch(() => undefined);
      await connection.ready.catch(() => undefined);
      await connection.managed?.cleanup().catch(() => undefined);
    })();
    await connection.closing;
  }
  async disconnect(id: string, projectId?: string): Promise<void> {
    const matches = (key: string) => key.startsWith(projectId ? `${id}:${projectId}:` : `${id}:`);
    for (const operation of this.operations) if (matches(operation.key)) operation.controller.abort();
    await Promise.all([...this.connections.values()].filter(connection => matches(connection.key)).map(connection => this.release(connection)));
  }
  private async disconnectKey(key: string): Promise<void> {
    for (const operation of this.operations) if (operation.key === key) operation.controller.abort();
    const connection = this.connections.get(key);
    if (connection) await this.release(connection);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.operations) operation.controller.abort();
    await Promise.all([...this.connections.values()].map(connection => this.release(connection)));
  }
}
