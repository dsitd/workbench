import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, providerId } from '../src/agent/context';
import { chatBody } from '../src/agent/mappings';
import type { AgentDependencies, ModelMessage } from '../src/shared/agent';
import type { ChatMessage, ModelConfig, Project, Session, ToolDefinition } from '../src/shared/types';
import type { ContextWorkState } from '../src/agent/context-state';

const project: Project = { id: 'p', name: 'Epoch fixture', folders: [{ path: '/tmp/epoch-fixture', access: 'write' }], internet: false, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' };
const session: Session = { id: 's', projectId: 'p', modelId: 'm', title: 'Fixture', summary: '', status: 'idle', createdAt: '', updatedAt: '' };
const model: ModelConfig = { id: 'm', name: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5', apiKeyEnv: '', enabled: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 8192 };
const tools: ToolDefinition[] = [{ name: 'read_file', description: 'Read a selected range.', permission: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: '', ...extra });
const version = `sha256:${'a'.repeat(64)}`;
const read = (id: string, size = 14_000, file = id): ChatMessage[] => [msg(`a-${id}`, 'assistant', '', { toolCalls: [{ id, name: 'read_file', arguments: { path: `${file}.ts` } }], providerId: providerId(model), reasoningDetails: [{ type: 'reasoning.encrypted', data: `opaque-${id}`, signature: 'fixture' }] }), msg(`t-${id}`, 'tool', `/tmp/epoch-fixture/${file}.ts [version: ${version}] (lines 1–200 of 200)\n${'data '.repeat(Math.ceil(size / 5)).slice(0, size)}`, { toolCallId: id, toolName: 'read_file' })];
function deps(): AgentDependencies {
  return { getSession: async () => session, getProject: async () => project, getModel: async () => model, getMessages: async () => [], appendMessage: async () => {}, updateSession: async () => session,
    getSettings: async () => ({ autoTitle: { enabled: false, model: 'fixture' }, runLimits: {}, contextPolicy: 'custom', contextBudgetTokens: 32_000, adaptiveContext: true }), loadInstructions: async () => [], listSkills: async () => [], readSkill: async () => '',
    getAttachment: async id => ({ id, name: `${id}.png`, size: 20, mimeType: 'image/png', createdAt: '' }), resolveImage: async () => ({ mimeType: 'image/png', base64: 'aW1n' }), resolveCredential: async () => undefined,
    getProjectContext: async () => ({ pins: [] }), tools: [], executeTool: async () => ({ text: '' }), emit: () => {}, saveContext: () => {} };
}
const signal = () => new AbortController().signal;
const conversation = (context: Awaited<ReturnType<typeof buildContext>>) => context.messages.filter(message => !message.contextData);

test('loading a tool preserves fitting history instead of compacting at the reset threshold', async () => {
  const dependencies = deps(), history = [msg('u', 'user', 'Inspect the implementation.')];
  let current = await buildContext(dependencies, session, project, model, history, tools, signal());
  for (let i = 0; i < 4; i++) {
    history.push(...read(`grow-${i}`, 17000));
    current = await buildContext(dependencies, session, project, model, history, tools, signal(), { selection: current.selection, checkpoint: current.checkpoint });
  }
  const changed = await buildContext(dependencies, session, project, model, history,
    [...tools, { name: 'get_operation', description: 'Inspect operation.', permission: 'read', parameters: { type: 'object' } }],
    signal(), { selection: current.selection, checkpoint: current.checkpoint });
  assert.equal(changed.selection.lastCompaction?.reason, 'policy-change');
  assert.deepEqual(changed.selection.selectedMessageIds, current.selection.selectedMessageIds, 'A schema refresh must not discard history that still fits');
});
function normalized(message: ModelMessage): string {
  return JSON.stringify({ ...message, content: message.content, images: undefined });
}
function cachedPrefix(context: Awaited<ReturnType<typeof buildContext>>): unknown[] {
  const body = chatBody({ model, system: context.system, messages: context.messages, tools, signal: signal(), sessionId: session.id, cachePolicy: { enabled: true, ttl: '5m' } });
  return body.messages.filter((message: any) => !(typeof message.content === 'string' ? message.content : message.content?.[0]?.text)?.startsWith('Workbench local reference snapshot')).map((message: any) => ({ ...message,
    content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content?.map(({ cache_control, ...block }: any) => block) }));
}

test('eight prior groups plus a twelve-step run append history within epochs and compact in batches', async () => {
  const history: ChatMessage[] = [msg('old-u', 'user', 'Earlier completed task')];
  for (let i = 1; i <= 8; i++) history.push(...read(`old${i}`));
  history.push(msg('old-final', 'assistant', 'Earlier task complete.'), msg('new-u', 'user', 'Inspect the project now.'));
  const dependencies = deps();
  let previous: Awaited<ReturnType<typeof buildContext>> | undefined;
  let state: ContextWorkState = {};
  let transitions = 0;
  const initiallyOmitted = new Set<string>();
  for (let step = 1; step <= 12; step++) {
    if (step === 2) { const first = read('new1'), second = read('new2'); history.push(msg('multi', 'assistant', '', { toolCalls: [first[0].toolCalls![0], second[0].toolCalls![0]] }), first[1], second[1]); }
    if (step > 2) history.push(...read(`new${step}`));
    const current = await buildContext(dependencies, session, project, model, history, tools, signal(), state);
    const selection = current.selection;
    if (step === 1) for (const message of history) if (message.toolCallId && !conversation(current).some(item => item.toolCallId === message.toolCallId)) initiallyOmitted.add(message.toolCallId);
    for (const id of initiallyOmitted) assert.ok(!conversation(current).some(item => item.toolCallId === id), `previously omitted ${id} was reinserted at step ${step}`);
    if (previous) {
      const sameEpoch = selection.epoch === previous.selection.epoch;
      if (sameEpoch) {
        assert.deepEqual(conversation(current).slice(0, conversation(previous).length).map(normalized), conversation(previous).map(normalized), `old prefix changed inside epoch at step ${step}`);
        assert.deepEqual(cachedPrefix(current).slice(0, cachedPrefix(previous).length), cachedPrefix(previous), `mapped provider prefix changed at step ${step}`);
      } else { transitions++; assert.equal(selection.lastCompaction!.reason, 'budget'); }
    }
    assert.ok(current.report.estimatedTokens <= current.report.budget);
    assert.ok(current.report.estimatedTokens <= 32_000, `history grew past the target at step ${step}`);
    assert.ok(conversation(current).some(item => item.role === 'user' && item.content === 'Inspect the project now.'));
    for (const [index, message] of conversation(current).entries()) if (message.toolCalls) for (const [offset, call] of message.toolCalls.entries()) assert.equal(conversation(current)[index + 1 + offset].toolCallId, call.id);
    state = { checkpoint: current.checkpoint, selection };
    previous = current;
  }
  assert.ok(transitions > 0 && transitions <= 5, `expected batched transitions, got ${transitions}`);
});

test('a repeated successful read does not delete an already presented group within an epoch', async () => {
  const dependencies = deps();
  const history = [msg('u', 'user', 'Read api.ts'), ...read('first', 200, 'api')];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  const second = await buildContext(dependencies, session, project, model, [...history, ...read('again', 200, 'api')], tools, signal(), { checkpoint: first.checkpoint, selection: first.selection });
  assert.deepEqual(conversation(second).slice(0, conversation(first).length).map(normalized), conversation(first).map(normalized));
  assert.deepEqual(conversation(second).filter(item => item.toolCallId).map(item => item.toolCallId), ['first', 'again']);
});

test('one-shot image payload remains outside the immutable history cache boundary', async () => {
  const dependencies = deps();
  const history = [msg('u', 'user', 'Inspect this image.'), msg('call', 'assistant', '', { toolCalls: [{ id: 'img', name: 'inspect_image', arguments: { attachmentId: 'image', detail: 'high' } }] }), msg('image-result', 'tool', 'Selected image.', { toolCallId: 'img', toolName: 'inspect_image', attachmentIds: ['image'] })];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  assert.equal(conversation(first).at(-1)!.images, undefined);
  const frame = first.messages.find(item => item.contextData && item.images?.length);
  assert.ok(frame); assert.match(frame.content, /img|image-result/); assert.equal(frame.images![0].detail, 'high');
  const next = await buildContext(dependencies, session, project, model, [...history, msg('observed', 'assistant', 'Label is 42.')], tools, signal(), { selection: first.selection, checkpoint: first.checkpoint, presentedImageMessageIds: first.resolvedImageMessageIds });
  assert.deepEqual(conversation(next).slice(0, conversation(first).length).map(normalized), conversation(first).map(normalized));
  assert.equal(next.report.attachmentCount, 0);
});

test('resumed persisted selection preserves the prefix and does not resurrect old history', async () => {
  const dependencies = deps();
  const history: ChatMessage[] = [msg('u', 'user', 'Continue the saved task.')];
  for (let i = 1; i <= 8; i++) history.push(...read(`r${i}`));
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  // The resume path inherits only JSON metadata; it does not keep an in-memory prompt.
  const persisted: ContextWorkState = JSON.parse(JSON.stringify({ selection: first.selection, checkpoint: first.checkpoint }));
  const continued = await buildContext(dependencies, { ...session, status: 'running' }, project, model, [...history, ...read('next', 300)], tools, signal(), persisted);
  assert.equal(continued.selection.epoch, first.selection.epoch);
  assert.deepEqual(conversation(continued).slice(0, conversation(first).length).map(normalized), conversation(first).map(normalized));
  assert.deepEqual(continued.selection.selectedMessageIds, [...first.selection.selectedMessageIds, 'a-next', 't-next']);
});

test('same-ID content edits and reordered storage history invalidate the epoch explicitly', async () => {
  const dependencies = deps();
  const history = [msg('u', 'user', 'Inspect api.ts'), ...read('r', 200)];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  const changed = history.map(message => message.id === 't-r' ? { ...message, content: `${message.content}\nNew public result.` } : message);
  const second = await buildContext(dependencies, session, project, model, changed, tools, signal(), { selection: first.selection, checkpoint: first.checkpoint });
  assert.equal(second.selection.epoch, first.selection.epoch + 1);
  assert.equal(second.selection.lastCompaction!.reason, 'history-change');
  assert.match(conversation(second).at(-1)!.content, /New public result/);
  const reordered = await buildContext(dependencies, session, project, model, [...history.slice(1), history[0]], tools, signal(), { selection: first.selection });
  assert.equal(reordered.selection.lastCompaction!.reason, 'history-change');
});

test('fresh policy, model and tool schema changes reset selection without retaining stale rules', async () => {
  const dependencies = deps();
  let instruction = 'Preserve exported names.';
  dependencies.loadInstructions = async () => [{ path: '/tmp/epoch-fixture/AGENTS.md', scope: 'root', content: instruction, writable: true }];
  const history = [msg('u', 'user', 'Inspect api.ts'), ...read('r', 200)];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  instruction = 'Do not edit exported names.';
  const second = await buildContext(dependencies, session, project, model, history, tools, signal(), { selection: first.selection });
  assert.equal(second.selection.lastCompaction!.reason, 'policy-change');
  assert.match(second.system, /Do not edit exported names/);
  assert.doesNotMatch(second.system, /Preserve exported names/);
  const changedModel = await buildContext(dependencies, session, project, { ...model, model: 'another-provider-model' }, history, tools, signal(), { selection: second.selection });
  assert.equal(changedModel.selection.lastCompaction!.reason, 'policy-change');
  assert.equal(conversation(changedModel).find(item => item.role === 'assistant')!.reasoningDetails, undefined);
  const removedTools = await buildContext(dependencies, session, project, model, history, [], signal(), { selection: second.selection });
  assert.equal(removedTools.selection.lastCompaction!.reason, 'policy-change');
});

test('encountered nested task rules remain fresh after their original navigation path ages out', async () => {
  const dependencies = deps();
  let instruction = 'Nested convention v1.';
  dependencies.loadInstructions = async () => [{ path: '/tmp/epoch-fixture/nested/AGENTS.md', scope: '/tmp/epoch-fixture/nested', content: instruction, writable: true }];
  const history = [msg('u', 'user', 'Inspect project'), ...read('nested', 100, 'nested/api')];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  assert.match(first.system, /Nested convention v1/);
  for (let i = 0; i < 14; i++) history.push(msg(`progress${i}`, 'assistant', `Verified public step ${i}.`));
  const second = await buildContext(dependencies, session, project, model, history, tools, signal(), { selection: first.selection });
  assert.equal(second.system, first.system);
  assert.equal(second.selection.epoch, first.selection.epoch);
  instruction = 'Nested convention v2.';
  const fresh = await buildContext(dependencies, session, project, model, history, tools, signal(), { selection: second.selection });
  assert.equal(fresh.selection.lastCompaction!.reason, 'policy-change');
  assert.match(fresh.system, /Nested convention v2/);
});

test('a newly completed parallel group enters atomically after an incomplete watermark', async () => {
  const dependencies = deps();
  const firstRead = read('one', 100), secondRead = read('two', 100);
  const history = [msg('u', 'user', 'Read two files'), msg('parallel', 'assistant', '', { toolCalls: [firstRead[0].toolCalls![0], secondRead[0].toolCalls![0]] }), firstRead[1]];
  const first = await buildContext(dependencies, session, project, model, history, tools, signal());
  assert.deepEqual(conversation(first).map(item => item.role), ['user']);
  const second = await buildContext(dependencies, session, project, model, [...history, secondRead[1]], tools, signal(), { selection: first.selection, checkpoint: first.checkpoint });
  assert.equal(second.selection.epoch, first.selection.epoch);
  assert.deepEqual(conversation(second).map(item => item.role), ['user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(conversation(second).slice(-2).map(item => item.toolCallId), ['one', 'two']);
});
