import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { harnessFixture, reply, tool } from './agent-fixture';
import { checkedPlan, planTool } from '../src/agent/plan';
import { validateToolArguments } from '../src/shared/tool-schema';
import { executeTaskTool, observeTaskTool, completionResult } from '../src/agent/task-contract';
import type { RunRecord, ChatMessage } from '../src/shared/types';
import { workspaceToolCatalog } from '../src/agent/workspace-tool-discovery';

test('common in_progress plan status is accepted and stored as canonical running', () => {
  const args = { items: [{ text: 'Implement behavior', status: 'in_progress' }] };
  validateToolArguments(planTool, args);
  assert.equal(checkedPlan(args)[0].status, 'running');
  assert.throws(() => validateToolArguments(planTool, { items: [{ text: 'x', status: 'private-invalid-value' }] }), error =>
    /pending/.test(String(error)) && /running/.test(String(error)) && !String(error).includes('private-invalid-value'));
});

test('an explicitly bound successful observation satisfies its contract without a bookkeeping model call', async () => {
  const f = harnessFixture(); let request = 0;
  f.deps.executeTool = async () => ({ text: 'Expected content' });
  await new AgentRuntime(f.deps, { fetch: async () => {
    if (++request === 1) return reply('', undefined, 'tool_calls', [tool('load', 'load_task_tools', { names: ['set_task_criteria'] })]);
    if (request === 2) return reply('', undefined, 'tool_calls', [
      tool('criteria', 'set_task_criteria', { criteria: [{ id: 'result', text: 'Expected content exists', sourceQuote: 'Expected content', toolName: 'read_file', expectedText: 'Expected content' }] }),
      tool('observation', 'read_file', { path: 'result.txt' }),
    ]);
    return reply('Done');
  } }).run({ sessionId: 's', text: 'Inspect Expected content', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(f.lastRun().acceptanceCriteria?.[0].evidence?.toolCallId, 'observation');
  assert.equal(request, 3);
});

function evidenceFixture() {
  const user: ChatMessage = { id: 'user', role: 'user', content: 'Check alpha and beta', createdAt: '' };
  const observation: ChatMessage = { id: 'observed', role: 'tool', content: 'alpha beta', toolName: 'read_file', toolCallId: 'call-read', createdAt: '' };
  const run = { checkpoint: { userMessageId: 'user' }, mutationRevision: 2, evidenceScope: 'scope', acceptanceCriteria: [
    { id: 'a', text: 'Check alpha', sourceQuote: 'alpha', sourceMessageId: 'user' },
    { id: 'b', text: 'Check beta', sourceQuote: 'beta', sourceMessageId: 'user', expectedText: 'beta' },
  ] } as RunRecord;
  observeTaskTool(run, observation);
  return { run, history: [user, observation] };
}
test('batch evidence is atomic and retains freshness, scope, and matching checks', () => {
  const { run, history } = evidenceFixture();
  const call = { id: 'batch', name: 'record_task_evidence', arguments: { criterionIds: ['a', 'missing'], toolCallId: 'call-read' } };
  assert.throws(() => executeTaskTool(call, run, history));
  assert.equal(run.acceptanceCriteria?.[0].evidence, undefined);
  call.arguments.criterionIds = ['a', 'b'];
  assert.throws(() => executeTaskTool(call, run, history), /toolName.*expectedText/);
  assert.ok(run.acceptanceCriteria!.every(criterion => !criterion.evidence));
  run.acceptanceCriteria![0].expectedText = 'alpha';
  for (const criterion of run.acceptanceCriteria!) criterion.toolName = 'read_file';
  call.arguments.criterionIds = ['a', 'b']; executeTaskTool(call, run, history);
  assert.equal(completionResult(run).error, false);
  run.mutationRevision = 3;
  assert.equal(completionResult(run).error, true);
  assert.throws(() => executeTaskTool(call, run, history), /изменения/);
  run.mutationRevision = 2; run.evidenceScope = 'another-scope';
  assert.throws(() => executeTaskTool(call, run, history), /права/);
});
test('automatic evidence never accepts unbound, failed, mismatched, or stale verification observations', () => {
  for (const kind of ['unbound', 'error', 'mismatch', 'verification'] as const) {
    const { run, history } = evidenceFixture();
    const criterion = run.acceptanceCriteria![0];
    if (kind !== 'unbound') Object.assign(criterion, { toolName: kind === 'verification' ? 'verify_project' : 'read_file', expectedText: 'alpha' });
    const message = { ...history[1], toolName: criterion.toolName ?? 'read_file', error: kind === 'error', content: kind === 'mismatch' ? 'wrong' : 'alpha' };
    observeTaskTool(run, message);
    assert.equal(criterion.evidence, undefined, kind);
  }
});

test('workspace helper discovery does not expose unloaded or permission-filtered tools', async () => {
  const f = harnessFixture(); let requests = 0, executions = 0;
  f.deps.tools.push({ name: 'read_history', description: 'Read earlier messages', permission: 'read', parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } });
  f.deps.executeTool = async () => { executions++; return { text: 'Earlier requirement' }; };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const names = JSON.parse(String(init?.body)).tools.map((t:any) => t.function.name);
    if (++requests === 1) {
      assert.equal(names.includes('read_history'), false);
      assert.equal(names.includes('load_workspace_tools'), true);
      return reply('', undefined, 'tool_calls', [tool('load', 'load_workspace_tools', { names: ['read_history'] })]);
    }
    assert.equal(names.includes('read_history'), true);
    return requests === 2 ? reply('', undefined, 'tool_calls', [tool('read-earlier', 'read_history', { messageId: 'earlier' })]) : reply('Done');
  } }).run({ sessionId: 's', text: 'Recover earlier requirement', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed'); assert.equal(executions, 1);
  assert.deepEqual(f.lastRun().loadedWorkspaceToolNames, ['read_history']);
  const catalog = workspaceToolCatalog(f.deps.tools, ['reconcile_operation']);
  assert.equal(catalog.some(t => t.name === 'reconcile_operation'), false);
  assert.throws(() => validateToolArguments(catalog.find(t => t.name === 'load_workspace_tools')!, { names: ['reconcile_operation'] }));
});
