import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices, toolDefinitions } from '../src/backend';
import { ToolRegistry, type RegisteredTool } from '../src/backend/tool-registry';
import type { ToolCall, ToolContext, ToolDefinition } from '../src/shared/types';

const definition: ToolDefinition = { name: 'fixture_tool', description: 'Fixture', permission: 'read', parameters: { type: 'object' } };
const context: ToolContext = { project: { id: 'project', name: 'Project', folders: [], internet: false, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' }, sessionId: 'session', signal: new AbortController().signal };
const call: ToolCall = { id: 'call', name: definition.name, arguments: {} };
const entry: RegisteredTool<{ prefix: string }> = { definition, execute: async (args, current, host) => ({ text: `${host.prefix}:${current.sessionId}:${args.value ?? 'empty'}` }) };

test('registry pairs a definition with its handler and does not expose mutable permission state', async () => {
  const original = structuredClone(definition);
  const registry = new ToolRegistry([{ ...entry, definition: original }]);
  original.name = 'mutated'; original.permission = 'write';
  const published = registry.definitions; published[0].permission = 'command'; published[0].parameters.type = 'string';
  assert.deepEqual(registry.definitions, [definition]);
  assert.deepEqual(await registry.execute({ ...call, arguments: { value: 'result' } }, { ...context, mode: 'plan' }, { prefix: 'host' }), { text: 'host:session:result' });
});

test('registry rejects duplicate, malformed or handlerless registrations', () => {
  const registry = new ToolRegistry([entry]);
  assert.throws(() => registry.register(entry), /already registered/);
  for (const name of ['', 'tool space', '1tool', 'x'.repeat(65)]) assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, name } }]), /Tool name/);
  assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, name: undefined } as unknown as ToolDefinition }]), /Tool name/);
  assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, parameters: { type: 'array' } } }]), /parameters/);
  assert.throws(() => new ToolRegistry([{ ...entry, execute: undefined } as unknown as RegisteredTool<{}>]), /handler/);
  assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, permission: 'unsafe' as ToolDefinition['permission'] } }]), /permission/);
});

test('native registry rejects runtime reserved names and all MCP registrations', () => {
  for (const name of ['update_plan', 'list_attachments', 'explore_code', 'verify_project', 'find_mcp_tools'])
    assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, name } }]), /reserved by the runtime/);
  for (const external of [
    { permission: 'mcp' as const }, { name: 'mcp_fixture' },
    { source: { kind: 'mcp' as const, serverId: 'fixture', serverName: 'Fixture', toolName: 'read' } },
  ]) assert.throws(() => new ToolRegistry([{ ...entry, definition: { ...definition, ...external } }]), /Native tools cannot use MCP/);
});

test('registry enforces disabled internet and rejects unknown MCP routes in Plan before handlers', async () => {
  let executions = 0;
  const registry = new ToolRegistry([{ definition: { ...definition, permission: 'network' }, execute: async () => { executions++; return { text: 'connected' }; } }]);
  await assert.rejects(registry.execute(call, context, {}), /Internet access is disabled/);
  await assert.rejects(registry.execute({ ...call, name: 'mcp_unknown' }, { ...context, mode: 'plan' }, {}), /Plan mode/);
  assert.equal(executions, 0);
  assert.deepEqual(await registry.execute(call, { ...context, project: { ...context.project, internet: true }, mode: 'plan' }, {}), { text: 'connected' });
});

test('registry rejects unknown calls, non-object arguments, Plan writes and cancellation before a handler runs', async () => {
  let executions = 0;
  const registry = new ToolRegistry([{ definition: { ...definition, permission: 'write' }, execute: async () => { executions++; return { text: 'unexpected' }; } }]);
  await assert.rejects(registry.execute({ ...call, name: 'unknown' }, context, {}), /Unknown tool/);
  await assert.rejects(registry.execute({ ...call, arguments: [] as unknown as Record<string, unknown> }, context, {}), /arguments must be an object/);
  await assert.rejects(registry.execute(call, { ...context, mode: 'plan' }, {}), /Plan mode/);
  await assert.rejects(registry.execute(call, { ...context, signal: AbortSignal.abort() }, {}), /cancelled/);
  assert.equal(executions, 0);
});

test('WorkspaceServices dispatches registered tools while keeping project validation and error results', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-registry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'); await mkdir(projectPath);
  const services = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => {} });
  await services.bootstrap();
  const project = await services.createProject({ name: 'Fixture', folders: [{ path: projectPath, access: 'write' }] });
  const session = await services.createSession(project.id, 'demo');
  const current: ToolContext = { project, sessionId: session.id, signal: new AbortController().signal };
  const builtinCount = services.tools.length;
  services.toolRegistry.register({ definition, execute: async (_args, current) => ({ text: current.project.id }) });
  assert.ok(builtinCount >= toolDefinitions.length);
  assert.equal(services.tools.length, builtinCount + 1);
  assert.equal((await services.executeTool(call, current)).text, project.id);
  const unknown = await services.executeTool({ ...call, name: 'missing' }, current);
  assert.equal(unknown.error, true); assert.match(unknown.text, /Unknown tool/);
  const stale = await services.executeTool(call, { ...current, project: { ...project, internet: !project.internet } });
  assert.equal(stale.error, true); assert.match(stale.text, /permissions changed/);
  // Characterize the moved builtin handler through the original public entry point.
  await writeFile(path.join(projectPath, 'read.txt'), 'first\nsecond\nthird\n');
  const read = await services.executeTool({ id: 'read', name: 'read_file', arguments: { path: 'read.txt', startLine: 2, endLine: 3 } }, current);
  assert.match(read.text, /\[version: sha256:[a-f0-9]{64}\] \(lines 2–3 of 4\)\nsecond\nthird$/);
});

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-readonly-delegate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'); await mkdir(projectPath);
  const services = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => {} });
  await services.bootstrap();
  const project = await services.createProject({ name: 'Fixture', folders: [{ path: projectPath, access: 'write' }] });
  const session = await services.createSession(project.id, 'demo');
  await services.updateSession(session.id, { mode: 'bypass' });
  const current: ToolContext = { project, sessionId: session.id, mode: 'bypass', signal: new AbortController().signal };
  return { services, projectPath, current };
}

test('delegated readonly context restricts builtin and custom permissions even in the live Bypass mode', async t => {
  const { services, projectPath, current } = await workspace(t);
  const delegated = { ...current, readOnly: true };
  let executions = 0;
  for (const [name, permission] of [
    ['extension_write', 'write'], ['extension_command', 'command'], ['extension_network', 'network'],
  ] as const) services.toolRegistry.register({ definition: { ...definition, name, permission }, execute: async () => { executions++; return { text: 'unexpected' }; } });
  services.commands.run = async () => { executions++; return 'unexpected'; };
  const calls: ToolCall[] = [
    { id: 'write', name: 'write_file', arguments: { path: 'new.txt', content: 'forbidden' } },
    { id: 'edit', name: 'edit_file', arguments: { path: 'existing.txt', oldText: 'original', newText: 'forbidden' } },
    { id: 'command', name: 'run_command', arguments: { command: 'true' } },
    { id: 'diagnostics', name: 'typescript_diagnostics', arguments: {} },
    { id: 'network', name: 'web_fetch', arguments: { url: 'https://example.com' } },
    ...['extension_write', 'extension_command', 'extension_network', 'mcp_unknown'].map(name => ({ id: name, name, arguments: {} })),
  ];
  for (const call of calls) {
    const result = await services.executeTool(call, delegated); assert.equal(result.error, true); assert.match(result.text, /Read-only delegated/);
  }
  assert.equal(executions, 0);
  assert.deepEqual(await services.files.list(current.project, projectPath), []);
  // readOnly narrows the original context; it cannot bypass live mode or scope identity checks.
  const changedMode = await services.executeTool({ id: 'read', name: 'list_files', arguments: {} }, { ...delegated, mode: 'plan' });
  assert.equal(changedMode.error, true); assert.match(changedMode.text, /mode changed/);
  const changedScope = await services.executeTool({ id: 'read', name: 'list_files', arguments: {} }, { ...delegated, project: { ...current.project, folders: current.project.folders.map(folder => ({ ...folder, access: 'read' })) } });
  assert.equal(changedScope.error, true); assert.match(changedScope.text, /permissions changed/);
});

test('direct command services cannot launch or manage processes from a readonly delegated context', async t => {
  const { services, current } = await workspace(t);
  const delegated = { ...current, readOnly: true };
  await assert.rejects(services.commands.runDetailed(delegated, 'true'), /Read-only delegated/);
  await assert.rejects(services.commands.startBackground(delegated, 'true'), /Read-only delegated/);
  await assert.rejects(services.commands.stopManaged(delegated, 'unknown'), /Read-only delegated/);
  assert.deepEqual(await services.commands.listProcesses(current.project.id, current.sessionId), []);
});

test('delegated file observations cannot grant parent edit permission without the parent reading the file', async t => {
  const { services, projectPath, current } = await workspace(t);
  await writeFile(path.join(projectPath, 'existing.txt'), 'original');
  const read: ToolCall = { id: 'child-read', name: 'read_file', arguments: { path: 'existing.txt' } };
  const child = await services.executeTool(read, { ...current, readOnly: true });
  assert.equal(child.error, undefined); assert.match(child.text, /original/);
  const write: ToolCall = { id: 'parent-write', name: 'write_file', arguments: { path: 'existing.txt', content: 'changed' } };
  const unobserved = await services.executeTool(write, current);
  assert.equal(unobserved.error, true); assert.match(unobserved.text, /Read this file in the current chat/);
  const edit = await services.executeTool({ id: 'parent-edit', name: 'edit_file', arguments: { path: 'existing.txt', oldText: 'original', newText: 'changed' } }, current);
  assert.equal(edit.error, true); assert.match(edit.text, /Read this file in the current chat/);
  assert.equal((await services.files.read(current.project, 'existing.txt')).content, 'original');
  assert.equal((await services.executeTool({ ...read, id: 'parent-read' }, current)).error, undefined);
  assert.equal((await services.executeTool(write, current)).error, undefined);
  assert.equal((await services.files.read(current.project, 'existing.txt')).content, 'changed');
});
