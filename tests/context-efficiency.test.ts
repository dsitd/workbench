import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, boundOutput, historyGroups, providerId } from '../src/agent/context';
import { boundedToolOutput, distinctReadGroups } from '../src/agent/context-history';
import { checkpointReference, updateContextCheckpoint } from '../src/agent/context-state';
import type { AgentDependencies } from '../src/shared/agent';
import type { AppSettings, ChatMessage, ModelConfig, PlanItem, Project, Session } from '../src/shared/types';

const project: Project = { id: 'p', name: 'Synthetic context', folders: [{ path: '/tmp/context-fixture', access: 'write' }], internet: false, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' };
const session: Session = { id: 's', projectId: 'p', modelId: 'm', title: 'Fixture', summary: '', status: 'idle', createdAt: '', updatedAt: '' };
const model: ModelConfig = { id: 'm', name: 'Fixture', kind: 'openai-responses', baseUrl: 'https://api.example.test/v1', apiKeyEnv: '', model: 'fixture', enabled: true, vision: true, contextWindow: 200_000, maxOutputTokens: 2000 };
const message = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: '', ...extra });
const version = `sha256:${'a'.repeat(64)}`, nextVersion = `sha256:${'b'.repeat(64)}`;
const read = (id: string, hash = version, range = '1-3', extra: Partial<ChatMessage> = {}): ChatMessage[] => [
  message(`a-${id}`, 'assistant', '', { toolCalls: [{ id, name: 'read_file', arguments: { path: 'api.ts' } }] }),
  message(`t-${id}`, 'tool', `/tmp/context-fixture/api.ts [version: ${hash}] (lines ${range})\n1: export const api = 1;`, { toolCallId: id, toolName: 'read_file', ...extra }),
];
function fixture(settings: Partial<AppSettings> = {}) {
  const resolvedImages: string[] = [];
  const deps: AgentDependencies = {
    getSession: async () => session, getProject: async () => project, getModel: async () => model, getMessages: async () => [], appendMessage: async () => {}, updateSession: async () => session,
    loadInstructions: async () => [{ path: '/tmp/context-fixture/AGENTS.md', scope: 'root', content: 'Keep exports stable.', writable: true }],
    listSkills: async () => [], readSkill: async () => '', getAttachment: async id => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 20, createdAt: '' }),
    resolveImage: async id => { resolvedImages.push(id); return { mimeType: 'image/png', base64: 'aW1hZ2U=' }; }, resolveCredential: async () => undefined,
    tools: [], executeTool: async () => ({ text: '' }), emit: () => {}, saveContext: () => {},
    getSettings: async () => ({ autoTitle: { enabled: false, model: 'fixture' }, runLimits: {}, contextBudgetTokens: 32_000, adaptiveContext: true, ...settings }),
  };
  return { deps, resolvedImages };
}
const signal = () => new AbortController().signal;
const publicHistory = (context: Awaited<ReturnType<typeof buildContext>>) => context.messages.filter(item => !item.contextData);
const checkpointData = (context: Awaited<ReturnType<typeof buildContext>>) => JSON.parse(context.messages.at(-1)!.content.split('\n\n').find(part => part.startsWith('{"kind":"workbench-task-checkpoint"'))!);

test('mutable pins, memory and map follow retained history without changing the stable instruction prefix', async () => {
  const { deps } = fixture();
  let revision = 1;
  deps.getProjectContext = async (_project, _query, _signal, _sessionId, paths) => {
    assert.ok(paths?.includes('api.ts'));
    return { pins: [{ source: `api.ts [version ${revision}]`, content: `source revision ${revision}` }], map: { files: [{ path: '/tmp/context-fixture/api.ts', relativePath: 'api.ts', kind: 'source', symbols: [`symbol${revision}`] }], scanned: 1, truncated: false, generatedAt: '' } };
  };
  const history = [message('u', 'user', 'Inspect api.ts'), ...read('r')];
  const first = await buildContext(deps, session, { ...project, memory: 'Decision one.' }, model, history, [], signal());
  revision = 2;
  const second = await buildContext(deps, session, { ...project, memory: 'Decision two.' }, model, history, [], signal());
  assert.equal(first.system, second.system);
  assert.deepEqual(publicHistory(first), publicHistory(second));
  assert.equal(second.messages.at(-1)!.contextData, true);
  assert.equal(second.messages.at(-2)!.toolCallId, 'r');
  assert.match(second.messages.at(-1)!.content, /source revision 2|symbol2|Decision two/);
  assert.doesNotMatch(second.system, /source revision|symbol2|Decision two/);
});

test('checkpoint stays stable until compaction and the saved actionable plan is quoted verbatim', async () => {
  const { deps } = fixture();
  const plan: PlanItem[] = [{ text: 'Read api.ts before editing.', status: 'running' }, { text: 'Run the user verification command.', status: 'pending' }];
  const initial = [message('u', 'user', 'Preserve the public export. Inspect api.ts.')];
  const first = await buildContext(deps, session, project, model, initial, [], signal(), { plan });
  const second = await buildContext(deps, session, project, model, [...initial, ...read('r')], [], signal(), { plan, checkpoint: first.checkpoint });
  assert.deepEqual(second.checkpoint, first.checkpoint);
  assert.deepEqual(checkpointData(second).savedPlan, plan);
  assert.equal(second.report.summaryUsed, false);
  assert.doesNotMatch(second.system, /Run the user verification command/);
});

test('volatile pin growth and an adaptive task transition never evict selected skill instructions', async () => {
  const { deps } = fixture();
  deps.listSkills = async () => [{ id: 'helper', name: 'helper', description: 'README task', source: 'fixture', enabled: true, installedAt: '', path: '/skills/helper' }];
  deps.readSkill = async () => 'Helpful policy '.repeat(220);
  let size = 100;
  deps.getProjectContext = async () => ({ pins: [{ source: 'README.md', content: 'x'.repeat(size) }] });
  const history = [message('u', 'user', 'README task')];
  const initial = await buildContext(deps, session, project, model, history, [], signal());
  size = 59_000;
  const expandedCatalog = [{ name: 'mcp_fixture_expanded', description: 'External tool description '.repeat(800), permission: 'mcp' as const, parameters: { type: 'object' } }];
  const later = await buildContext(deps, session, project, model, [...history, ...read('first'), ...read('second', nextVersion)], expandedCatalog, signal());
  assert.deepEqual(initial.report.selectedSkills, ['helper']);
  assert.deepEqual(later.report.selectedSkills, initial.report.selectedSkills);
  assert.equal(later.system, initial.system);
  assert.match(later.messages.at(-1)!.content, /x{100}/);
});

test('the compaction request already includes constraints, file versions and uncertain results', async () => {
  const { deps } = fixture({ contextPolicy: 'custom', contextBudgetTokens: 5000, adaptiveContext: false });
  const plan: PlanItem[] = [{ text: 'Inspect and verify.', status: 'running' }];
  const history = [message('u', 'user', 'Preserve public exports. Never run a paid API.')];
  for (let i = 0; i < 12; i++) history.push(...read(`r${i}`, i % 2 ? nextVersion : version, '1–3 of 3', { content: `/tmp/context-fixture/api.ts [version: ${i % 2 ? nextVersion : version}] (lines 1–3 of 3)\n${'source '.repeat(1000)}` }));
  history.push(message('command', 'assistant', '', { toolCalls: [{ id: 'cmd', name: 'run_command', arguments: { command: 'fixture-check' } }] }), message('error', 'tool', 'Interrupted; the action may already have happened.', { toolCallId: 'cmd', toolName: 'run_command', error: true }));
  const context = await buildContext(deps, session, project, model, history, [], signal(), { plan });
  const quoted = checkpointData(context);
  assert.ok(context.report.omittedMessages > 0 && context.report.summaryUsed);
  assert.ok(quoted.constraints.some((item: { text: string }) => /Never run a paid API/.test(item.text)));
  assert.match(quoted.files.at(-1).version, /^sha256:[a-f\d]{64}$/);
  assert.equal(quoted.files.at(-1).path, '/tmp/context-fixture/api.ts');
  assert.deepEqual(quoted.savedPlan, plan);
  assert.equal(publicHistory(context)[0].content, history[0].content);
  assert.equal(publicHistory(context).at(-1)!.toolCallId, 'cmd');
  const state = updateContextCheckpoint(history);
  assert.equal(state.observations.at(-1)!.status, 'uncertain');
});

test('incremental checkpoint never resurrects an old version after an edit and preserves late failures', () => {
  const history = [message('u', 'user', 'Keep the public API.'), ...read('r'), message('edit', 'assistant', '', { toolCalls: [{ id: 'e', name: 'edit_file', arguments: { path: 'api.ts' } }] }), message('edited', 'tool', 'Updated file', { toolCallId: 'e', toolName: 'edit_file' })];
  const before = updateContextCheckpoint(history.slice(0, 3));
  const after = updateContextCheckpoint(history.slice(3), before, history);
  assert.equal(after.files.length, 1);
  assert.equal(after.files[0].version, undefined);
  const replayed = updateContextCheckpoint(history.slice(0, 3), after, history);
  assert.equal(replayed.files[0].messageId, 'edited');
  assert.equal(replayed.files[0].version, undefined);
  assert.deepEqual(updateContextCheckpoint(history, after), after);
  const failure = updateContextCheckpoint([message('log', 'tool', `Started\n${'noise'.repeat(300)}\nLate error: verification failed.`, { toolName: 'run_command', error: true })]);
  assert.match(failure.observations[0].excerpt, /Late error: verification failed/);
  assert.equal(failure.observations[0].status, 'error');
});

test('checkpoint and plan references are bounded and label assistant outcomes as unverified excerpts', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 150; i++) history.push(message(`u${i}`, 'user', `Never change export ${i}. ${'x'.repeat(600)}`), message(`a${i}`, 'assistant', `Claim ${i}. ${'y'.repeat(600)}`), ...read(`r${i}`, nextVersion));
  const state = updateContextCheckpoint(history);
  assert.ok(JSON.stringify(state).length <= 12_000);
  assert.ok(state.constraints.length <= 8 && state.decisions.length <= 5 && state.files.length <= 18 && state.observations.length <= 10);
  assert.match(state.constraints.at(-1)!.text, /149/);
  const quoted = JSON.parse(checkpointReference(state, [{ text: 'Verify '.repeat(100), status: 'completed' }]));
  assert.match(quoted.provenance, /claims to verify/);
  assert.equal(quoted.savedPlan[0].truncated, true);
  assert.equal(quoted.savedPlan[0].text.length, 180);
});

test('identical reads preserve the prompt prefix while history fits', async () => {
  const { deps } = fixture();
  const latest = read('new');
  latest[0].providerId = providerId(model);
  latest[0].providerItems = [{ type: 'reasoning', id: 'opaque-fixture', encrypted_content: 'fixture-payload' }];
  const history = [message('u', 'user', 'Inspect api.ts'), ...read('old'), ...latest];
  const context = await buildContext(deps, session, project, model, history, [], signal());
  assert.deepEqual(publicHistory(context).map(item => item.toolCallId ?? item.toolCalls?.[0]?.id ?? item.role), ['user', 'old', 'old', 'new', 'new']);
  assert.deepEqual(publicHistory(context)[3].providerItems, latest[0].providerItems);
  assert.equal(context.report.omittedMessages, 0);
  assert.equal(context.summary, '');
  assert.ok(context.messages.some(item => item.toolCallId === 'old'));
});

test('changed ranges, versions, read errors, mutations and meaningful decisions remain in history', () => {
  for (const next of [read('new', nextVersion), read('new', version, '4-8'), read('new', version, '1-3', { error: true })]) {
    assert.equal(distinctReadGroups(historyGroups([...read('old'), ...next])).omitted.length, 0);
  }
  const mutation = [message('a-edit', 'assistant', '', { toolCalls: [{ id: 'edit', name: 'edit_file', arguments: { path: 'api.ts' } }] }), message('t-edit', 'tool', 'Edited', { toolCallId: 'edit', toolName: 'edit_file' })];
  assert.equal(distinctReadGroups(historyGroups([...read('old'), ...mutation, ...read('new')])).omitted.length, 0);
  const decision = read('old'); decision[0].content = 'This version exposes a compatibility problem; preserve the old symbol.';
  assert.equal(distinctReadGroups(historyGroups([...decision, ...read('new')])).omitted.length, 0);
});

test('bounded tool output preserves the fresh version header and tail error, with explicit omission', () => {
  const text = `/tmp/api.ts [version: ${version}] (lines 1-500)\n${'log\n'.repeat(10_000)}LAST ERROR: failed verification`;
  const bounded = boundOutput(text);
  assert.equal(bounded.length, 18_000);
  assert.match(bounded, new RegExp(`^/tmp/api.ts \\[version: ${version}`));
  assert.match(bounded, /Middle output omitted/);
  assert.match(bounded, /LAST ERROR: failed verification$/);
  assert.equal(boundedToolOutput(text, 20).length, 20);
  assert.equal(boundedToolOutput('unchanged'), 'unchanged');
});

test('image bytes expire after a successful presentation and a new inspection of the same image is allowed', async () => {
  const { deps, resolvedImages } = fixture();
  const inspection = (id: string, detail: 'low' | 'high') => [message(`a-${id}`, 'assistant', '', { toolCalls: [{ id, name: 'inspect_image', arguments: { attachmentId: 'image', detail } }] }), message(`t-${id}`, 'tool', 'Selected image', { toolCallId: id, toolName: 'inspect_image', attachmentIds: ['image'] })];
  const history = [message('u', 'user', 'Read the small labels in this image.', { attachmentIds: ['image'] }), ...inspection('first', 'high')];
  const first = await buildContext(deps, session, project, model, history, [], signal());
  assert.deepEqual(first.resolvedImageMessageIds, ['t-first']);
  assert.equal(first.messages.find(item => item.contextData && item.images)?.images?.[0].detail, 'high');
  const second = await buildContext(deps, session, project, model, history, [], signal(), { selection: first.selection, presentedImageMessageIds: first.resolvedImageMessageIds });
  assert.deepEqual(second.resolvedImageMessageIds, []);
  assert.deepEqual(resolvedImages, ['image']);
  assert.deepEqual(publicHistory(second), publicHistory(first));
  assert.match(publicHistory(second).at(-1)!.content, /Local image reference/);
  assert.equal(second.report.attachmentCount, 0);
  const again = await buildContext(deps, session, project, model, [...history, message('observed', 'assistant', 'Label is 42.'), ...inspection('again', 'low')], [], signal(), { selection: second.selection, presentedImageMessageIds: first.resolvedImageMessageIds });
  assert.deepEqual(again.resolvedImageMessageIds, ['t-again']);
  assert.deepEqual(resolvedImages, ['image', 'image']);
  assert.equal(again.messages.find(item => item.contextData && item.images)?.images?.[0].detail, 'low');
});

test('model-window policy preserves the same capacity for short and complex tasks; custom limits are explicit', async () => {
  const { deps } = fixture();
  const small = await buildContext(deps, session, project, model, [message('u', 'user', 'Fix one typo.')], [], signal());
  assert.equal(small.report.budget, 196_976);
  assert.match(small.report.sections.find(item => item.name === 'Выбор бюджета')!.reason, /Окно модели/);
  const complex = await buildContext(deps, session, project, model, [message('u', 'user', 'Detailed task '.repeat(200))], [], signal());
  assert.equal(complex.report.budget, 196_976);
  const fixed = fixture({ contextPolicy: 'custom', contextBudgetTokens: 20_000 });
  assert.equal((await buildContext(fixed.deps, session, project, model, [message('u', 'user', 'Fix one typo.')], [], signal())).report.budget, 20_000);
});
