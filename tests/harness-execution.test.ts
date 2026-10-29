import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply, tool } from './agent-fixture';
const task = { sessionId: 's', text: 'Inspect and update files', attachmentIds: [] };
const usage = { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 };
const paired = (f: ReturnType<typeof harnessFixture>) => assert.deepEqual(f.messages.filter(m => m.role === 'tool').map(m => m.toolCallId), f.messages.flatMap(m => m.toolCalls ?? []).map(c => c.id));
const delay = () => new Promise(resolve => setTimeout(resolve, 15));

for (const sequential of [false, true]) test(`native reads overlap=${!sequential}; mutations are barriers and results stay ordered`, async () => {
  const f = harnessFixture(); let active = 0, peak = 0, calls = 0, reads = 0;
  f.deps.getSettings = async () => ({ ...defaultAppSettings, toolExecution: sequential ? 'sequential' : 'parallel' });
  f.deps.executeTool = async call => {
    if (call.name === 'write_file') { assert.equal(active, 0); assert.equal(reads, 2); return { text: 'written' }; }
    active++; peak = Math.max(peak, active); await delay(); active--; reads++;
    return { text: call.id, error: call.id === 'r2' };
  };
  await new AgentRuntime(f.deps, { fetch: async () => ++calls === 1 ? reply('', usage, 'tool_calls', [tool('r1', 'read_file', { path: 'a' }), tool('r2', 'read_file', { path: 'b' }), tool('w', 'write_file', { path: 'a' }), tool('r3', 'read_file', { path: 'c' })]) : reply('Done', usage) }).run(task);
  assert.equal(peak, sequential ? 1 : 2); assert.equal(reads, 3); paired(f); assert.equal(f.lastRun().status, 'completed');
});

test('stop drains started parallel reads and pairs unstarted mutation calls without executing them', async () => {
  const f = harnessFixture(); let started = 0, writes = 0; let release!: () => void, both!: () => void;
  const ready = new Promise<void>(resolve => { both = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  f.deps.executeTool = async call => { if (call.name === 'write_file') writes++; if (++started === 2) both(); await blocked; return { text: 'read' }; };
  const runtime = new AgentRuntime(f.deps, { fetch: async () => reply('', usage, 'tool_calls', [tool('r1', 'read_file', { path: 'a' }), tool('r2', 'read_file', { path: 'b' }), tool('w', 'write_file')]) });
  const running = runtime.run(task); await ready; const stopped = runtime.stop('s'); release(); await Promise.all([running, stopped]);
  paired(f); assert.equal(writes, 0); assert.equal(f.lastRun().status, 'stopped');
});

test('hooks and ask approvals preserve serial execution even when parallel mode is selected', async () => {
  for (const ask of [true, false]) {
    const f = harnessFixture({}, { mode: ask ? 'ask' : 'auto-edit' }); let calls = 0, active = 0, peak = 0, approvals = 0;
    f.deps.approveTool = async () => { approvals++; return true; };
    f.deps.executeTool = async () => { active++; peak = Math.max(peak, active); await delay(); active--; return { text: 'read' }; };
    await new AgentRuntime(f.deps, { hooks: ask ? undefined : [{ beforeTool: () => {} }], fetch: async () => ++calls === 1 ? reply('', usage, 'tool_calls', [tool('a', 'read_file', { path: 'a' }), tool('b', 'read_file', { path: 'b' })]) : reply('Done', usage) }).run(task);
    assert.equal(peak, 1); assert.equal(approvals, ask ? 2 : 0); paired(f);
  }
});

test('natural completion skips automatic project checks and finish_task, retaining manual verification', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'check' }); let checks = 0;
  f.deps.getSettings = async () => ({ ...defaultAppSettings, completionPolicy: 'natural' });
  f.deps.verifyRun = async () => { checks++; throw new Error('unexpected'); };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const names = JSON.parse(String(init?.body)).tools.map((t: any) => t.function.name);
    assert.ok(names.includes('verify_project')); assert.ok(!names.includes('finish_task')); return reply('Done', usage);
  } }).run(task);
  assert.equal(checks, 0); assert.equal(f.lastRun().status, 'completed');
});

test('finish hook requests another turn with persisted context, remains bounded by shared limits', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 2 } }); let calls = 0;
  await new AgentRuntime(f.deps, { hooks: [{ finishTurn: () => ({ continueWith: 'Inspect the remaining edge case.' }) }], fetch: async (_url, init) => {
    if (++calls === 2) assert.match(String(init?.body), /remaining edge case/); return reply('Done', usage);
  } }).run(task);
  assert.equal(calls, 2); assert.equal(f.lastRun().status, 'limited'); paired(f);
});

test('finish hook exceptions fail closed and detached hook data cannot forge success', async () => {
  const f = harnessFixture();
  await new AgentRuntime(f.deps, { hooks: [{ finishTurn: context => { context.run.status = 'completed'; throw new Error('hook failed'); } }], fetch: async () => reply('Done', usage) }).run(task);
  assert.equal(f.lastRun().status, 'error'); assert.ok(f.lastRun().error); assert.doesNotMatch(f.lastRun().error!, /hook failed/);
});

test('natural completion still enforces registered criteria before invoking finish hooks', async () => {
  const f = harnessFixture(); let hooks = 0;
  f.deps.getSettings = async () => ({ ...defaultAppSettings, completionPolicy: 'natural' });
  await new AgentRuntime(f.deps, { hooks: [{ finishTurn: () => { hooks++; } }], fetch: async () => reply('Claimed done', usage) }).run({ ...task, text: 'Acceptance criteria:\n- The requested file exists' });
  assert.equal(f.lastRun().status, 'error'); assert.equal(hooks, 0); paired(f);
});

test('parallel scheduler caps concurrency and repeated identical reads remain ordered', async () => {
  const f = harnessFixture(); let calls = 0, active = 0, peak = 0, seen = new Set<string>();
  f.deps.executeTool = async call => {
    const path = String(call.arguments.path); assert.equal(seen.has(path), false); seen.add(path);
    active++; peak = Math.max(peak, active); await delay(); active--; seen.delete(path); return { text: path };
  };
  const reads = Array.from({ length: 9 }, (_, i) => tool(`read-${i}`, 'read_file', { path: i === 2 ? 'file-1' : `file-${i}` }));
  await new AgentRuntime(f.deps, { fetch: async () => ++calls === 1 ? reply('', usage, 'tool_calls', reads) : reply('Done', usage) }).run(task);
  assert.ok(peak > 1 && peak <= 4); assert.equal(f.lastRun().status, 'completed'); paired(f);
});
