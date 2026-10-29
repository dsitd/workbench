import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { exploreTool, runExplore, type ExploreSettlement } from '../src/agent/explore';
import { AgentError } from '../src/agent/errors';
import { ModelGenerationFailure } from '../src/agent/provider-failure';
import { RunLimitError } from '../src/agent/journal';
import { harnessFixture, reply, sse, tool } from './agent-fixture';
import type { ExploreOptions } from '../src/agent/explore';
import type { ToolContext, ToolDefinition } from '../src/shared/types';

function fixture() {
  const f = harnessFixture({ maxOutputTokens: 2000, inputPricePerMillion: 1, outputPricePerMillion: 2 });
  const controller = new AbortController();
  const reservations: { input: number; output: number }[] = [], settlements: ExploreSettlement[] = [];
  let retries = 0;
  const options: ExploreOptions = { deps: f.deps, session: f.session, project: f.project, model: f.model,
    task: 'Find the exported task runner and give file and line references.', signal: controller.signal, runId: 'parent-run',
    accounting: { check: () => undefined, reserve: async (input, output) => {
      reservations.push({ input, output });
      return { settle: async result => { settlements.push(result); }, retry: async () => { retries++; } };
    } }, fetch: async () => reply('The task runner is in src/task.ts.', { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }),
  };
  return { ...f, options, controller, reservations, settlements, retries: () => retries };
}

test('exploration uses independent bounded history and shared billing reservations without persistence or images', async () => {
  const f = fixture(), payloads: Record<string, any>[] = [], contexts: ToolContext[] = [];
  f.messages.push({ id: 'parent-only', role: 'user', content: 'Parent history should remain private to parent.', createdAt: '' });
  f.session.summary = 'Parent summary should stay out of delegated task.';
  f.deps.getMessages = async () => { throw new Error('Child read parent conversation'); };
  f.deps.appendMessage = async () => { throw new Error('Child persisted history'); };
  f.deps.updateSession = async () => { throw new Error('Child changed parent session'); };
  f.deps.listSkills = async () => { throw new Error('Child loaded skills'); };
  f.deps.getAttachment = async () => { throw new Error('Child accessed attachments'); };
  f.deps.resolveImage = async () => { throw new Error('Child materialized image'); };
  f.deps.saveContext = () => { throw new Error('Child overwrote parent report'); };
  f.deps.executeTool = async (_call, context) => { contexts.push(context); return { text: 'export function runTask() {}', attachmentIds: ['unexpected-image'] }; };
  f.options.fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return payloads.length === 1 ? reply('', { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }, 'tool_calls',
      [tool('child-read', 'read_file', { path: 'src/task.ts', startLine: 2, endLine: 8 })])
      : reply('runTask is exported at src/task.ts:2.', { prompt_tokens: 120, completion_tokens: 12, cost: 0.002 });
  };
  const result = await runExplore(f.options), parsed = JSON.parse(result.text);
  assert.equal(result.error, undefined); assert.equal(parsed.requests, 2); assert.equal(parsed.toolCalls, 1);
  assert.deepEqual(parsed.references, [{ path: 'src/task.ts', startLine: 2, endLine: 8 }]);
  assert.equal(f.reservations.length, 2); assert.ok(f.reservations.every(item => item.input > 0 && item.output === 1200));
  assert.equal(f.settlements.length, 2); assert.equal(f.settlements[0].usage?.costUsd, 0.001); assert.equal(f.settlements[1].usage?.inputTokens, 120);
  assert.equal(f.saved.length, 0); assert.equal(f.events.length, 0); assert.equal(f.messages.length, 1);
  assert.equal(contexts[0].mode, f.session.mode); assert.equal(contexts[0].sessionId, f.session.id); assert.equal(contexts[0].runId, 'parent-run');
  assert.equal(contexts[0].readOnly, true); assert.deepEqual(contexts[0].project, f.project);
  assert.equal(f.project.internet, true); assert.equal(f.project.folders[0].access, 'write');
  assert.ok(payloads.every(payload => !JSON.stringify(payload).includes('Parent history') && !JSON.stringify(payload).includes('Parent summary')
    && !JSON.stringify(payload).includes('unexpected-image')));
  assert.deepEqual(payloads[0].tools.map((item: any) => item.function.name), ['read_file']);
  const returned = payloads[1].messages.find((item: any) => item.role === 'tool');
  assert.equal(returned.tool_call_id, 'child-read'); assert.match(returned.content, /export function runTask/);
});

test('exploration refuses writes, commands, network, MCP, images, skills and recursive delegation with paired error observations', async () => {
  const f = fixture(), payloads: Record<string, any>[] = [];
  const unavailable = ['write_file', 'run_command', 'web_fetch', 'mcp_read', 'inspect_image', 'read_skill_resource', 'explore_code', 'list_processes'];
  f.deps.tools.push(...unavailable.map(name => ({ name, description: 'Forbidden fixture', permission: 'read', parameters: { type: 'object' } }) as ToolDefinition));
  let executed = 0;
  f.deps.executeTool = async () => { executed++; return { text: 'Must not execute' }; };
  f.options.fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return payloads.length === 1 ? reply('', undefined, 'tool_calls', unavailable.map((name, i) => tool('guard-' + i, name, {}))) : reply('Restrictions verified.');
  };
  assert.equal((await runExplore(f.options)).error, undefined); assert.equal(executed, 0);
  assert.deepEqual(payloads[0].tools.map((item: any) => item.function.name), ['read_file']);
  const results = payloads[1].messages.filter((item: any) => item.role === 'tool');
  assert.equal(results.length, unavailable.length);
  assert.deepEqual(results.map((item: any) => item.tool_call_id), unavailable.map((_name, i) => 'guard-' + i));
  assert.ok(results.every((item: any) => /недоступен исследователю/.test(item.content)));
});

test('a whitelisted name with write permission or MCP provenance is excluded from exploration', async () => {
  for (const badDefinition of [
    { name: 'read_file', permission: 'write' },
    { name: 'read_file', permission: 'read', source: { kind: 'mcp', serverId: 'server', serverName: 'server', toolName: 'read_file' } },
  ]) {
    const f = fixture();
    f.deps.tools = [{ description: '', parameters: { type: 'object' }, ...badDefinition } as ToolDefinition];
    let observedTools: any;
    f.options.fetch = async (_url, init) => { observedTools = JSON.parse(String(init?.body)).tools; return reply('No native reads available.'); };
    await runExplore(f.options); assert.equal(observedTools, undefined);
  }
});

test('invalid or pre-cancelled exploration never submits, resolves credentials or reserves a request', async () => {
  for (const invalid of ['', '   ', 123, 'x'.repeat(6001)]) {
    const f = fixture(); f.options.task = invalid;
    await assert.rejects(runExplore(f.options), /конкретная задача/); assert.equal(f.reservations.length, 0);
  }
  const f = fixture(); let credentials = 0, submitted = 0;
  f.deps.resolveCredential = async () => { credentials++; return undefined; };
  f.options.fetch = async () => { submitted++; return reply(); };
  f.controller.abort(); await assert.rejects(runExplore(f.options), { name: 'AbortError' });
  assert.equal(credentials, 0); assert.equal(submitted, 0); assert.equal(f.reservations.length, 0);
});

test('every child request reserves against parent limits, and a denied reservation prevents submission', async () => {
  for (const reason of ['steps', 'tokens', 'cost', 'duration'] as const) {
    const f = fixture(); let submitted = 0;
    f.options.accounting.reserve = async () => { throw new RunLimitError(reason, {}); };
    f.options.fetch = async () => { submitted++; return reply(); };
    await assert.rejects(runExplore(f.options), error => error instanceof RunLimitError && error.reason === reason);
    assert.equal(submitted, 0); assert.equal(f.settlements.length, 0);
  }
});

test('provider failures retain reported charge once without executing model payloads', async () => {
  const f = fixture(); let executed = 0;
  f.deps.executeTool = async () => { executed++; return { text: 'Unexpected' }; };
  f.options.fetch = async () => sse([{ type: 'error', error: { message: 'Opaque server response' },
    usage: { prompt_tokens: 110, completion_tokens: 14, cost: 0.012, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } },
    choices: [{ delta: { content: 'Opaque server response', tool_calls: [{ index: 0, ...tool('bad', 'write_file', {}) }] } }] }]);
  await assert.rejects(runExplore(f.options), error => error instanceof ModelGenerationFailure && !error.message.includes('Opaque'));
  assert.equal(executed, 0); assert.equal(f.settlements.length, 1);
  assert.equal(f.settlements[0].usage?.costUsd, 0.012); assert.equal(f.settlements[0].usage?.inputTokens, 110);
  assert.equal(f.settlements[0].usage?.cacheReadTokens, 80); assert.equal(f.settlements[0].usage?.unknownCostCalls, undefined);
  assert.equal(JSON.stringify(f.settlements).includes('Opaque'), false);
});

test('submitted transport failure or cancellation without usage counts one unknown charge', async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    f.options.fetch = async () => { if (cancel) f.controller.abort(); throw new Error('Opaque fixture transport data'); };
    await assert.rejects(runExplore(f.options));
    assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].usage?.unknownCostCalls, 1);
    assert.equal(f.settlements[0].usage?.costSource, 'unknown');
    assert.equal(f.settlements[0].usage?.inputTokens, f.reservations[0].input);
    assert.equal(JSON.stringify(f.settlements).includes('Opaque'), false);
  }
});

test('rejected HTTP request or credential resolution failure records failure without a phantom charge', async () => {
  for (const credentialFailure of [false, true]) {
    const f = fixture();
    f.options.fetch = async () => new Response('Opaque rejection body', { status: 401 });
    if (credentialFailure) f.deps.resolveCredential = async () => { throw new Error('Opaque credential error'); };
    await assert.rejects(runExplore(f.options));
    assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].usage, undefined); assert.ok(f.settlements[0].error);
    assert.equal(JSON.stringify(f.settlements).includes('Opaque'), false);
  }
});

test('settlement persistence failure never accounts the same provider request twice', async () => {
  const f = fixture(); let settled = 0;
  f.options.accounting.reserve = async () => ({ retry: async () => undefined, settle: async () => { settled++; throw new AgentError('Журнал недоступен.'); } });
  await assert.rejects(runExplore(f.options), /Журнал недоступен/); assert.equal(settled, 1);
});

test('cancellation or a parent budget failure after a billed response prevents all remaining child reads', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); let executed = 0;
    f.options.fetch = async () => reply('', { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }, 'tool_calls',
      [tool('r1'), tool('r2'), tool('r3')]);
    f.deps.executeTool = async () => { executed++; if (cancelled) f.controller.abort(); return { text: 'Observed read' }; };
    f.options.accounting.check = () => { if (!cancelled && f.settlements.length) throw new RunLimitError('tokens', {}); };
    await assert.rejects(runExplore(f.options));
    assert.equal(executed, cancelled ? 1 : 0); assert.equal(f.settlements.length, 1); assert.equal(f.reservations.length, 1);
    assert.equal(f.settlements[0].usage?.costUsd, 0.001);
  }
});

test('six-request exploration limit returns bounded incomplete metadata and never grants a new budget', async () => {
  const f = fixture(); let submitted = 0;
  f.options.fetch = async () => { submitted++; return reply('', undefined, 'tool_calls', [tool('read-' + submitted)]); };
  f.deps.executeTool = async () => ({ text: 'x'.repeat(40000) });
  const result = await runExplore(f.options), parsed = JSON.parse(result.text);
  assert.equal(result.error, true); assert.equal(parsed.status, 'incomplete'); assert.equal(submitted, 6);
  assert.equal(f.reservations.length, 6); assert.equal(f.settlements.length, 6); assert.equal(parsed.toolCalls, 6);
  assert.ok(result.text.length < 8000);
});

test('truncated model output stays incomplete and reported API pricing is retained', async () => {
  const f = fixture();
  f.options.fetch = async () => reply('x'.repeat(12000), { prompt_tokens: 10, completion_tokens: 20, cost: 0.02 }, 'length');
  const result = await runExplore(f.options), parsed = JSON.parse(result.text);
  assert.equal(result.error, true); assert.equal(parsed.status, 'incomplete'); assert.ok(parsed.summary.length <= 6012);
  assert.equal(f.settlements[0].usage?.costUsd, 0.02);
  assert.equal(exploreTool.permission, 'read'); assert.equal(exploreTool.name, 'explore_code');
});

test('child request retries are delegated to parent accounting', async () => {
  const f = fixture(); let attempts = 0;
  f.options.fetch = async () => ++attempts === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : reply('Retry complete.');
  await runExplore(f.options); assert.equal(attempts, 2); assert.equal(f.retries(), 1);
  assert.equal(f.reservations.length, 1); assert.equal(f.settlements.length, 1);
});

test('exploration reads through real backend identity checks while protected paths and symlink escapes remain blocked', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-explore-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'project'), outside = path.join(root, 'outside');
  await Promise.all([mkdir(folder), mkdir(outside)]);
  await writeFile(path.join(folder, 'task.ts'), 'export const runTask = () => 1;\n');
  await writeFile(path.join(folder, 'pinned.ts'), 'export const pinned = 2;\n');
  await writeFile(path.join(folder, 'mentioned.ts'), 'export const mentioned = 3;\n');
  await writeFile(path.join(folder, '.env.example'), 'VALUE=placeholder\n');
  await writeFile(path.join(outside, 'outside.ts'), 'export const outside = 1;\n');
  await symlink(outside, path.join(folder, 'escape'));
  const service = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => undefined });
  await service.bootstrap();
  const project = await service.createProject({ name: 'Real exploration', folders: [{ path: folder, access: 'write' }], internet: true,
    pins: [{ id: 'pin', path: 'pinned.ts' }] });
  const session = await service.createSession(project.id, 'demo');
  const f = fixture(); f.options.project = project; f.options.session = session; f.deps.tools = service.tools;
  f.options.task = 'Investigate runTask and @file:mentioned.ts';
  f.deps.executeTool = (call, context) => service.executeTool(call, context);
  f.deps.getProjectContext = (value, query, signal, id, navigation) => service.getProjectContext(value, query, signal, id, navigation);
  let requests = 0, observations: any[] = [];
  f.options.fetch = async (_url, init) => {
    requests++;
    if (requests === 1) return reply('', undefined, 'tool_calls', [tool('allowed', 'read_file', { path: 'task.ts' }),
      tool('protected', 'read_file', { path: '.env.example' }), tool('escaped', 'read_file', { path: 'escape/outside.ts' })]);
    observations = JSON.parse(String(init?.body)).messages;
    return reply('runTask is exported by task.ts:1.');
  };
  const result = await runExplore(f.options);
  assert.match(observations.find((item: any) => item.tool_call_id === 'allowed').content, /export const runTask/);
  assert.match(observations.find((item: any) => item.tool_call_id === 'protected').content, /credential or protected/);
  assert.match(observations.find((item: any) => item.tool_call_id === 'escaped').content, /Symbolic link leaves/);
  assert.equal(JSON.stringify(observations).includes('VALUE=placeholder'), false);
  assert.equal(JSON.stringify(observations).includes('export const outside'), false);
  assert.equal(result.error, undefined); assert.deepEqual(JSON.parse(result.text).references, [{ path: 'task.ts' }]);
  assert.equal((await service.getMessages(session.id)).length, 0);
  for (const file of ['task.ts', 'pinned.ts', 'mentioned.ts']) {
    const prematureWrite = await service.executeTool({ id: 'parent-write', name: 'write_file', arguments: { path: file, content: 'changed' } },
      { project, sessionId: session.id, signal: f.controller.signal, mode: session.mode, runId: 'parent-run' });
    assert.equal(prematureWrite.error, true); assert.match(prematureWrite.text, /Read this file in the current chat before/);
  }
  assert.equal(await readFile(path.join(folder, 'task.ts'), 'utf8'), 'export const runTask = () => 1;\n');
});

test('Ask requires separate approval for each child read and preserves declined call results', async () => {
  for (const accepted of [true, false]) {
    const f = fixture(); f.session.mode = 'ask';
    const approvals: string[] = [], payloads: any[] = []; let executed = 0;
    f.deps.approveTool = async request => { approvals.push(request.description); assert.equal(request.sessionId, f.session.id); return accepted; };
    f.deps.executeTool = async () => { executed++; return { text: 'Approved read' }; };
    f.options.fetch = async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return payloads.length === 1
      ? reply('', undefined, 'tool_calls', [tool('ask1'), tool('ask2')]) : reply('Read permissions processed.'); };
    await runExplore(f.options);
    assert.equal(approvals.length, 2); assert.equal(executed, accepted ? 2 : 0);
    const observed = payloads[1].messages.filter((item: any) => item.role === 'tool');
    assert.deepEqual(observed.map((item: any) => item.tool_call_id), ['ask1', 'ask2']);
    assert.ok(observed.every((item: any) => accepted ? /Approved read/.test(item.content) : /отклонил/.test(item.content)));
    assert.deepEqual(f.events.map(event => event.status), ['approval', 'running', 'approval', 'running']);
    assert.equal(f.messages.length, 0); assert.equal(f.saved.length, 0);
  }
});

test('Ask cancellation during child approval stops remaining reads and retains the completed request bill', async () => {
  const f = fixture(); f.session.mode = 'ask';
  let began!: () => void, executed = 0, approvals = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.deps.approveTool = async () => { approvals++; began(); return new Promise<boolean>(() => undefined); };
  f.deps.executeTool = async () => { executed++; return { text: 'Unexpected' }; };
  f.options.fetch = async () => reply('', { prompt_tokens: 20, completion_tokens: 10, cost: 0.005 }, 'tool_calls', [tool('ask1'), tool('ask2')]);
  const running = runExplore(f.options); await started; f.controller.abort();
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(approvals, 1); assert.equal(executed, 0);
  assert.equal(f.settlements.length, 1); assert.equal(f.settlements[0].usage?.costUsd, 0.005);
});

test('Ask without approval service fails before any paid request', async () => {
  const f = fixture(); f.session.mode = 'ask';
  await assert.rejects(runExplore(f.options), /сервис подтверждения/); assert.equal(f.reservations.length, 0);
});

test('Ask approval exposes bounded primitive arguments with common credential forms redacted', async () => {
  const f = fixture(); f.session.mode = 'ask';
  f.deps.tools.push({ name: 'search_files', description: 'Search', permission: 'read', parameters: { type: 'object' } });
  let shown = '', requests = 0;
  f.deps.approveTool = async request => { shown = request.description; return true; };
  f.options.fetch = async () => ++requests === 1 ? reply('', undefined, 'tool_calls', [tool('search', 'search_files', { query: 'Bearer artificial-example-value' })]) : reply('Search complete.');
  await runExplore(f.options); assert.match(shown, /Bearer \[credential redacted\]/); assert.equal(shown.includes('artificial-example-value'), false);
});

test('read-only exploration accepts bounded search context and rejects invalid ranges', async () => {
  for (const contextLines of [0, 2, 20, -1, 21, 1.5]) {
    const f = fixture(); let requests = 0, executed = 0;
    f.deps.tools.push({ name: 'search_files', description: 'Search', permission: 'read', parameters: { type: 'object' } });
    f.deps.executeTool = async () => { executed++; return { text: 'numbered search excerpt' }; };
    f.options.fetch = async () => ++requests === 1
      ? reply('', undefined, 'tool_calls', [tool('search', 'search_files', { query: 'target', contextLines })]) : reply('Done.');
    await runExplore(f.options);
    assert.equal(executed, [0, 2, 20].includes(contextLines) ? 1 : 0);
  }
});
