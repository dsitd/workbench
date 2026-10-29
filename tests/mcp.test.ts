import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices, sandboxAvailable } from '../src/backend';
import { McpManager, type McpManagerOptions } from '../src/backend/mcp';
import { ProcessTransport, type StdioLaunch } from '../src/backend/mcp/stdio';
import { endpoint, toolName } from '../src/backend/mcp/safety';
import { originFetch } from '../src/backend/mcp/http';
import type { ApprovalRequest, McpServerConfig, ToolCall, ToolContext } from '../src/shared/types';

const echo = { name: 'echo', description: 'Local echo fixture.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } };
type FixtureTool = typeof echo;
const blank: Omit<McpServerConfig, 'id' | 'name' | 'url' | 'projectIds'> = { transport: 'http', enabled: true, command: '', args: [], envNames: [], bearerTokenEnv: '', enabledTools: [], tools: [] };
async function setup(t: { after(callback: () => Promise<void>): void }, approve: (request: ApprovalRequest) => Promise<boolean> = async () => true, options: McpManagerOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-mcp-')));
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const services = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => undefined });
  await services.bootstrap();
  const project = await services.createProject({ name: 'MCP fixture', folders: [{ path: projectRoot, access: 'write' }], internet: false });
  const session = await services.createSession(project.id, 'demo');
  const approvals: ApprovalRequest[] = [];
  const secrets = { bearerToken: 'fixture-bearer-not-a-real-secret', env: {} as Record<string, string> };
  let resolutions = 0;
  const manager = new McpManager(services.store, { approve: async request => { approvals.push(request); return approve(request); }, emit: () => undefined }, async () => { resolutions++; return secrets; }, options);
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const context: ToolContext = { project, sessionId: session.id, signal: new AbortController().signal };
  return { root, projectRoot, services, project, session, manager, approvals, secrets, context, resolutions: () => resolutions };
}
async function localHttp(t: { after(callback: () => Promise<void>): void }) {
  const tools: FixtureTool[] = [structuredClone(echo)];
  const methods: string[] = [];
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  let mode = 'normal';
  let callResult: Record<string, unknown> | undefined;
  let beforeList: (() => Promise<void>) | undefined;
  const pending = new Map<string, ServerResponse>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    methods.push(message.method);
    if (mode === 'redirect') { response.writeHead(307, { location: '/elsewhere' }).end(); return; }
    if (mode === 'oversized') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 3 * 1024 * 1024 }).end(); return; }
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: Record<string, unknown>;
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-http-fixture', version: '1.0.0' } };
    else if (message.method === 'tools/list') { await beforeList?.(); result = { tools }; }
    else if (message.method === 'tools/call') {
      calls.push(message.params);
      if (mode === 'pending' || message.params.arguments?.value === 'hold') { pending.set(message.params.arguments?.value ?? 'pending', response); return; }
      result = callResult ?? { content: [{ type: 'text', text: `echo:${message.params.arguments?.value}` }], structuredContent: { value: message.params.arguments?.value } };
    } else { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture method unavailable.' } })); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${address.port}/mcp`, tools, methods, calls, pending, beforeList: (callback: () => Promise<void>) => { beforeList = callback; }, mode: (value: string) => { mode = value; }, result: (value: Record<string, unknown>) => { callResult = value; } };
}
async function discoverAndEnable(manager: McpManager, projectId: string, url: string, id = 'fixture') {
  let saved = await manager.saveServer({ ...blank, id, name: 'Local MCP fixture', url, projectIds: [projectId] });
  const report = await manager.discover(saved.id, projectId);
  assert.equal(report.ok, true, report.message);
  assert.deepEqual((await manager.listServers()).find(server => server.id === id)!.enabledTools, []);
  saved = (await manager.listServers()).find(server => server.id === id)!;
  return manager.saveServer({ ...saved, enabledTools: saved.tools.map(tool => tool.name).slice(0, 64) });
}
function call(server: McpServerConfig, value = 'hello'): ToolCall { return { id: 'mcp-call', name: toolName(server.id, 'echo'), arguments: { value } }; }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= end) throw new Error('Local fixture did not reach the expected state.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('HTTP discovery is explicit, tool catalog is cached, and enabled tools execute only after approval', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const saved = await fixture.manager.saveServer({ ...blank, id: 'fixture', name: 'Local MCP fixture', url: http.url, projectIds: [fixture.project.id] });
  assert.deepEqual(http.methods, []);
  assert.deepEqual(await fixture.manager.catalog(fixture.project), []);
  assert.equal(fixture.resolutions(), 0);
  const report = await fixture.manager.discover(saved.id, fixture.project.id);
  assert.equal(report.ok, true, report.message);
  assert.equal(report.tools[0].name, 'echo');
  assert.deepEqual((await fixture.manager.listServers())[0].enabledTools, []);
  assert.equal((await fixture.manager.status(saved.id, fixture.project.id)).connected, true);
  assert.deepEqual(await fixture.manager.catalog(fixture.project), []);
  const enabled = await fixture.manager.saveServer({ ...(await fixture.manager.listServers())[0], enabledTools: ['echo'] });
  const count = http.methods.length;
  const catalog = await fixture.manager.catalog(fixture.project);
  assert.equal(http.methods.length, count);
  assert.equal(catalog[0].permission, 'mcp');
  assert.equal(catalog[0].source?.toolName, 'echo');
  assert.match(catalog[0].name, /^[A-Za-z0-9_]{1,64}$/);
  const result = await fixture.manager.execute(call(enabled), fixture.context);
  assert.equal(result.error, undefined, result.text);
  assert.match(result.text, /echo:hello/);
  assert.equal(http.calls.length, 1);
  assert.equal(fixture.approvals.length, 1);
  assert.equal(fixture.approvals[0].kind, 'mcp');
  assert.match(fixture.approvals[0].description, /Arguments:.*hello/);
  assert.match(fixture.approvals[0].description, /Endpoint: http:\/\/127\.0\.0\.1/);
  assert.match(fixture.approvals[0].description, /untrusted/);
});

test('declining a read-only MCP tool does not connect or execute the server', async t => {
  const fixture = await setup(t, async () => false);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  http.methods.length = 0;
  const result = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(result.error, true);
  assert.match(result.text, /declined/);
  assert.deepEqual(http.methods, []);
  assert.equal(http.calls.length, 0);
});

test('Plan rejects even read-only MCP tools before vault resolution, approval or a connection', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  await fixture.services.updateSession(fixture.session.id, { mode: 'plan' });
  http.methods.length = 0;
  const resolutions = fixture.resolutions();
  const result = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(result.error, true); assert.match(result.text, /Plan mode/);
  assert.equal(fixture.resolutions(), resolutions);
  assert.equal(fixture.approvals.length, 0);
  assert.deepEqual(http.methods, []); assert.deepEqual(http.calls, []);
});

test('readonly delegation rejects MCP calls before vault resolution, approval or a connection even in Bypass', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  http.methods.length = 0;
  const resolutions = fixture.resolutions();
  const result = await fixture.manager.execute(call(server), { ...fixture.context, mode: 'bypass', readOnly: true });
  assert.equal(result.error, true); assert.match(result.text, /Read-only delegated/);
  assert.equal(fixture.resolutions(), resolutions); assert.equal(fixture.approvals.length, 0);
  assert.deepEqual(http.methods, []); assert.deepEqual(http.calls, []);
});

test('MCP bypass requires the stored chat mode and Ask still requests approval', async t => {
  const fixture = await setup(t, async () => false);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  await fixture.services.store.mutate(state => { delete state.sessions.find(session => session.id === fixture.session.id)!.mode; });
  http.methods.length = 0;
  const forged = await fixture.manager.execute(call(server), { ...fixture.context, mode: 'bypass' });
  assert.equal(forged.error, true); assert.match(forged.text, /Chat mode changed/);
  assert.equal(fixture.approvals.length, 0); assert.deepEqual(http.methods, []);
  await fixture.services.updateSession(fixture.session.id, { mode: 'ask' });
  const ask = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(ask.error, true); assert.match(ask.text, /declined/);
  assert.equal(fixture.approvals.length, 1); assert.deepEqual(http.methods, []);
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  const stale = await fixture.manager.execute(call(server), { ...fixture.context, mode: 'ask' });
  assert.equal(stale.error, true); assert.match(stale.text, /Chat mode changed/);
  const bypass = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(bypass.error, undefined, bypass.text); assert.match(bypass.text, /echo:hello/);
  assert.equal(fixture.approvals.length, 1); assert.equal(http.calls.length, 1);
});

test('MCP bypass retains manual enablement, project assignment and current schema checks', async t => {
  const fixture = await setup(t, async () => { throw new Error('Bypass must not request approval.'); });
  const http = await localHttp(t);
  let server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  server = await fixture.manager.saveServer({ ...server, enabledTools: [] });
  http.methods.length = 0;
  const disabled = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(disabled.error, true); assert.match(disabled.text, /disabled/);
  assert.deepEqual(http.methods, []);
  server = await fixture.manager.saveServer({ ...server, enabledTools: ['echo'] });
  const other = await fixture.services.createProject({ name: 'Other', folders: [{ path: fixture.projectRoot, access: 'read' }] });
  const foreign = await fixture.services.createSession(other.id, 'demo');
  await fixture.services.updateSession(foreign.id, { mode: 'bypass' });
  const unassigned = await fixture.manager.execute(call(server), { ...fixture.context, project: other, sessionId: foreign.id });
  assert.equal(unassigned.error, true); assert.match(unassigned.text, /not assigned/);
  http.tools[0].inputSchema.properties.value.type = 'number';
  const changedSchema = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(changedSchema.error, true); assert.match(changedSchema.text, /schema changed/);
  assert.equal(http.calls.length, 0); assert.equal(fixture.approvals.length, 0);
});

test('MCP Bypass cannot override disabled project internet even for a previously enabled remote tool', async t => {
  let requests = 0;
  const fixture = await setup(t, async () => false, { fetch: async (_input, init) => {
    requests++;
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-only-remote', version: '1.0.0' } }
      : { tools: [echo] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  } });
  const online = await fixture.services.saveProject({ ...fixture.project, internet: true });
  const server = await discoverAndEnable(fixture.manager, online.id, 'https://mock-only.example.test/mcp');
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  const offline = await fixture.services.saveProject({ ...online, internet: false });
  const count = requests;
  const resolutions = fixture.resolutions();
  const result = await fixture.manager.execute(call(server), { ...fixture.context, project: offline });
  assert.equal(result.error, true); assert.match(result.text, /Internet access is disabled/);
  assert.equal(requests, count); assert.equal(fixture.resolutions(), resolutions);
  assert.equal(fixture.approvals.length, 0);
});

test('a mode change while awaiting MCP approval revokes execution before connecting', async t => {
  let answer!: (value: boolean) => void;
  const fixture = await setup(t, () => new Promise(resolve => { answer = resolve; }));
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  http.methods.length = 0;
  const running = fixture.manager.execute(call(server), { ...fixture.context, mode: 'auto-edit' });
  await waitFor(() => fixture.approvals.length === 1);
  await fixture.services.updateSession(fixture.session.id, { mode: 'plan' });
  answer(true);
  const result = await running;
  assert.equal(result.error, true); assert.match(result.text, /Chat mode changed/);
  assert.deepEqual(http.methods, []); assert.equal(http.calls.length, 0);
});

test('Bypass revalidates stored mode after asynchronous MCP schema refresh', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  http.beforeList(async () => { entered = true; await gate; });
  const running = fixture.manager.execute(call(server), fixture.context);
  await waitFor(() => entered);
  await fixture.services.updateSession(fixture.session.id, { mode: 'plan' });
  release();
  const result = await running;
  assert.equal(result.error, true); assert.match(result.text, /Chat mode changed/);
  assert.equal(fixture.approvals.length, 0); assert.equal(http.calls.length, 0);
});

test('configuration mutations preserve catalog controls, reject missing projects, and never store supplied secrets', async t => {
  const { manager, project, services } = await setup(t);
  const http = await localHttp(t);
  await assert.rejects(manager.saveServer({ ...blank, id: 'fixture', name: 'Fixture', url: http.url, projectIds: ['deleted-project'] }), /assignment/);
  await assert.rejects(manager.saveServer({ ...blank, id: 'fixture', name: 'Fixture', url: http.url, projectIds: [project.id], envNames: ['NODE_OPTIONS'] }), /reserved/);
  await assert.rejects(manager.saveServer({ ...blank, id: 'fixture', name: 'Fixture', url: http.url, projectIds: [project.id], enabledTools: ['echo'], tools: [echo] }), /Discover/);
  const input = { ...blank, id: 'fixture', name: 'Fixture', url: http.url, projectIds: [project.id], hasToken: true, secretNames: ['FAKE_TOKEN'], bearerToken: 'fixture-value-not-a-real-secret', env: { FAKE_TOKEN: 'fixture-value-not-a-real-secret' } };
  const saved = await manager.saveServer(input);
  assert.equal(saved.hasToken, undefined); assert.equal(saved.secretNames, undefined);
  const state = await readFile(path.join(services.store.directory, 'workspace.json'), 'utf8');
  assert.equal(state.includes('fixture-value-not-a-real-secret'), false);
  assert.equal((await manager.listServers()).length, 1);
});

test('MCP tools and sessions cannot cross project boundaries', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  const other = await fixture.services.createProject({ name: 'Other', folders: [{ path: fixture.projectRoot, access: 'read' }] });
  assert.deepEqual(await fixture.manager.catalog(other), []);
  const result = await fixture.manager.execute(call(server), { ...fixture.context, project: other });
  assert.equal(result.error, true);
  const foreign = await fixture.services.createSession(other.id, 'demo');
  assert.equal((await fixture.manager.execute(call(server), { ...fixture.context, sessionId: foreign.id })).error, true);
  assert.equal(http.calls.length, 0);
  assert.equal(fixture.approvals.length, 0);
});

test('approval revalidates current project rights and does not execute a stale configuration', async t => {
  let answer!: (value: boolean) => void;
  const fixture = await setup(t, () => new Promise(resolve => { answer = resolve; }));
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  const pending = fixture.manager.execute(call(server), fixture.context);
  await waitFor(() => fixture.approvals.length === 1);
  await fixture.services.store.mutate(state => { state.projects[0].folders[0].access = 'read'; });
  answer(true);
  const result = await pending;
  assert.equal(result.error, true);
  assert.match(result.text, /access changed/);
  assert.equal(http.calls.length, 0);
});

test('changed remote tool schemas invalidate the saved permission before execution', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  http.tools[0].inputSchema.properties.value.type = 'number';
  const result = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(result.error, true);
  assert.match(result.text, /schema changed/);
  assert.equal(http.calls.length, 0);
  const rediscovered = await fixture.manager.discover(server.id, fixture.project.id);
  assert.equal(rediscovered.ok, true, rediscovered.message);
  assert.deepEqual((await fixture.manager.listServers())[0].enabledTools, []);
});

test('retargeting a selected project folder through a symlink blocks MCP before approval', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);
  await rename(fixture.projectRoot, `${fixture.projectRoot}-original`);
  await symlink(outside, fixture.projectRoot);
  const result = await fixture.manager.execute(call(server), fixture.context);
  assert.equal(result.error, true); assert.match(result.text, /folder identity changed/);
  assert.equal(http.calls.length, 0); assert.equal(fixture.approvals.length, 0);
});

test('MCP outputs redact known credentials, respect isError and omit binary payloads', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  http.result({ isError: true, content: [{ type: 'text', text: `failed ${fixture.secrets.bearerToken} api_key=placeholder-test-value` }, { type: 'image', data: 'a'.repeat(50_000), mimeType: 'image/png' }], structuredContent: { tokenEcho: fixture.secrets.bearerToken } });
  const result = await fixture.manager.execute(call(server, fixture.secrets.bearerToken), fixture.context);
  assert.equal(result.error, true);
  assert.match(result.text, /credential redacted/);
  assert.match(result.text, /binary payload omitted/);
  assert.equal(result.text.includes(fixture.secrets.bearerToken), false);
  assert.equal(result.text.includes('placeholder-test-value'), false);
  assert.equal(fixture.approvals[0].description.includes(fixture.secrets.bearerToken), false);
  http.result({ content: [{ type: 'text', text: 'x'.repeat(90_000) }] });
  assert.equal((await fixture.manager.execute(call(server), fixture.context)).text.length, 90_000);
});

test('one stopped chat does not cancel another chat using the same MCP server and project', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  const second = await fixture.services.createSession(fixture.project.id, 'demo');
  const controller = new AbortController();
  const held = fixture.manager.execute(call(server, 'hold'), { ...fixture.context, signal: controller.signal });
  await waitFor(() => http.pending.has('hold'));
  const active = fixture.manager.execute(call(server, 'second-chat'), { ...fixture.context, sessionId: second.id });
  controller.abort();
  assert.equal((await held).error, true);
  const successful = await active;
  assert.equal(successful.error, undefined, successful.text);
  assert.match(successful.text, /second-chat/);
  assert.equal((await fixture.manager.status(server.id, fixture.project.id)).connected, true);
});

test('disconnect and timeout bound pending tool calls and close project connections', async t => {
  const fixture = await setup(t, async () => true, { timeoutMs: 300 });
  const http = await localHttp(t);
  const server = await discoverAndEnable(fixture.manager, fixture.project.id, http.url);
  const pending = fixture.manager.execute(call(server, 'hold'), fixture.context);
  await waitFor(() => http.pending.has('hold'));
  await fixture.manager.disconnect(server.id, fixture.project.id);
  assert.equal((await pending).error, true);
  assert.equal((await fixture.manager.status(server.id, fixture.project.id)).connected, false);
  const started = Date.now();
  http.mode('pending');
  assert.equal((await fixture.manager.execute(call(server, 'timeout'), fixture.context)).error, true);
  assert.ok(Date.now() - started < 1500);
});

test('HTTP policy denies credential URLs, external HTTP and redirects without contacting external services', async t => {
  for (const url of ['https://user:pass@example.test/mcp', 'https://example.test/mcp?api_key=placeholder', 'https://example.test/mcp#token', 'http://192.168.1.2/mcp', 'http://example.test/mcp']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://127.0.0.1:1234/mcp').hostname, '127.0.0.1');
  assert.equal(endpoint('https://192.168.1.2/mcp').hostname, '192.168.1.2');
  let fetched = 0;
  const configured = endpoint('https://local-fixture.example.test/mcp');
  const guarded = originFetch(configured, new AbortController().signal, async () => { fetched++; return new Response('{}'); });
  await assert.rejects(guarded('https://other.example.test/mcp'), /configured endpoint/);
  await assert.rejects(guarded('https://local-fixture.example.test/other'), /configured endpoint/);
  assert.equal(fetched, 0);
  const fixture = await setup(t);
  const remote = await fixture.manager.saveServer({ ...blank, id: 'remote', name: 'Remote', url: configured.href, projectIds: [fixture.project.id] });
  const denied = await fixture.manager.discover(remote.id, fixture.project.id);
  assert.equal(denied.ok, false); assert.match(denied.message, /Internet access is disabled/);
  assert.equal(fixture.resolutions(), 0);
  const http = await localHttp(t); http.mode('redirect');
  const redirect = await fixture.manager.saveServer({ ...blank, id: 'redirect', name: 'Redirect', url: http.url, projectIds: [fixture.project.id] });
  assert.equal((await fixture.manager.discover(redirect.id, fixture.project.id)).ok, false);
  assert.equal(http.methods.length, 1);
});

test('MCP discovery and project tool counts fail explicitly instead of silently omitting tools', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t);
  http.tools.splice(0, 1, ...Array.from({ length: 129 }, (_, index) => ({ ...structuredClone(echo), name: `tool_${index}` })));
  const oversized = await fixture.manager.saveServer({ ...blank, id: 'oversized', name: 'Oversized', url: http.url, projectIds: [fixture.project.id] });
  const report = await fixture.manager.discover(oversized.id, fixture.project.id);
  assert.equal(report.ok, false); assert.match(report.message, /128 tools/);
  await fixture.manager.deleteServer(oversized.id);
  http.tools.splice(40);
  await discoverAndEnable(fixture.manager, fixture.project.id, http.url, 'first');
  await discoverAndEnable(fixture.manager, fixture.project.id, http.url, 'second');
  await assert.rejects(fixture.manager.catalog(fixture.project), /more than 64.*Disable/);
});

test('HTTP response size limits and raw transport errors do not leak arbitrary server output', async t => {
  const fixture = await setup(t);
  const http = await localHttp(t); http.mode('oversized');
  const saved = await fixture.manager.saveServer({ ...blank, id: 'oversized-response', name: 'Oversized', url: http.url, projectIds: [fixture.project.id] });
  assert.equal((await fixture.manager.discover(saved.id, fixture.project.id)).ok, false);
  const raw = new McpManager(fixture.services.store, { approve: async () => true, emit: () => undefined }, async () => fixture.secrets, { fetch: async () => { throw new Error(`untrusted error ${fixture.secrets.bearerToken}`); } });
  t.after(() => raw.close());
  const report = await raw.discover(saved.id, fixture.project.id);
  assert.equal(report.ok, false); assert.equal(report.message.includes(fixture.secrets.bearerToken), false); assert.equal(report.message.includes('untrusted error'), false);
});

async function stdioFixture(directory: string, sentinel: string, outside: string, privateRoot: string, readonly: string) {
  const file = path.join(directory, 'fixture-server.mjs');
  const source = `import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const locations = ${JSON.stringify({ sentinel, outside, privateRoot, readonly })};
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('grandchild.pid', String(grandchild.pid));
const tool = ${JSON.stringify(echo)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const readable = file => { try { readFileSync(file); return true; } catch { return false; } };
const writable = file => { try { writeFileSync(file, 'fixture write'); return true; } catch { return false; } };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 'fixture-roots' && message.result) { writeFileSync('roots.json', JSON.stringify(message.result.roots)); return; }
  if (message.method === 'notifications/initialized') { send({ jsonrpc: '2.0', id: 'fixture-roots', method: 'roots/list' }); return; }
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-stdio-fixture', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools: [tool] };
  else if (message.method === 'tools/call') {
    if (message.params.arguments.value === 'hold') return;
    const value = message.params.arguments.value === 'inspect' ? JSON.stringify({
      sentinelInherited: Object.hasOwn(process.env, locations.sentinel),
      declared: process.env.FIXTURE_AUTH,
      outsideRead: readable(locations.outside + '/known.txt'), outsideWrite: writable(locations.outside + '/created.txt'),
      privateRead: readable(locations.privateRoot + '/workspace.json'), privateWrite: writable(locations.privateRoot + '/forbidden.txt'),
      readonlyWrite: writable(locations.readonly + '/forbidden.txt'), envRead: readable('.env'),
      scopedWrite: writable('scoped-result.txt')
    }) : message.params.arguments.value;
    result = { content: [{ type: 'text', text: value }] };
  } else return;
  send({ jsonrpc: '2.0', id: message.id, result });
});
process.stderr.write('Untrusted fixture stderr must never appear in reports.\\n');
`;
  await writeFile(file, source);
  return file;
}

test('stdio protocol uses isolated HOME, only declared secrets, and kills the complete process group on disconnect', async t => {
  let launch: StdioLaunch | undefined;
  let cleanups = 0;
  const fixture = await setup(t, async () => true, { stdioFactory: async current => { launch = current; return { transport: new ProcessTransport(current), cleanup: async () => { cleanups++; } }; } });
  const sentinel = `WORKBENCH_MCP_FIXTURE_${Date.now()}`;
  process.env[sentinel] = 'known-non-secret-sentinel';
  t.after(async () => { delete process.env[sentinel]; });
  const outside = path.join(fixture.root, 'outside'); const readonly = path.join(fixture.projectRoot, 'reference');
  await Promise.all([mkdir(outside), mkdir(readonly)]);
  const script = await stdioFixture(fixture.projectRoot, sentinel, outside, fixture.services.store.directory, readonly);
  fixture.secrets.env = { FIXTURE_AUTH: 'fixture-env-not-a-real-secret' };
  let saved = await fixture.manager.saveServer({ ...blank, id: 'stdio-fixture', name: 'Stdio fixture', transport: 'stdio', command: process.execPath, args: [script], url: '', envNames: ['FIXTURE_AUTH'], projectIds: [fixture.project.id] });
  const report = await fixture.manager.discover(saved.id, fixture.project.id);
  assert.equal(report.ok, true, report.message);
  assert.ok(launch); assert.equal(launch.env[sentinel], undefined); assert.equal(launch.env.FIXTURE_AUTH, fixture.secrets.env.FIXTURE_AUTH);
  assert.ok(launch.env.HOME.startsWith(path.join(fixture.services.store.directory, 'mcp-scratch')));
  assert.match(launch.profile, /\(deny default\)/);
  assert.match(launch.profile, /\(deny file-read\*/);
  assert.doesNotMatch(launch.profile, /\(allow network-outbound\)/);
  const pid = Number(await readFile(path.join(fixture.projectRoot, 'grandchild.pid'), 'utf8'));
  await fixture.manager.disconnect(saved.id, fixture.project.id);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal((await fixture.manager.status(saved.id, fixture.project.id)).connected, false);
  assert.equal(cleanups, 1);
  await assert.rejects(readFile(path.join(launch.scratch, 'home', 'anything')), { code: 'ENOENT' });
  saved = await fixture.manager.saveServer({ ...(await fixture.manager.listServers())[0], enabledTools: ['echo'] });
  const result = await fixture.manager.execute(call(saved), fixture.context);
  assert.equal(result.error, undefined, result.text);
  await waitFor(async () => { try { return JSON.parse(await readFile(path.join(fixture.projectRoot, 'roots.json'), 'utf8')).length === 1; } catch { return false; } });
  const roots = JSON.parse(await readFile(path.join(fixture.projectRoot, 'roots.json'), 'utf8'));
  assert.equal(roots[0].uri, new URL(`file://${fixture.projectRoot}`).href);
});

test('stdio fails closed when the macOS sandbox is unavailable', async t => {
  if (await sandboxAvailable()) { t.skip('Actual sandbox is available; covered by the next acceptance test.'); return; }
  const fixture = await setup(t);
  const server = await fixture.manager.saveServer({ ...blank, id: 'stdio-disabled', name: 'Disabled fixture', transport: 'stdio', command: process.execPath, args: ['--version'], url: '', projectIds: [fixture.project.id] });
  const report = await fixture.manager.discover(server.id, fixture.project.id);
  assert.equal(report.ok, false); assert.match(report.message, /sandbox is unavailable/);
  assert.equal((await fixture.manager.status(server.id, fixture.project.id)).connected, false);
});

test('close waits for pending stdio setup cleanup and does not launch a late process', async t => {
  let launch: StdioLaunch | undefined;
  let release!: () => void;
  let started = 0;
  let cleaned = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup(t, async () => true, { stdioFactory: async current => {
    launch = current; await gate;
    const transport = new ProcessTransport(current);
    const start = transport.start.bind(transport);
    transport.start = async () => { started++; return start(); };
    return { transport, cleanup: async () => { cleaned++; } };
  } });
  const server = await fixture.manager.saveServer({ ...blank, id: 'pending-stdio', name: 'Pending fixture', transport: 'stdio', command: process.execPath, args: ['--version'], url: '', projectIds: [fixture.project.id] });
  const discovery = fixture.manager.discover(server.id, fixture.project.id);
  await waitFor(() => Boolean(launch));
  const closed = fixture.manager.close();
  release();
  await closed;
  assert.equal((await discovery).ok, false);
  assert.equal(started, 0); assert.equal(cleaned, 1);
  await assert.rejects(realpath(launch!.scratch), { code: 'ENOENT' });
});

test('actual macOS MCP Bypass preserves sandbox denial of outside, read-only, appdata and protected fixture files', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run from ordinary macOS Terminal to exercise sandbox-exec.'); return; }
  const fixture = await setup(t, async () => false);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-mcp-outside-'))); const readonly = path.join(fixture.projectRoot, 'reference');
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(readonly);
  await writeFile(path.join(outside, 'known.txt'), 'known non-secret outside fixture');
  await writeFile(path.join(fixture.root, '.env'), 'PLACEHOLDER=not-a-real-secret');
  const project = await fixture.services.saveProject({ ...fixture.project, folders: [{ path: fixture.root, access: 'write' }, { path: readonly, access: 'read' }] });
  const script = await stdioFixture(fixture.projectRoot, 'WORKBENCH_MCP_UNKNOWN_SENTINEL', outside, fixture.services.store.directory, readonly);
  fixture.secrets.env = { FIXTURE_AUTH: 'fixture-env-not-a-real-secret' };
  let server = await fixture.manager.saveServer({ ...blank, id: 'actual-stdio', name: 'Actual macOS fixture', transport: 'stdio', command: process.execPath, args: [script], url: '', envNames: ['FIXTURE_AUTH'], projectIds: [project.id] });
  const report = await fixture.manager.discover(server.id, project.id);
  assert.equal(report.ok, true, report.message);
  server = await fixture.manager.saveServer({ ...(await fixture.manager.listServers())[0], enabledTools: ['echo'] });
  await fixture.services.updateSession(fixture.session.id, { mode: 'bypass' });
  const result = await fixture.manager.execute(call(server, 'inspect'), { ...fixture.context, project });
  assert.equal(result.error, undefined, result.text);
  assert.equal(fixture.approvals.length, 0);
  const inspected = JSON.parse(result.text);
  assert.deepEqual(inspected, { sentinelInherited: false, declared: '[credential redacted]', outsideRead: false, outsideWrite: false, privateRead: false, privateWrite: false, readonlyWrite: false, envRead: false, scopedWrite: true });
  assert.equal(await readFile(path.join(fixture.root, 'scoped-result.txt'), 'utf8'), 'fixture write');
  const pid = Number(await readFile(path.join(fixture.root, 'grandchild.pid'), 'utf8'));
  await fixture.manager.disconnect(server.id, project.id);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
