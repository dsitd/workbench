import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, RunRecord, ToolCall } from '../src/shared/types';
import { accessScope } from '../src/shared/task-evidence';
import { validateToolArguments, nativeStrictSchema, normalizeToolArguments } from '../src/shared/tool-schema';
import { recordTaskMemory, taskMemoryTool, taskMemorySources, identifiedNote, MAX_ACTIVE_NOTES } from '../src/agent/task-memory';
import { completionResult } from '../src/agent/task-contract';
import { buildContext } from '../src/agent/context';
import type { ContextWorkState } from '../src/agent/context-state';
import { AgentRuntime } from '../src/agent';
import { harnessFixture, reply, tool } from './agent-fixture';

const user: ChatMessage = { id: 'original', role: 'user', content: 'Fix keyboard navigation. Preserve the public API. Investigate the shared controller.', createdAt: '' };
function setup() {
  const fixture = harnessFixture();
  const run: RunRecord = { id: 'r', projectId: 'p', sessionId: 's', modelId: 'm', status: 'running', phase: 'tools', startedAt: '',
    steps: 0, stepLog: [], limits: {}, usage: { inputTokens: 0, outputTokens: 0, tokenSource: 'estimated', costSource: 'unknown' },
    evidenceScope: accessScope(fixture.project), checkpoint: { userMessageId: user.id } };
  return { fixture, run };
}
const call = (args: Record<string, unknown>): ToolCall => ({ id: 'memory-call', name: taskMemoryTool.name, arguments: args });
function save(run: RunRecord, args: Record<string, unknown>, history = [user]) {
  const request = call({ text: 'Use the shared controller.', kind: 'decision', sourceMessageIds: [user.id], ...args });
  validateToolArguments(taskMemoryTool, request.arguments);
  return JSON.parse(recordTaskMemory(request, run, history).text);
}

test('task memory preserves causal detail, supports explicit updates and closures, and keeps legacy calls valid', () => {
  const { run } = setup();
  const saved = save(run, { rationale: 'One owner prevents double focus events.' });
  const rejected = save(run, { kind: 'rejected_hypothesis', text: 'The event listener is duplicated.', rationale: 'Inspected one registration; the actual problem is focus order.' });
  assert.equal(run.taskNotes?.length, 2);
  save(run, { id: saved.id, rationale: 'Shared ownership also preserves Shift+Tab.' });
  assert.equal(run.taskNotes?.length, 2);
  assert.equal(run.taskNotes?.find(note => note.id === saved.id)?.rationale, 'Shared ownership also preserves Shift+Tab.');
  save(run, { id: saved.id, text: 'Use one controller for forward and reverse navigation.' });
  assert.equal(run.taskNotes?.find(note => note.id === saved.id)?.rationale, 'Shared ownership also preserves Shift+Tab.', 'a text update must not silently erase its reason');
  const closed = save(run, { id: rejected.id, kind: 'rejected_hypothesis', text: 'The event listener is duplicated.', rationale: 'New trace disproves the earlier investigation.', status: 'superseded' });
  assert.equal(closed.status, 'superseded');
  assert.ok(closed.note.rationale, 'the tool receipt retains the reason for closure in full history');
  assert.ok(!run.taskNotes?.some(note => note.id === rejected.id));
  assert.equal(save(run, {}).saved, true, 'old decision calls without new optional fields still work');
});

test('active memory is not silently evicted by note count or size limits', () => {
  const { run } = setup();
  for (let i = 0; i < MAX_ACTIVE_NOTES; i++) save(run, { text: `Decision ${i}` });
  const before = structuredClone(run.taskNotes);
  assert.throws(() => save(run, { text: 'One more decision' }), /Память задачи заполнена/);
  assert.deepEqual(run.taskNotes, before);
  save(run, { id: before![0].id, text: 'This investigation is resolved.', status: 'resolved' });
  save(run, { text: 'One more decision' });
  assert.equal(run.taskNotes?.length, MAX_ACTIVE_NOTES);
  const large = setup().run;
  let rejected = false;
  for (let i = 0; i < 12; i++) {
    const snapshot = structuredClone(large.taskNotes);
    try { save(large, { text: `${i}:` + 'x'.repeat(1500), rationale: 'y'.repeat(1100) }); }
    catch (error) { assert.match(String(error), /Память задачи заполнена/); assert.deepEqual(large.taskNotes, snapshot); rejected = true; break; }
  }
  assert.ok(rejected);
});

test('user constraints require exact user quotes; sources and note IDs remain access scoped', () => {
  const { run } = setup();
  const foreign: ChatMessage = { id: 'foreign', role: 'tool', toolName: 'read_file', content: 'Preserve the public API.', createdAt: '', accessScope: 'other-scope' };
  assert.throws(() => save(run, { kind: 'constraint' }), /точную цитату/);
  assert.throws(() => save(run, { kind: 'objective', sourceQuote: 'Publish the app.' }), /точную цитату/);
  assert.throws(() => save(run, { sourceMessageIds: ['foreign'] }, [user, foreign]), /публичные доступные/);
  const saved = save(run, { kind: 'constraint', text: 'Keep the public API.', sourceQuote: 'Preserve the public API.' });
  run.evidenceScope = 'changed';
  assert.throws(() => save(run, { id: saved.id }), /недоступна/);
  assert.throws(() => save(run, { kind: 'rejected_hypothesis' }), /причину/);
  const sources = JSON.parse(taskMemorySources([user, foreign], run.evidenceScope));
  assert.deepEqual(sources.sources.map((item: { messageId: string }) => item.messageId), [user.id]);
});

test('oversized legacy memory can be reduced incrementally without silently deleting records', () => {
  const { run } = setup();
  run.taskNotes = Array.from({ length: 12 }, (_, i) => ({ text: `${i}:` + 'x'.repeat(1500), kind: 'finding', sourceMessageIds: [user.id], scope: run.evidenceScope }));
  const id = identifiedNote(run.taskNotes[0]).id;
  save(run, { id, text: 'Resolved earlier finding.', kind: 'finding', status: 'resolved' });
  assert.equal(run.taskNotes.length, 11);
  assert.ok(JSON.stringify(run.taskNotes).length > 16_000, 'the partial reduction must succeed while still over the new bound');
});

test('notes never satisfy acceptance criteria and strict wire schemas retain optional-field compatibility', () => {
  const { run } = setup();
  run.acceptanceCriteria = [{ id: 'fix', text: 'Fix keyboard navigation.', sourceQuote: 'Fix keyboard navigation.', sourceMessageId: user.id }];
  save(run, { kind: 'finding', text: 'All tests pass.' });
  assert.equal(completionResult(run).error, true);
  assert.ok(nativeStrictSchema('https://api.openai.com/v1', taskMemoryTool));
  const args = normalizeToolArguments(taskMemoryTool, { text: 'Investigate focus.', kind: 'next_step', sourceMessageIds: [user.id], id: null, rationale: null, sourceQuote: null, status: null });
  validateToolArguments(taskMemoryTool, args);
  assert.equal(Object.hasOwn(args, 'status'), false);
});

test('causal memory survives repeated actual compactions and JSON resume without resurfacing superseded notes', async () => {
  const { run, fixture } = setup();
  fixture.model.contextWindow = 100_000;
  fixture.deps.getSettings = async () => ({ autoTitle: { enabled: false, model: 'fixture' }, runLimits: {}, contextPolicy: 'custom', contextBudgetTokens: 7000, adaptiveContext: false });
  save(run, { kind: 'objective', text: 'Fix keyboard navigation.', sourceQuote: 'Fix keyboard navigation.' });
  save(run, { kind: 'constraint', text: 'Preserve public API compatibility.', sourceQuote: 'Preserve the public API.' });
  save(run, { rationale: 'One owner prevents double focus events.' });
  save(run, { kind: 'rejected_hypothesis', text: 'Duplicate listener causes the bug.', rationale: 'One registration was found; investigate ordering instead.' });
  const question = save(run, { kind: 'open_question', text: 'Does Shift+Tab use the same controller?' });
  save(run, { kind: 'next_step', text: 'Test reverse focus order.' });
  const history = [user];
  let state: ContextWorkState = { taskNotes: run.taskNotes };
  const epochs = new Set<number>();
  for (let i = 0; i < 8; i++) {
    history.push({ id: `assistant-${i}`, role: 'assistant', content: '', createdAt: '', accessScope: run.evidenceScope,
      toolCalls: [{ id: `read-${i}`, name: 'read_file', arguments: { path: `focus-${i}.ts` } }] },
    { id: `output-${i}`, role: 'tool', content: 'code '.repeat(2200), createdAt: '', toolCallId: `read-${i}`, toolName: 'read_file', accessScope: run.evidenceScope });
    if (i === 4) {
      save(run, { id: question.id, kind: 'open_question', text: 'Confirmed shared controller for reverse order.', status: 'resolved' });
      state.taskNotes = run.taskNotes;
    }
    const context = await buildContext(fixture.deps, fixture.session, fixture.project, fixture.model, history, [...fixture.deps.tools, taskMemoryTool], new AbortController().signal, state);
    epochs.add(context.selection.epoch);
    const snapshot = context.messages.filter(message => message.contextData).map(message => message.content).join('\n');
    assert.match(snapshot, /One owner prevents double focus events/);
    assert.match(snapshot, /One registration was found/);
    assert.match(snapshot, /Preserve public API compatibility/);
    assert.match(snapshot, /Test reverse focus order/);
    if (i >= 4) assert.doesNotMatch(snapshot, /Does Shift\+Tab use the same controller/);
    assert.ok(context.report.estimatedTokens <= context.report.budget);
    state = JSON.parse(JSON.stringify({ checkpoint: context.checkpoint, selection: context.selection, taskNotes: state.taskNotes }));
  }
  assert.ok(epochs.size >= 3, 'must exercise several real history compactions, not only serialize a note');
  const changed = await buildContext(fixture.deps, fixture.session, { ...fixture.project, internet: false }, fixture.model, history,
    [...fixture.deps.tools, taskMemoryTool], new AbortController().signal, state);
  assert.doesNotMatch(changed.messages.filter(message => message.contextData).map(message => message.content).join('\n'), /One owner prevents double focus events/);
});

test('runtime loads memory explicitly for long history and restores it when a limited run resumes', async () => {
  const fixture = harnessFixture({ contextWindow: 100_000 });
  fixture.deps.executeTool = async () => ({ text: 'inspected code '.repeat(1700) });
  let step = 0;
  const runtime = new AgentRuntime(fixture.deps, { maxSteps: 7, fetch: async (_url, init) => {
    const body = String(init?.body);
    if (step++ < 4) {
      assert.doesNotMatch(body, /"name":"record_task_note"/);
      return reply('', undefined, 'tool_calls', [tool(`read-${step}`, 'read_file', { path: `focus-${step}.ts` })]);
    }
    if (step === 5) {
      assert.doesNotMatch(body, /"name":"record_task_note"/);
      return reply('', undefined, 'tool_calls', [tool('load-memory', 'load_task_tools', { names: ['record_task_note'] })]);
    }
    assert.match(body, /"name":"record_task_note"/);
    assert.match(body, /task-memory-sources/);
    if (step === 6) return reply('', undefined, 'tool_calls', [tool('memory', 'record_task_note', {
      kind: 'decision', text: 'Use the shared controller.', rationale: 'Keep focus ownership in one place.', sourceMessageIds: [fixture.messages[0].id],
    })]);
    assert.match(body, /Keep focus ownership in one place/);
    return reply('', undefined, 'tool_calls', [tool('more', 'read_file', { path: 'reverse.ts' })]);
  } });
  await runtime.run({ sessionId: 's', text: 'Investigate focus navigation.', attachmentIds: [] });
  const parent = JSON.parse(JSON.stringify(fixture.lastRun())) as RunRecord;
  assert.equal(parent.status, 'limited');
  fixture.runs.set(parent.id, parent);
  await new AgentRuntime(fixture.deps, { fetch: async (_url, init) => {
    assert.match(String(init?.body), /Keep focus ownership in one place/);
    assert.match(String(init?.body), /"name":"record_task_note"/);
    return reply('Investigation complete.');
  } }).resume('s', parent.id);
  assert.equal(fixture.lastRun().status, 'completed');
  assert.deepEqual(fixture.lastRun().taskNotes, parent.taskNotes);
});

test('growing history does not inject an unused memory schema or change the system prompt', async () => {
  const fixture = harnessFixture({ contextWindow: 200_000 });
  fixture.deps.executeTool = async () => ({ text: 'observed content '.repeat(1600) });
  let step = 0, schemas = '', policy = '';
  await new AgentRuntime(fixture.deps, { maxSteps: 27, maxRunTokens: 10_000_000, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const current = JSON.stringify(body.tools);
    if (!step) { schemas = current; policy = body.messages[0].content; }
    assert.equal(current, schemas, 'tool schemas must remain stable across the 60000-character and 48-message thresholds');
    assert.equal(body.messages[0].content, policy);
    assert.doesNotMatch(current, /"name":"record_task_note"/);
    return step++ < 25 ? reply('', undefined, 'tool_calls', [tool(`read-${step}`, 'read_file', { path: `file-${step}.ts` })]) : reply('Done');
  } }).run({ sessionId: 's', text: 'Investigate several source files.', attachmentIds: [] });
  assert.equal(fixture.lastRun().status, 'completed');
  assert.equal(step, 26);
});
