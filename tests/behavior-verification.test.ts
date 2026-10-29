import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { toolDefinitions } from '../src/backend/tools';
import { harnessFixture as baseFixture, reply, tool } from './agent-fixture';
import { behaviorCheckState, behaviorToolCatalog, prepareBehaviorCheck, recordBehaviorCheck } from '../src/agent/behavior-verification';
import { defaultAppSettings } from '../src/shared/runs';
import { appSettings } from '../src/backend/settings';
import { completionResult } from '../src/agent/task-contract';
import { completionGuidance } from '../src/agent/completion-guidance';
import type { RunRecord, ToolCall } from '../src/shared/types';

const description = 'Requested edge case and related invariants';
function harnessFixture(...args: Parameters<typeof baseFixture>) {
  const f = baseFixture(...args);
  f.deps.getSettings = async () => ({ ...defaultAppSettings, behaviorVerification: true });
  return f;
}
function command(phase: 'baseline' | 'regression', patch: Record<string, unknown> = {}): ToolCall {
  return { id: phase, name: 'run_command', arguments: { command: 'python regression.py', behaviorCheck: {
    phase, description, ...(phase === 'baseline' ? { failureContains: 'AssertionError: edge case' } : {}),
  }, ...patch } };
}
const run = () => ({ mutationRevision: 1, evidenceScope: 'scope' } as RunRecord);

test('a green project check cannot complete an unresolved behavioral reproduction', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'check' });
  f.deps.tools.push(toolDefinitions.find(t => t.name === 'run_command')!);
  f.deps.executeTool = async () => ({ text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  f.deps.verifyRun = async run => ({ id: 'v', runId: run.id, projectId: 'p', sessionId: 's', command: 'check', cwd: f.project.folders[0].path, status: 'passed', exitCode: 0, output: 'ok', startedAt: '' });
  let step = 0;
  await new AgentRuntime(f.deps, { maxSteps: 5, fetch: async () => ++step === 1
    ? reply('', undefined, 'tool_calls', [tool('b', 'run_command', {
      command: 'python regression.py', behaviorCheck: { phase: 'baseline', description: 'Edge case matches requested behavior', failureContains: 'AssertionError: edge case' },
    })]) : reply('Fixed and verified') }).run({ sessionId: 's', text: 'Fix the edge case bug.', attachmentIds: [] });
  assert.notEqual(f.lastRun().status, 'completed');
  assert.ok(f.messages.some(m => m.toolName === 'check_completion' && /behavior/.test(m.content)));
});

test('records backend failure then pass without another model or accounting tool call', async () => {
  const f = harnessFixture();
  f.deps.tools.push(toolDefinitions.find(t => t.name === 'run_command')!);
  f.deps.executeTool = async call => call.id === 'baseline'
    ? { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } }
    : { text: 'all assertions passed', commandExit: { code: 0 } };
  let step = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    step++;
    if (step === 1 || step === 3) {
      const call = command(step === 1 ? 'baseline' : 'regression');
      return reply('', undefined, 'tool_calls', [tool(call.id, call.name, call.arguments)]);
    }
    if (step === 2) return reply('', undefined, 'tool_calls', [tool('edit', 'write_file', { path: 'code.py', content: 'fix' })]);
    return reply('Fixed; regression passed.');
  } }).run({ sessionId: 's', text: 'Fix the bug.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(step, 4);
  assert.equal(behaviorCheckState(f.lastRun())?.failureThenPass, true);
  const declarations = f.messages.flatMap(m => m.toolCalls ?? []);
  for (const call of declarations) assert.equal(f.messages.filter(m => m.role === 'tool' && m.toolCallId === call.id).length, 1);
});

test('stdout claims, cancellation and a hook error cannot create a pass', () => {
  for (const result of [{ text: 'exit 0; all tests passed' }, { text: 'cancelled', error: true },
    { text: 'hook failed', error: true, commandExit: { code: 0 } }]) {
    const r = run(), call = command('regression');
    prepareBehaviorCheck(r, call, '/repo'); recordBehaviorCheck(r, call, result);
    assert.equal(completionResult(r).error, true);
  }
});

test('unrelated process failure is not a reproduced bug and its command can be repaired', () => {
  const r = run(), call = command('baseline');
  prepareBehaviorCheck(r, call, '/repo');
  recordBehaviorCheck(r, call, { text: 'python not found', error: true, commandExit: { code: 127 } });
  assert.equal(behaviorCheckState(r)?.baseline, 'failed');
  const repaired = command('baseline', { command: '/usr/bin/python3 regression.py' });
  prepareBehaviorCheck(r, repaired, '/repo');
  recordBehaviorCheck(r, repaired, { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  assert.equal(behaviorCheckState(r)?.baseline, 'reproduced');
});

test('a reproduced suite cannot be weakened or lose its baseline during retries', () => {
  const r = run(), call = command('baseline');
  prepareBehaviorCheck(r, call, '/repo');
  recordBehaviorCheck(r, call, { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  assert.throws(() => prepareBehaviorCheck(r, command('regression', { command: 'true' }), '/repo'), /fixed/);
  assert.throws(() => prepareBehaviorCheck(r, command('regression', { cwd: '/other' }), '/repo'), /fixed/);
  assert.throws(() => prepareBehaviorCheck(r, call, '/repo'), /already saved/);
  r.mutationRevision!++;
  const check = command('regression'); prepareBehaviorCheck(r, check, '/repo');
  recordBehaviorCheck(r, check, { text: 'still fails', error: true, commandExit: { code: 1 } });
  assert.equal(completionResult(r).error, true);
  assert.throws(() => prepareBehaviorCheck(r, command('regression', { command: 'true' }), '/repo'), /fixed/);
});

test('successful checks become stale after mutations and permission changes; reads preserve them', () => {
  const r = run(), call = command('regression');
  prepareBehaviorCheck(r, call, '/repo'); recordBehaviorCheck(r, call, { text: 'ok', commandExit: { code: 0 } });
  assert.equal(completionResult(r).error, false);
  assert.equal(behaviorCheckState(r)?.baseline, 'not-recorded');
  assert.equal(behaviorCheckState(r)?.failureThenPass, false);
  const clone = structuredClone(r);
  clone.evidenceScope = 'new permissions'; assert.equal(behaviorCheckState(clone)?.status, 'stale');
  r.mutationRevision!++; assert.equal(completionResult(r).error, true);
  assert.equal(behaviorCheckState(r)?.status, 'stale');
  prepareBehaviorCheck(r, call, '/repo');
  assert.equal(behaviorCheckState(r)?.status, 'unconfirmed');
});

test('behavioral state remains in completion context even without project verification', () => {
  const r = run(), call = command('baseline'), f = harnessFixture();
  prepareBehaviorCheck(r, call, '/repo');
  recordBehaviorCheck(r, call, { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  assert.match(completionGuidance(r, f.project)!, /"baseline":"reproduced"/);
  assert.match(completionGuidance(r, f.project)!, /python regression.py/);
});

test('a failed retry cannot unlock a previously passing regression-only suite', () => {
  const r = run(), call = command('regression');
  prepareBehaviorCheck(r, call, '/repo'); recordBehaviorCheck(r, call, { text: 'ok', commandExit: { code: 0 } });
  r.mutationRevision!++;
  prepareBehaviorCheck(r, call, '/repo'); recordBehaviorCheck(r, call, { text: 'failure', commandExit: { code: 1 }, error: true });
  assert.throws(() => prepareBehaviorCheck(r, command('regression', { command: 'true' }), '/repo'), /fixed/);
});

test('an explained correction to a model-authored assertion preserves the old receipt and resets proof', () => {
  const r = run(), before = command('baseline');
  prepareBehaviorCheck(r, before, '/repo');
  recordBehaviorCheck(r, before, { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  const corrected = command('regression', { command: 'python corrected_regression.py', behaviorCheck: {
    phase: 'regression', description, revisionReason: 'The public API returns an empty list here; the auxiliary None assertion was incorrect.',
  } });
  prepareBehaviorCheck(r, corrected, '/repo');
  assert.equal(behaviorCheckState(r)?.baseline, 'not-recorded');
  assert.equal(completionResult(r).error, true);
  r.mutationRevision!++;
  recordBehaviorCheck(r, corrected, { text: 'ok', commandExit: { code: 0 } });
  assert.equal(behaviorCheckState(r)?.failureThenPass, false);
  assert.equal(r.behaviorCheck?.revisions?.[0].baseline?.status, 'reproduced');
  assert.equal(r.behaviorCheck?.revisions?.[0].command, before.arguments.command);
  r.acceptanceCriteria = [{ id: 'user-rule', text: 'Explicit user requirement', sourceQuote: 'Explicit user requirement', sourceMessageId: 'u' }];
  assert.equal(completionResult(r).error, true, 'correcting a generated test cannot close a user acceptance criterion');
});

test('explained assertion amendments work through the actual runtime tool schema', async () => {
  const f = harnessFixture(); f.deps.tools.push(toolDefinitions.find(t => t.name === 'run_command')!);
  f.deps.executeTool = async call => call.id === 'baseline'
    ? { text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } }
    : { text: 'ok', commandExit: { code: 0 } };
  let step = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++step > 2) return reply('Corrected assertion passed; no before/after proof for the revised suite.');
    const call = step === 1 ? command('baseline') : command('regression', { command: 'python corrected.py', behaviorCheck: {
      phase: 'regression', description, revisionReason: 'The original auxiliary assertion contradicted the documented return type.',
    } });
    return reply('', undefined, 'tool_calls', [tool(call.id, call.name, call.arguments)]);
  } }).run({ sessionId: 's', text: 'Fix edge case', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(behaviorCheckState(f.lastRun())?.revisions, 1);
  assert.equal(behaviorCheckState(f.lastRun())?.failureThenPass, false);
});

test('resume preserves unresolved behavior even if the original tool group is no longer active', async () => {
  const f = harnessFixture();
  f.deps.tools.push(toolDefinitions.find(t => t.name === 'run_command')!);
  f.deps.executeTool = async () => ({ text: 'AssertionError: edge case', error: true, commandExit: { code: 1 } });
  const baseline = command('baseline');
  await new AgentRuntime(f.deps, { maxSteps: 1, fetch: async () => reply('', undefined, 'tool_calls', [tool(baseline.id, baseline.name, baseline.arguments)]) })
    .run({ sessionId: 's', text: 'Fix edge case', attachmentIds: [] });
  const parent = f.lastRun(); assert.equal(parent.status, 'limited');
  f.deps.getSettings = async () => ({ ...defaultAppSettings, behaviorVerification: false });
  await new AgentRuntime(f.deps, { maxSteps: 1, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.tools.find((t: any) => t.function.name === 'run_command').function.parameters.properties.behaviorCheck);
    return reply('Done');
  } }).resume('s', parent.id);
  assert.notEqual(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().behaviorCheck?.baseline?.toolCallId, baseline.id);
});

test('experimental mode defaults off and leaves the shared tool schema untouched', async () => {
  assert.equal(appSettings().behaviorVerification, false);
  assert.equal(appSettings({ ...defaultAppSettings, behaviorVerification: true }).behaviorVerification, true);
  assert.throws(() => appSettings({ ...defaultAppSettings, behaviorVerification: 'yes' as any }));
  const plain = behaviorToolCatalog(toolDefinitions, false).find(t => t.name === 'run_command')!;
  assert.equal((plain.parameters.properties as any).behaviorCheck, undefined);
  assert.doesNotMatch(plain.description, /behaviorCheck/);
  assert.ok((toolDefinitions.find(t => t.name === 'run_command')!.parameters.properties as any).behaviorCheck);
  assert.equal(behaviorToolCatalog(toolDefinitions, true), toolDefinitions);
  const f = baseFixture(); f.deps.tools.push(toolDefinitions.find(t => t.name === 'run_command')!);
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools.find((t: any) => t.function.name === 'run_command').function.parameters.properties.behaviorCheck, undefined);
    assert.doesNotMatch(body.messages.find((m: any) => m.role === 'system').content, /Tag run_command with behaviorCheck/);
    return reply('Done');
  } }).run({ sessionId: 's', text: 'Explain the code.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
});
