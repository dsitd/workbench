import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { RepetitionGuard } from '../src/agent/repetition';
import { freshVerification } from '../src/agent/verification';
import type { RunRecord, VerificationResult } from '../src/shared/types';
import { harnessFixture, reply, tool } from './agent-fixture';

const task = { sessionId: 's', text: 'Fix the project and verify the result.', attachmentIds: [] };
const usage = { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 };
function check(run: RunRecord, status: VerificationResult['status']): VerificationResult {
  return { id: `check-${run.verificationAttempts}`, runId: run.id, projectId: run.projectId, sessionId: run.sessionId,
    command: 'fixture-check', cwd: '/tmp/workbench-fixture', status, output: status === 'passed' ? 'Check passed' : 'Type error remains',
    exitCode: status === 'passed' ? 0 : 1, startedAt: '', finishedAt: '' };
}
const paired = (messages: ReturnType<typeof harnessFixture>['messages']) => {
  const calls = messages.flatMap(message => message.toolCalls ?? []).map(call => call.id);
  const results = messages.filter(message => message.role === 'tool').map(message => message.toolCallId);
  assert.deepEqual(results, calls); assert.equal(new Set(results).size, results.length);
};

test('a failed automatic check feeds the next model step, repairs and rechecks before completion', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let requests = 0, checks = 0, writes = 0;
  f.deps.verifyRun = async run => check(run, ++checks === 1 ? 'failed' : 'passed');
  f.deps.executeTool = async () => { writes++; return { text: 'Repaired the error' }; };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    requests++;
    if (requests === 2) {
      const body = JSON.parse(String(init?.body)); assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && /Type error remains/.test(message.content)));
      return reply('', usage, 'tool_calls', [tool('repair', 'write_file', { path: 'source.ts', content: 'fixed' })]);
    }
    return reply('Implementation finished.', usage);
  } }).run(task);
  assert.equal(requests, 3); assert.equal(checks, 2); assert.equal(writes, 1);
  const run = f.lastRun(); assert.equal(run.status, 'completed'); assert.equal(run.verification?.status, 'passed');
  assert.equal(run.verificationHistory?.length, 2); assert.equal(run.verifiedRevision, run.mutationRevision);
  const checksInHistory = f.messages.filter(message => message.runtimeKind === 'verification');
  assert.equal(checksInHistory.length, 2);
  assert.ok(checksInHistory.every(message => message.toolCalls?.length === 1 && message.toolCalls[0].name === 'verify_project'));
  assert.ok(checksInHistory.every(message => !run.stepLog.some(step => step.assistantMessageId === message.id)));
  assert.equal(f.saved.some(run => run.status === 'completed' && run.verification?.status === 'failed'), false); paired(f.messages);
});

test('unchanged failed verification cannot be hidden by another final model answer', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let checks = 0, requests = 0;
  f.deps.verifyRun = async run => { checks++; return check(run, 'failed'); };
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply('Done', usage); } }).run(task);
  assert.equal(checks, 1); assert.equal(requests, 2); assert.equal(f.lastRun().status, 'error');
  assert.equal(f.lastRun().verification?.status, 'failed'); assert.equal(f.lastRun().canContinue, true); paired(f.messages);
});

test('automatic repair checks remain bounded by the run budget after new mutations', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 7 } }, { verificationCommand: 'fixture-check' }); let requests = 0, checks = 0;
  f.deps.verifyRun = async run => { checks++; return check(run, 'failed'); };
  await new AgentRuntime(f.deps, { fetch: async () => ++requests % 2 === 0
    ? reply('', usage, 'tool_calls', [tool(`repair-${requests}`, 'write_file', { path: `file-${requests}.ts`, content: 'new attempt' })]) : reply('Done', usage) }).run(task);
  assert.equal(checks, 4); assert.equal(requests, 7); assert.equal(f.lastRun().verificationHistory?.length, 4);
  assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'steps'); paired(f.messages);
});

test('a fourth repaired revision can pass verification without a new run', async () => {
  for (const explicit of [true, false]) {
    const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let requests = 0, checks = 0;
    f.deps.verifyRun = async run => check(run, ++checks === 4 ? 'passed' : 'failed');
    await new AgentRuntime(f.deps, { fetch: async () => {
      requests++;
      if (requests % 2 === 1 && requests <= 7) return reply('', usage, 'tool_calls', [tool(`repair-${requests}`, 'write_file', { path: 'source.ts', content: `revision ${requests}` })]);
      if (explicit && requests <= 8) return reply('', usage, 'tool_calls', [tool(`check-${requests}`, 'verify_project', {})]);
      return reply('Done', usage);
    } }).run(task);
    assert.equal(checks, 4); assert.equal(f.lastRun().status, 'completed');
    assert.equal(f.lastRun().verification?.status, 'passed'); paired(f.messages);
  }
});

test('the shared model step limit stops repair while preserving failed verification evidence', async () => {
  const f = harnessFixture({}, { runLimits: { maxSteps: 1 } }, { verificationCommand: 'fixture-check' });
  f.deps.verifyRun = async run => check(run, 'failed');
  await new AgentRuntime(f.deps, { fetch: async () => reply('Done', usage) }).run(task);
  assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'steps');
  assert.equal(f.lastRun().verification?.status, 'failed'); paired(f.messages);
});

test('Plan and disabled automatic verification never execute the configured check', async () => {
  for (const mode of ['plan', 'auto-edit'] as const) {
    const f = harnessFixture({}, { mode }, { verificationCommand: 'fixture-check', verifyAfterRun: mode === 'plan' }); let checks = 0;
    f.deps.verifyRun = async run => { checks++; return check(run, 'passed'); };
    await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
      if (mode === 'plan') assert.equal(JSON.parse(String(init?.body)).tools.some((tool: { function: { name: string } }) => tool.function.name === 'verify_project'), false);
      return reply('Read-only findings', usage);
    } }).run(task);
    assert.equal(checks, 0); assert.equal(f.lastRun().status, 'completed');
  }
});

test('stop during automatic verification pairs its synthetic call and preserves cancellation', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.deps.verifyRun = async (run, signal) => {
    entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return check(run, 'cancelled');
  };
  const runtime = new AgentRuntime(f.deps, { fetch: async () => reply('Candidate answer', usage) });
  const running = runtime.run(task); await ready; await runtime.stop('s'); await running;
  assert.equal(f.lastRun().status, 'stopped'); assert.equal(f.lastRun().verification?.status, 'cancelled'); paired(f.messages);
});

test('a dispatched mutation that throws invalidates a previous passing check', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let checks = 0, requests = 0, changed = false;
  f.deps.verifyRun = async run => { checks++; return check(run, 'passed'); };
  f.deps.executeTool = async () => { changed = true; throw new Error('State changed before failure'); };
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    if (requests === 1) return reply('', usage, 'tool_calls', [tool('first-check', 'verify_project', {})]);
    if (requests === 2) return reply('', usage, 'tool_calls', [tool('uncertain-write', 'write_file', { path: 'file.ts', content: 'changed' })]);
    return reply('Report observed state', usage);
  } }).run(task);
  assert.equal(changed, true); assert.equal(checks, 2); assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.messages.find(message => message.toolCallId === 'uncertain-write')?.error, true); paired(f.messages);
});

test('verification rejects foreign evidence instead of marking the task completed', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let requests = 0;
  f.deps.verifyRun = async run => ({ ...check(run, 'passed'), sessionId: 'other-session' });
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply('Done', usage); } }).run(task);
  assert.notEqual(f.lastRun().status, 'completed'); assert.equal(f.lastRun().verification?.status, undefined);
  assert.ok(requests <= 5); paired(f.messages);
});

test('three identical observations block further executions and pair every declared call', async () => {
  const f = harnessFixture(); let requests = 0, executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Same observation' }; };
  await new AgentRuntime(f.deps, { fetch: async () => reply('', usage, 'tool_calls', [tool(`repeat-${++requests}`)]) }).run(task);
  assert.equal(executions, 3); assert.equal(requests, 5); assert.equal(f.lastRun().status, 'error');
  assert.match(f.messages.at(-1)!.content, /Повторяющееся действие/); paired(f.messages);
});

test('new versions of the same file are progress and do not trigger repetition protection', async () => {
  const f = harnessFixture(); let requests = 0, executions = 0;
  f.deps.executeTool = async () => ({ text: `New file version ${++executions}` });
  await new AgentRuntime(f.deps, { fetch: async () => ++requests <= 6 ? reply('', usage, 'tool_calls', [tool(`read-${requests}`)]) : reply('Finished', usage) }).run(task);
  assert.equal(executions, 6); assert.equal(f.lastRun().status, 'completed'); paired(f.messages);
});

test('repetition fingerprints normalize object key ordering and never include call IDs', () => {
  const guard = new RepetitionGuard();
  for (let index = 0; index < 3; index++) guard.observe({ id: `call-${index}`, name: 'search_files', arguments: { query: 'symbol', path: 'src' } }, { text: 'No matches' });
  assert.equal(guard.blocked({ id: 'new-id', name: 'search_files', arguments: { path: 'src', query: 'symbol' } }), true);
  guard.observe({ id: 'changed', name: 'search_files', arguments: { path: 'src', query: 'symbol' } }, { text: 'New match' });
  assert.equal(guard.blocked({ id: 'retry', name: 'search_files', arguments: { query: 'symbol', path: 'src' } }), false);
});

test('hooks see detached arguments and their order preserves the actual action result', async () => {
  const f = harnessFixture(); const order: string[] = []; let requests = 0;
  f.deps.executeTool = async call => { order.push('execute'); assert.equal(call.arguments.path, 'README.md'); return { text: 'Confirmed observation' }; };
  await new AgentRuntime(f.deps, { hooks: [{
    beforeTool: context => { order.push('before'); context.call.arguments.path = '/outside'; context.project.folders[0].access = 'write'; },
    afterTool: context => { order.push('after'); context.result.text = 'Changed clone'; },
    beforeComplete: () => { order.push('complete'); },
  }], fetch: async () => ++requests === 1 ? reply('', usage, 'tool_calls', [tool()]) : reply('Findings', usage) }).run(task);
  assert.deepEqual(order, ['before', 'execute', 'after', 'complete']);
  assert.equal(f.messages.find(message => message.role === 'tool')?.content, 'Confirmed observation'); paired(f.messages);
});

test('a rejecting before hook prevents execution and a completion hook prevents a false completed status', async () => {
  const f = harnessFixture(); let requests = 0, executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Unexpected' }; };
  await new AgentRuntime(f.deps, { hooks: [{ beforeTool: () => { throw new Error('Blocked by extension'); }, beforeComplete: () => { throw new Error('Required evidence missing'); } }],
    fetch: async () => ++requests === 1 ? reply('', usage, 'tool_calls', [tool()]) : reply('Done', usage) }).run(task);
  assert.equal(executions, 0); assert.equal(f.lastRun().status, 'error');
  const rejected = f.messages.find(message => message.role === 'tool')!;
  assert.equal(rejected.error, true);
  assert.match(rejected.content, /Операция завершилась ошибкой/);
  assert.doesNotMatch(rejected.content, /Blocked by extension/); paired(f.messages);
});

test('stop cancels a never-resolving trusted hook without leaving declared calls orphaned', { timeout: 2000 }, async () => {
  const f = harnessFixture(); let entered!: () => void, executions = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.deps.executeTool = async () => { executions++; return { text: 'Unexpected' }; };
  const runtime = new AgentRuntime(f.deps, { hooks: [{ beforeTool: () => { entered(); return new Promise<void>(() => {}); } }],
    fetch: async () => reply('', usage, 'tool_calls', [tool('first'), tool('second')]) });
  const running = runtime.run(task); await ready; await runtime.stop('s'); await running;
  assert.equal(executions, 0); assert.equal(f.lastRun().status, 'stopped'); paired(f.messages);
});

test('freshness requires actual completed evidence, including a legacy run without verification', () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' });
  const run = { id: 'fixture', projectId: f.project.id, sessionId: f.session.id } as RunRecord;
  assert.equal(freshVerification(run, f.project), false);
  run.verification = check({ ...run, projectId: f.project.id, sessionId: f.session.id }, 'passed');
  run.verifiedRevision = 0; assert.equal(freshVerification(run, f.project), true);
  const original = run.verification;
  for (const identity of ['runId', 'projectId', 'sessionId'] as const) {
    run.verification = { ...original, [identity]: 'foreign' };
    assert.equal(freshVerification(run, f.project), false);
  }
  run.verification = original;
  assert.equal(freshVerification(run, { ...f.project, id: 'foreign' }), false);
  run.mutationRevision = 1; assert.equal(freshVerification(run, f.project), false);
});

test('a failed verification completion hook prevents a false completed status and preserves paired evidence', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' }); let requests = 0;
  f.deps.verifyRun = async run => check(run, 'passed');
  await new AgentRuntime(f.deps, { hooks: [{ afterTool: context => {
    if (context.call.name === 'verify_project') throw new Error('Extension rejected the result');
  } }], fetch: async () => { requests++; return reply('Done', usage); } }).run(task);
  assert.equal(requests, 1); assert.equal(f.lastRun().status, 'error');
  assert.equal(f.lastRun().verification?.status, 'passed');
  assert.equal(f.messages.find(message => message.role === 'tool')?.error, true); paired(f.messages);
});

test('an after hook failure retains each announced action result before stopping the run', async () => {
  const f = harnessFixture(); let executions = 0;
  f.deps.executeTool = async () => { executions++; return { text: 'Actual observed result' }; };
  await new AgentRuntime(f.deps, { hooks: [{ afterTool: () => { throw new Error('Fixture failure'); } }],
    fetch: async () => reply('', usage, 'tool_calls', [tool('first'), tool('second')]) }).run(task);
  assert.equal(executions, 1); assert.equal(f.lastRun().status, 'error');
  const results = f.messages.filter(message => message.role === 'tool');
  assert.equal(results[0].error, true); assert.match(results[0].content, /Actual observed result/);
  assert.equal(results[1].error, true); assert.match(results[1].content, /не выполнен/); paired(f.messages);
});

test('nonterminal verification evidence never completes a task', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'fixture-check' });
  f.deps.verifyRun = async run => check(run, 'running');
  await new AgentRuntime(f.deps, { fetch: async () => reply('Done', usage) }).run(task);
  assert.equal(f.lastRun().status, 'error'); assert.equal(f.lastRun().verificationHistory, undefined); paired(f.messages);
});
