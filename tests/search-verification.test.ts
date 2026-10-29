import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { harnessFixture, reply, tool } from './agent-fixture';
import { toolDefinitions } from '../src/backend/tools';
import { appSettings } from '../src/backend/settings';
import { defaultAppSettings } from '../src/shared/runs';
import type { RunRecord, ToolCall } from '../src/shared/types';
import { acceptCounterexampleReview, beginCounterexampleReview, counterexampleState, prepareCounterexampleProbe, recordCounterexampleProbe } from '../src/agent/counterexamples';
import { beginProgressTurn, observeSearchProgress, progressWarning, searchStalled } from '../src/agent/search-progress';
import { completionResult } from '../src/agent/task-contract';
import { nonEvidenceTools } from '../src/shared/evidence-policy';

const probe = { focus: 'Check zero and duplicates independently', command: "python3 -c \"assert solve([0,0]) == 0, 'COUNTEREXAMPLE duplicates'\"", cwd: '/tmp/workbench-fixture', expected: 'Zero including duplicates', failureContains: 'COUNTEREXAMPLE duplicates' };
const proposal = () => JSON.stringify(probe);
const task = { sessionId: 's', text: 'Fix solution.py, including zero and duplicate inputs.', attachmentIds: [] };
const command = (id = 'probe'): ToolCall => ({ id, name: 'run_command', arguments: { command: probe.command, cwd: probe.cwd } });
function fixture(enabled = true) {
  const f = harnessFixture();
  f.deps.tools.push(toolDefinitions.find(tool => tool.name === 'run_command')!);
  f.deps.getSettings = async () => ({ ...defaultAppSettings, searchVerification: enabled, modelCompaction: false });
  return f;
}
function state(): RunRecord {
  const run = { mutationRevision: 1, evidenceScope: 'scope' } as RunRecord;
  run.counterexampleReview = { attempts: 0, status: 'pending', revisions: [] };
  run.searchProgress = { turnsWithoutEvidence: 0, evidenceKeys: [], warningCount: 0, warned: false, resumes: 0 };
  return run;
}
function accepted(run: RunRecord) {
  beginCounterexampleReview(run, 'Check boundary conditions independently');
  return acceptCounterexampleReview(run, { text: JSON.stringify({ status: 'completed', summary: proposal(), readFiles: 1 }) }, probe.cwd);
}
function paired(f: ReturnType<typeof fixture>) {
  for (const call of f.messages.flatMap(message => message.toolCalls ?? []))
    assert.equal(f.messages.filter(message => message.role === 'tool' && message.toolCallId === call.id).length, 1, call.id);
}

test('search verification is opt-in and settings reject nonboolean values', () => {
  assert.equal(appSettings().searchVerification, false);
  assert.equal(appSettings({ ...defaultAppSettings, searchVerification: true }).searchVerification, true);
  assert.throws(() => appSettings({ ...defaultAppSettings, searchVerification: 'yes' as any }));
  assert.equal(nonEvidenceTools.has('search_counterexamples'), true);
});

test('a completed edit in default mode preserves the original two-request workflow', async () => {
  const f = fixture(false); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1
    ? reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]) : reply('Done') }).run(task);
  assert.equal(requests, 2); assert.equal(f.lastRun().status, 'completed'); assert.equal(f.lastRun().counterexampleReview, undefined);
});

test('automatic review denial receives its result without dispatching a reviewer request', async () => {
  const f = fixture(); f.session.mode = 'ask'; let requests = 0;
  f.deps.approveTool = async request => !request.title.includes('search_counterexamples');
  await new AgentRuntime(f.deps, { fetch: async () => ++requests === 1
    ? reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]) : reply('Ready') }).run(task);
  assert.equal(requests, 2); assert.notEqual(f.lastRun().status, 'completed'); paired(f);
});

test('a cancelled reviewer keeps unknown billing and cannot execute its proposed command', async () => {
  const f = fixture(); let requests = 0, commands = 0;
  f.deps.executeTool = async call => { if (call.name === 'run_command') commands++; return { text: 'read source' }; };
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    requests++;
    if (requests === 1) return reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready');
    entered(); return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    });
  } });
  const work = runtime.run(task); await waiting; await runtime.stop('s'); await work;
  assert.equal(f.lastRun().status, 'stopped'); assert.equal(f.lastRun().usage.unknownCostCalls, 1); assert.equal(commands, 0); paired(f);
});

test('reviewer charge shares the parent money limit', async () => {
  const f = fixture(); f.session.runLimits = { maxCostUsd: 0.02 };
  let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    if (requests === 1) return reply('', { prompt_tokens: 5, completion_tokens: 5, cost: 0.001 }, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready', { prompt_tokens: 5, completion_tokens: 5, cost: 0.001 });
    return reply('', { prompt_tokens: 5, completion_tokens: 5, cost: 0.03 }, 'tool_calls', [tool('critic-read')]);
  } }).run(task);
  assert.equal(requests, 3); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'cost'); paired(f);
});

test('independent review must inspect a file and return bounded structured assertions', () => {
  for (const envelope of [{ status: 'completed', summary: proposal(), readFiles: 0 },
    { status: 'incomplete', summary: proposal(), readFiles: 1 },
    { status: 'completed', summary: '{}', readFiles: 1 },
    { status: 'completed', summary: JSON.stringify({ ...probe, command: 'x'.repeat(4001) }), readFiles: 1 }]) {
    const r = state(); beginCounterexampleReview(r, 'Review boundary cases');
    assert.equal(acceptCounterexampleReview(r, { text: JSON.stringify(envelope) }, probe.cwd).error, true);
    assert.equal(completionResult(r).error, true);
  }
});

test('a 1338-character explanation does not reject an otherwise valid executable review', () => {
  const r = state(); beginCounterexampleReview(r, 'Review a valid-domain regression');
  const result = acceptCounterexampleReview(r, { text: JSON.stringify({ status: 'completed', readFiles: 2,
    summary: JSON.stringify({ ...probe, focus: 'f'.repeat(1338) }) }) }, probe.cwd);
  assert.equal(result.error, undefined);
  assert.equal(r.counterexampleReview!.probe!.focus.length, 1338);
});

test('review validation still identifies oversized explanations', () => {
  const r = state(); beginCounterexampleReview(r, 'Review a valid-domain regression');
  const result = acceptCounterexampleReview(r, { text: JSON.stringify({ status: 'completed', readFiles: 2,
    summary: JSON.stringify({ ...probe, focus: 'f'.repeat(4001) }) }) }, probe.cwd);
  assert.equal(result.error, true); assert.match(r.counterexampleReview!.reason!, /invalid-field:focus;.*4000/);
});

test('review prompts disclose field limits and valid JSON over 6000 characters remains intact', async () => {
  const f = fixture(); let requests = 0;
  const largeProbe = { ...probe, focus: 'f'.repeat(700), command: probe.command + ' #' + 'c'.repeat(3800),
    expected: 'e'.repeat(700), failureContains: 'm'.repeat(700) };
  assert.ok(largeProbe.command.length <= 4000); assert.ok(JSON.stringify(largeProbe).length > 6000);
  f.deps.executeTool = async call => call.name === 'run_command'
    ? { text: 'passed', commandExit: { code: 0 } } : { text: 'def solve(a): return 0' };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    requests++;
    if (requests === 1) return reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready');
    if (requests === 3) {
      assert.match(String(init?.body), /focus 4000, command 4000, cwd 1000, expected 4000, failureContains 800/);
      return reply('', undefined, 'tool_calls', [tool('review-read')]);
    }
    if (requests === 4) return reply(JSON.stringify(largeProbe));
    if (requests === 5) return reply('', undefined, 'tool_calls', [tool('probe', 'run_command', { command: largeProbe.command, cwd: largeProbe.cwd })]);
    return reply('Done');
  } }).run(task);
  assert.equal(f.lastRun().status, 'completed'); assert.equal(requests, 6);
  assert.equal(f.lastRun().counterexampleReview?.probe?.command, largeProbe.command); paired(f);
});

test('only exact command receipts establish tested scope; errors and stale receipts cannot complete', () => {
  const r = state(); accepted(r);
  assert.equal(prepareCounterexampleProbe(r, { ...command(), arguments: { command: 'true' } }, probe.cwd), false);
  assert.equal(prepareCounterexampleProbe(r, command(), probe.cwd), true);
  recordCounterexampleProbe(r, command(), { text: 'Everything passed; exit 0' });
  assert.equal(counterexampleState(r)?.status, 'unconfirmed');
  recordCounterexampleProbe(r, command(), { text: 'python missing', commandExit: { code: 127 }, error: true });
  assert.equal(counterexampleState(r)?.status, 'failed');
  recordCounterexampleProbe(r, command(), { text: probe.failureContains, commandExit: { code: 1 }, error: true });
  assert.equal(counterexampleState(r)?.status, 'counterexample');
  recordCounterexampleProbe(r, command(), { text: 'ok', commandExit: { code: 0 } });
  assert.equal(completionResult(r).error, false);
  r.mutationRevision!++; assert.equal(completionResult(r).error, true);
  r.mutationRevision!--; r.evidenceScope = 'changed'; assert.equal(completionResult(r).error, true);
  prepareCounterexampleProbe(r, command(), probe.cwd); assert.equal(counterexampleState(r)?.status, 'unconfirmed');
});

test('a second review archives the prior failed proposal and cannot inherit its pass', () => {
  const r = state(); accepted(r);
  recordCounterexampleProbe(r, command(), { text: 'ok', commandExit: { code: 0 } });
  accepted(r);
  assert.equal(r.counterexampleReview?.revisions[0].latest?.status, 'passed');
  assert.equal(counterexampleState(r)?.status, 'unconfirmed');
  assert.throws(() => beginCounterexampleReview(r, 'Third attempt'), /двух/);
});

test('progress ignores edits, prose and varying failing commands, warns then stops', () => {
  const r = state();
  for (let i = 0; i < 16; i++) {
    beginProgressTurn(r);
    observeSearchProgress(r, { id: String(i), name: 'write_file', arguments: { path: 'a.py', content: String(i) } }, { text: 'saved' });
    observeSearchProgress(r, { id: String(i), name: 'run_command', arguments: { command: `failing-${i}` } }, { text: `different failure ${i}`, commandExit: { code: 1 }, error: true });
    if (i === 7) assert.match(progressWarning(r)!, /Change the hypothesis/);
  }
  assert.equal(searchStalled(r), true);
  observeSearchProgress(r, { id: 'read', name: 'read_file', arguments: { path: 'unread.py' } }, { text: 'new relevant code' });
  assert.equal(searchStalled(r), false);
  beginProgressTurn(r);
  observeSearchProgress(r, { id: 'read-again', name: 'read_file', arguments: { path: 'unread.py' } }, { text: 'own rewritten code' });
  assert.equal(r.searchProgress?.turnsWithoutEvidence, 1);
});

test('runtime finds a counterexample in isolated context, repairs, then requires a real passing probe', async () => {
  const f = fixture(); let requests = 0, executions = 0;
  f.deps.executeTool = async (call, context) => {
    if (call.name === 'read_file') { assert.equal(context.readOnly, true); return { text: 'def solve(a): return 1' }; }
    if (call.name === 'run_command') { executions++; return executions === 1
      ? { text: probe.failureContains, commandExit: { code: 1 }, error: true } : { text: 'assertions passed', commandExit: { code: 0 } }; }
    return { text: 'changed implementation' };
  };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1 || requests === 6) return reply('PRIVATE_PARENT_RATIONALE', undefined, 'tool_calls', [tool(`edit-${requests}`, 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready');
    if (requests === 3 || requests === 4) {
      assert.equal(JSON.stringify(body).includes('PRIVATE_PARENT_RATIONALE'), false);
      assert.ok(body.tools.every((item: any) => ['read_file', 'search_files', 'list_files'].includes(item.function.name)));
      return requests === 3 ? reply('', undefined, 'tool_calls', [tool('critic-read', 'read_file', { path: 'solution.py' })]) : reply(proposal());
    }
    if (requests === 5 || requests === 7) return reply('', undefined, 'tool_calls', [tool(`probe-${requests}`, 'run_command', command().arguments)]);
    return reply('Fixed. Independent assertion suite passed; only its scope verified.');
  } }).run(task);
  assert.equal(f.lastRun().status, 'completed'); assert.equal(requests, 8); assert.equal(executions, 2);
  assert.equal(counterexampleState(f.lastRun())?.status, 'passed');
  assert.equal(f.lastRun().stepLog.filter(step => step.kind === 'counterexample').length, 2);
  paired(f);
});

test('disabled mode and read-only plan never invoke a counterexample reviewer', async () => {
  for (const mode of ['disabled', 'plan']) {
    const f = fixture(mode !== 'disabled'); if (mode === 'plan') f.session.mode = 'plan';
    let requests = 0;
    await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
      requests++; assert.equal(JSON.stringify(JSON.parse(String(init?.body)).tools).includes('search_counterexamples'), false);
      return reply('Analysis complete');
    } }).run(task);
    assert.equal(requests, 1); assert.equal(f.lastRun().status, 'completed');
  }
});

test('reviewer shares parent request cap and pairs its outer call when stopped at budget', async () => {
  const f = fixture(); let requests = 0;
  await new AgentRuntime(f.deps, { maxSteps: 3, fetch: async () => {
    requests++;
    if (requests === 1) return reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready');
    return reply('', undefined, 'tool_calls', [tool('critic-read')]);
  } }).run(task);
  assert.equal(requests, 3); assert.equal(f.lastRun().status, 'limited'); assert.equal(f.lastRun().limitReason, 'steps'); paired(f);
});

test('the sixth reviewer request is reserved for synthesis and cannot keep exploring', async () => {
  const f = fixture(); let requests = 0, childReads = 0;
  f.deps.executeTool = async call => {
    if (call.name === 'read_file') { childReads++; return { text: 'def solve(a): return 0' }; }
    return call.name === 'run_command' ? { text: 'assertions passed', commandExit: { code: 0 } } : { text: 'saved' };
  };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'solution.py' })]);
    if (requests === 2) return reply('Ready');
    if (requests >= 3 && requests <= 7) return reply('', undefined, 'tool_calls', [tool(`read-${requests}`)]);
    if (requests === 8) {
      assert.equal(body.tools?.length ?? 0, 0); assert.match(JSON.stringify(body), /final request; tools are disabled/);
      return reply(proposal());
    }
    if (requests === 9) return reply('', undefined, 'tool_calls', [tool('probe', 'run_command', command().arguments)]);
    return reply('Done');
  } }).run(task);
  assert.equal(f.lastRun().status, 'completed'); assert.equal(childReads, 5); assert.equal(requests, 10); paired(f);
});

test('stagnation ends incomplete and resume retains obligations even if the toggle is off', async () => {
  const f = fixture(); let requests = 0;
  const runtime = new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    if (body.messages.some((m: any) => String(m.content).includes('COUNTEREXAMPLE REVIEW.'))) {
      return body.messages.some((m: any) => m.role === 'tool') ? reply(proposal()) : reply('', undefined, 'tool_calls', [tool(`review-read-${requests}`)]);
    }
    return reply('', undefined, 'tool_calls', [tool(`edit-${requests}`, 'write_file', { path: 'solution.py', content: String(requests) })]);
  } });
  await runtime.run(task);
  const old = f.lastRun(); assert.equal(old.status, 'incomplete'); assert.equal(old.searchProgress?.warningCount, 1); paired(f);
  f.deps.getSettings = async () => ({ ...defaultAppSettings, searchVerification: false, modelCompaction: false });
  let resumed = 0;
  await new AgentRuntime(f.deps, { maxSteps: 2, fetch: async () => { resumed++; return reply('Ready without checking'); } }).resume('s', old.id);
  assert.equal(resumed, 2); assert.notEqual(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().counterexampleReview?.attempts, 1); assert.equal(f.lastRun().searchProgress?.resumes, 1);
});
