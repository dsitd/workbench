import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { ApprovalBroker } from '../src/main/approvals';
import { createMcpBridge } from '../src/main/mcp';
import { mcpCredentialId, validateMcpSecrets } from '../src/main/mcp-credentials';
import type { CredentialVault } from '../src/main/credentials';
import type { AgentEvent, McpSecretsInput, McpServerConfig } from '../src/shared/types';

const server = (patch: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'fixture-server', name: 'Fixture MCP', transport: 'http', enabled: true,
  projectIds: [], command: '', args: [], url: 'https://mcp.example.test/api',
  envNames: ['FIXTURE_ACCESS'], bearerTokenEnv: '', enabledTools: [], tools: [], ...patch,
});
const fakeBearer = 'artificial-bearer-value-for-tests';
const fakeEnvironment = 'artificial-environment-value-for-tests';

test('MCP credential namespace binds each slot to the exact endpoint or executable and arguments', () => {
  const first = server();
  const firstId = mcpCredentialId(first, 'bearer');
  assert.notEqual(firstId, mcpCredentialId({ ...first, url: 'https://another.example.test/api' }, 'bearer'));
  assert.notEqual(firstId, mcpCredentialId({ ...first, url: first.url + '/different' }, 'bearer'));
  assert.notEqual(firstId, mcpCredentialId({ ...first, id: 'other-server' }, 'bearer'));
  assert.notEqual(firstId, mcpCredentialId(first, 'env:FIXTURE_ACCESS'));
  const process = server({ transport: 'stdio', command: '/usr/bin/fixture', args: ['--mode', 'one'], url: '' });
  assert.notEqual(firstId, mcpCredentialId(process, 'bearer'));
  assert.notEqual(mcpCredentialId(process, 'env:FIXTURE_ACCESS'), mcpCredentialId({ ...process, command: '/usr/bin/other-fixture' }, 'env:FIXTURE_ACCESS'));
  assert.notEqual(mcpCredentialId(process, 'env:FIXTURE_ACCESS'), mcpCredentialId({ ...process, args: ['--mode', 'two'] }, 'env:FIXTURE_ACCESS'));
  assert.notEqual(mcpCredentialId(process, 'bearer'), mcpCredentialId({ ...process, args: ['one', 'two'] }, 'bearer'));
});

test('ordinary project assignments, enabled tools and display metadata preserve credential destination binding', () => {
  const original = server();
  const edited = { ...original, name: 'Renamed', enabled: false, projectIds: ['other-project'], enabledTools: ['lookup'], tools: [{ name: 'lookup', description: 'Updated metadata', inputSchema: { type: 'object' } }], checkedAt: '2030-01-01T00:00:00Z' };
  assert.equal(mcpCredentialId(original, 'bearer'), mcpCredentialId(edited, 'bearer'));
  assert.equal(mcpCredentialId(original, 'env:FIXTURE_ACCESS'), mcpCredentialId(edited, 'env:FIXTURE_ACCESS'));
});

test('MCP secrets require an explicit environment allowlist before any persistence', () => {
  assert.doesNotThrow(() => validateMcpSecrets(server(), { bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment } }));
  assert.throws(() => validateMcpSecrets(server(), { env: { UNDECLARED_ACCESS: fakeEnvironment } }), error => error instanceof Error && error.message.includes('Сначала добавьте имя') && !error.message.includes(fakeEnvironment));
  assert.throws(() => validateMcpSecrets(server({ envNames: [] }), { env: { FIXTURE_ACCESS: fakeEnvironment } }), /Сначала добавьте имя/);
});

test('malformed MCP secret inputs and size limits produce static errors without echoing supplied values', () => {
  const cases: unknown[] = [
    [], fakeBearer,
    { bearerToken: 123 }, { bearerToken: fakeBearer.repeat(1000) },
    { env: null }, { env: [] }, { env: fakeEnvironment },
    { env: { FIXTURE_ACCESS: 123 } }, { env: { FIXTURE_ACCESS: fakeEnvironment.repeat(1000) } },
    { env: { [`BAD\n${fakeEnvironment}`]: fakeEnvironment } },
    { env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`VARIABLE_${index}`, fakeEnvironment])) },
  ];
  for (const input of cases) assert.throws(() => validateMcpSecrets(server(), input as McpSecretsInput), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(fakeBearer));
    assert.ok(!error.message.includes(fakeEnvironment));
    return true;
  });
});

class FixtureVault {
  readonly records = new Map<string, string>();
  readonly removedProfiles: string[] = [];
  has(id: string) { return this.records.has(id); }
  async save(id: string, value: string) { this.records.set(id, value); }
  async removeMcp(id: string) {
    this.removedProfiles.push(id);
    for (const key of this.records.keys()) if (key.startsWith(`mcp:${id}:`)) this.records.delete(key);
  }
  async resolveMcp(configuration: McpServerConfig) {
    return {
      bearerToken: this.records.get(mcpCredentialId(configuration, 'bearer')),
      env: Object.fromEntries(configuration.envNames.flatMap(name => {
        const value = this.records.get(mcpCredentialId(configuration, `env:${name}`));
        return value === undefined ? [] : [[name, value]];
      })),
    };
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function composition(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-main-mcp-')));
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const events: AgentEvent[] = [];
  const broker = new ApprovalBroker(event => events.push(event));
  const workspace = new WorkspaceServices(path.join(root, 'data'), { approve: request => broker.request(request), emit: event => events.push(event) });
  const project = await workspace.createProject({ name: 'Fixture project', folders: [{ path: folder, access: 'write' }], internet: true });
  const vault = new FixtureVault();
  let busy = false;
  const bridge = createMcpBridge(workspace, vault as unknown as CredentialVault, broker, event => events.push(event), () => busy);
  t.after(async () => { broker.cancelAll(); await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  return { workspace, bridge, vault, project, events, setBusy: (value: boolean) => { busy = value; } };
}

/** Local JSON-RPC fixture exercises the actual SDK transport and manager; no cloud API. */
async function localDiscovery(t: TestContext, holdTools?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }) {
  const methods: string[] = [];
  let authorized = 0;
  const http = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization === `Bearer ${fakeBearer}`) authorized++;
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body);
      methods.push(message.method);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      if (message.method === 'tools/list' && holdTools) { holdTools.entered.resolve(); await holdTools.release.promise; }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Local fixture', version: '1.0' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'lookup', description: `Protected fixture values: ${fakeBearer} ${fakeEnvironment}`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] }
          : {};
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    })().catch(() => { response.writeHead(500); response.end('Local fixture failed'); });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/mcp`, methods, authorized: () => authorized };
}

test('main MCP save and real local discovery expose metadata only and never persist provided secrets', async t => {
  const state = await composition(t);
  const local = await localDiscovery(t);
  const input = { ...server({ url: local.url, projectIds: [state.project.id] }), bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment }, hasToken: false, secretNames: [fakeBearer] };
  const saved = await state.bridge.handlers.saveMcpServer(input, { bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment } });
  assert.equal(saved.hasToken, true);
  assert.deepEqual(saved.secretNames, ['FIXTURE_ACCESS']);
  const report = await state.bridge.handlers.testMcpServer(saved.id, state.project.id);
  assert.equal(report.ok, true);
  assert.equal(report.tools.length, 1);
  assert.ok(report.tools[0].description.includes('[credential redacted]'));
  assert.ok(local.authorized() >= 2);
  assert.ok(local.methods.includes('initialize') && local.methods.includes('tools/list'));
  const listed = await state.bridge.handlers.listMcpServers();
  const persisted = await readFile(path.join(state.workspace.store.directory, 'workspace.json'), 'utf8');
  for (const output of [JSON.stringify(saved), JSON.stringify(report), JSON.stringify(listed), persisted, JSON.stringify(state.events)]) {
    assert.ok(!output.includes(fakeBearer)); assert.ok(!output.includes(fakeEnvironment));
  }
  const stored = (await state.workspace.store.read()).mcpServers![0];
  assert.ok(!Object.hasOwn(stored, 'hasToken') && !Object.hasOwn(stored, 'secretNames'));
  assert.equal(stored.tools[0].name, 'lookup');
  const edited = await state.bridge.handlers.saveMcpServer({ ...listed[0], name: 'Renamed', enabled: false, enabledTools: ['lookup'] });
  assert.equal(edited.hasToken, true);
  assert.deepEqual(edited.secretNames, ['FIXTURE_ACCESS']);
});

test('editing an MCP endpoint or executable clears access metadata without transferring stored secrets', async t => {
  const state = await composition(t);
  const saved = await state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment } });
  const changedEndpoint = await state.bridge.handlers.saveMcpServer({ ...saved, url: 'https://different.example.test/mcp' });
  assert.equal(changedEndpoint.hasToken, false); assert.deepEqual(changedEndpoint.secretNames, []);
  assert.deepEqual(await state.vault.resolveMcp(changedEndpoint), { bearerToken: undefined, env: {} });
  assert.ok(state.vault.has(mcpCredentialId(saved, 'bearer')));
  const executable = await state.bridge.handlers.saveMcpServer({ ...changedEndpoint, transport: 'stdio', command: '/usr/bin/fixture', args: ['first'], url: '' }, { env: { FIXTURE_ACCESS: fakeEnvironment } });
  assert.deepEqual(executable.secretNames, ['FIXTURE_ACCESS']);
  const changedCommand = await state.bridge.handlers.saveMcpServer({ ...executable, command: '/usr/bin/different-fixture' });
  assert.deepEqual(changedCommand.secretNames, []);
  assert.deepEqual(await state.vault.resolveMcp(changedCommand), { bearerToken: undefined, env: {} });
  const changedArgs = await state.bridge.handlers.saveMcpServer({ ...executable, args: ['second'] });
  assert.deepEqual(changedArgs.secretNames, []);
});

test('main MCP invalid secret allowlists and malformed profiles fail before mutating state or the vault', async t => {
  const state = await composition(t);
  const before = await state.workspace.store.read();
  const inputs = [
    { input: server({ projectIds: [state.project.id] }), secrets: { env: { UNDECLARED: fakeEnvironment } } },
    { input: server({ projectIds: [state.project.id], name: fakeBearer.repeat(100) }), secrets: { bearerToken: fakeBearer } },
    { input: server({ projectIds: [state.project.id], url: `https://user:${fakeBearer}@mcp.example.test/api` }), secrets: undefined },
    { input: server({ projectIds: [state.project.id], args: Array.from({ length: 65 }, () => 'argument') }), secrets: undefined },
    { input: server({ projectIds: [state.project.id] }), secrets: { bearerToken: fakeBearer.repeat(1000) } },
  ];
  for (const { input, secrets } of inputs) {
    await assert.rejects(state.bridge.handlers.saveMcpServer(input, secrets), error => error instanceof Error && !error.message.includes(fakeBearer) && !error.message.includes(fakeEnvironment));
    assert.deepEqual(await state.workspace.store.read(), before);
    assert.equal(state.vault.records.size, 0);
    assert.equal(state.bridge.isTesting(), false);
  }
});

test('main MCP save/delete/test refuse changes while an agent or connection probe is busy', async t => {
  const state = await composition(t);
  const saved = await state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }));
  const before = await state.workspace.store.read();
  state.setBusy(true);
  await assert.rejects(state.bridge.handlers.saveMcpServer({ ...saved, name: 'Should not change' }, { bearerToken: fakeBearer }), /Дождитесь/);
  await assert.rejects(state.bridge.handlers.deleteMcpServer(saved.id), /Дождитесь/);
  await assert.rejects(state.bridge.handlers.testMcpServer(saved.id, state.project.id), /Дождитесь/);
  assert.deepEqual(await state.workspace.store.read(), before); assert.equal(state.vault.records.size, 0);
  state.setBusy(false);
  await state.bridge.handlers.deleteMcpServer(saved.id);
  assert.deepEqual(await state.bridge.handlers.listMcpServers(), []);
});

test('main MCP deleting a profile removes all destination slots while preserving foreign profiles and model credentials', async t => {
  const state = await composition(t);
  const saved = await state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment } });
  await state.bridge.handlers.saveMcpServer({ ...saved, url: 'https://different.example.test/api' }, { bearerToken: fakeBearer });
  const foreign = await state.bridge.handlers.saveMcpServer(server({ id: saved.id + '-other', projectIds: [state.project.id] }), { bearerToken: fakeBearer });
  state.vault.records.set('model-fixture', 'artificial-model-value');
  assert.equal([...state.vault.records.keys()].filter(key => key.startsWith(`mcp:${saved.id}:`)).length, 3);
  await state.bridge.handlers.deleteMcpServer(saved.id);
  assert.deepEqual(state.vault.removedProfiles, [saved.id]);
  assert.ok([...state.vault.records.keys()].every(key => !key.startsWith(`mcp:${saved.id}:`)));
  assert.ok(state.vault.has(mcpCredentialId(foreign, 'bearer')));
  assert.equal(state.vault.records.get('model-fixture'), 'artificial-model-value');
  assert.deepEqual((await state.bridge.handlers.listMcpServers()).map(item => item.id), [foreign.id]);
});

test('main MCP reserves a pending save synchronously and shutdown waits for all credential writes', async t => {
  const state = await composition(t);
  const entered = deferred(), release = deferred();
  const save = state.vault.save.bind(state.vault);
  state.vault.save = async (id, value) => { entered.resolve(); await release.promise; await save(id, value); };
  const saving = state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer, env: { FIXTURE_ACCESS: fakeEnvironment } });
  await entered.promise;
  assert.equal(state.bridge.isTesting(), true);
  await assert.rejects(state.bridge.handlers.saveMcpServer(server({ id: 'second-server' })), /Дождитесь/);
  await assert.rejects(state.bridge.handlers.deleteMcpServer('fixture-server'), /Дождитесь/);
  await assert.rejects(state.bridge.handlers.testMcpServer('fixture-server', state.project.id), /Дождитесь/);
  let closed = false, stopped = false;
  const close = state.bridge.manager.close.bind(state.bridge.manager);
  state.bridge.manager.close = async () => { closed = true; await close(); };
  const stopping = state.bridge.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(stopped, false);
  await assert.rejects(state.bridge.handlers.saveMcpServer(server({ id: 'after-shutdown' })), /Дождитесь/);
  release.resolve(); const result = await saving; await stopping;
  assert.equal(result.hasToken, true); assert.deepEqual(result.secretNames, ['FIXTURE_ACCESS']);
  assert.equal(closed, true); assert.equal(stopped, true);
  assert.equal(state.vault.records.size, 2);
});

test('main MCP releases its mutation reservation after validation or vault failures', async t => {
  const state = await composition(t);
  const save = state.vault.save.bind(state.vault);
  state.vault.save = async () => { throw new Error('Artificial vault failure'); };
  await assert.rejects(state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer }), /Artificial vault failure/);
  assert.equal(state.bridge.isTesting(), false);
  state.vault.save = save;
  const retry = await state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer });
  assert.equal(retry.hasToken, true); assert.equal(state.bridge.isTesting(), false);
});

test('main MCP discovery reserves configuration edits and shutdown aborts the actual pending SDK request', { timeout: 3000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const state = await composition(t);
  const local = await localDiscovery(t, { entered, release });
  const saved = await state.bridge.handlers.saveMcpServer(server({ url: local.url, projectIds: [state.project.id] }), { bearerToken: fakeBearer });
  const checking = state.bridge.handlers.testMcpServer(saved.id, state.project.id);
  assert.equal(state.bridge.isTesting(), true);
  await entered.promise;
  await assert.rejects(state.bridge.handlers.saveMcpServer({ ...saved, name: 'Blocked' }), /Дождитесь/);
  await assert.rejects(state.bridge.handlers.deleteMcpServer(saved.id), /Дождитесь/);
  await state.bridge.stop();
  const report = await checking;
  assert.equal(report.ok, false); assert.match(report.message, /cancelled/i);
  assert.equal(state.bridge.isTesting(), false);
  assert.equal((await state.bridge.handlers.getMcpStatus(saved.id, state.project.id)).connected, false);
  assert.equal((await state.workspace.store.read()).mcpServers![0].tools.length, 0);
  release.resolve();
});

test('main MCP shutdown waits until delayed profile credential deletion completes', async t => {
  const state = await composition(t);
  const saved = await state.bridge.handlers.saveMcpServer(server({ projectIds: [state.project.id] }), { bearerToken: fakeBearer });
  const entered = deferred(), release = deferred();
  const remove = state.vault.removeMcp.bind(state.vault);
  state.vault.removeMcp = async id => { entered.resolve(); await release.promise; await remove(id); };
  const deleting = state.bridge.handlers.deleteMcpServer(saved.id);
  await entered.promise;
  assert.equal(state.bridge.isTesting(), true);
  assert.ok(state.vault.has(mcpCredentialId(saved, 'bearer')));
  let stopped = false;
  const stopping = state.bridge.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release.resolve(); await deleting; await stopping;
  assert.equal(stopped, true); assert.equal(state.vault.records.size, 0);
  assert.deepEqual(await state.bridge.handlers.listMcpServers(), []);
});
