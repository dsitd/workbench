import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceServices } from '../src/backend';
import { flashPreset, modelPresets } from '../src/shared/model-presets';
import { fallbackChatModel } from '../src/renderer/chat-navigation';
import { chatBody } from '../src/agent/mappings';
import { providerId } from '../src/agent/reasoning';

const callbacks = { approve: async () => true, emit: () => undefined };
test('Flash becomes the default once, shares only a confirmed OpenRouter key, and preserves history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flash-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project'));
  const service = new WorkspaceServices(path.join(root, 'data'), callbacks);
  await service.bootstrap();
  const project = await service.createProject({ name: 'Test', folders: [{ path: path.join(root, 'project'), access: 'write' }] });
  const oldId = modelPresets[0].id;
  const history = await service.createSession(project.id, oldId);
  await service.appendMessage(history.id, { id: 'message', role: 'user', content: 'Existing history', createdAt: new Date().toISOString() });
  const empty = await service.createSession(project.id, oldId);
  await service.store.mutate(state => {
    delete state.flashDefaultInitialized;
    state.models = state.models.filter(model => model.id !== flashPreset.id);
    state.projects[0].chatDefaults = { modelId: oldId, mode: 'plan', reasoningEffort: 'low' };
  });
  const reopened = new WorkspaceServices(path.join(root, 'data'), callbacks);
  const boot = await reopened.bootstrap(id => id === oldId);
  const flash = boot.models.find(model => model.id === flashPreset.id)!;
  assert.equal(flash.credentialModelId, oldId);
  assert.equal((await reopened.getSession(history.id)).modelId, oldId);
  assert.equal((await reopened.getMessages(history.id)).length, 1);
  assert.equal((await reopened.getSession(empty.id)).modelId, flash.id);
  const next = await reopened.createSession(project.id, oldId);
  assert.equal(next.modelId, flash.id);
  assert.equal(next.mode, 'plan');
  assert.equal(next.reasoningEffort, 'high');
  await reopened.sessions.update(next.id, { modelId: oldId, reasoningEffort: 'low' });
  await reopened.sessions.update(empty.id, { modelId: oldId });
  await reopened.deleteModel(flash.id);
  const restart = new WorkspaceServices(path.join(root, 'data'), callbacks);
  assert.equal((await restart.bootstrap()).models.some(model => model.id === flash.id), false);
  assert.equal((await restart.createSession(project.id)).modelId, oldId);
});

test('fresh installs select Flash and do not invent a credential reference', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flash-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project'));
  const service = new WorkspaceServices(path.join(root, 'data'), callbacks);
  const boot = await service.bootstrap(() => false);
  const flash = boot.models.find(model => model.id === flashPreset.id)!;
  assert.equal(flash.credentialModelId, undefined);
  assert.equal(fallbackChatModel(boot.models)?.id, flash.id);
  const project = await service.createProject({ name: 'Fresh', folders: [{ path: path.join(root, 'project'), access: 'write' }] });
  assert.equal((await service.createSession(project.id)).modelId, flash.id);
});

test('Flash Chat API preserves reasoning and tool IDs and accepts images', () => {
  const model = { id: flashPreset.id, ...flashPreset.configuration };
  const details = [{ type: 'reasoning.text', text: 'Fixture reasoning', index: 0 }];
  const body = chatBody({ model, system: 'Fixture', signal: new AbortController().signal, reasoningEffort: 'medium',
    tools: [{ name: 'inspect', description: 'Inspect', permission: 'read', parameters: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Inspect', images: [{ mimeType: 'image/png', base64: 'AA==' }] },
      { role: 'assistant', content: '', providerId: providerId(model), reasoningDetails: details,
        toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }] },
      { role: 'tool', content: 'Done', toolCallId: 'call-1' },
    ] });
  assert.equal(body.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.messages[2].reasoning_details, details);
  assert.equal(body.messages[2].tool_calls[0].id, body.messages[3].tool_call_id);
  assert.equal(body.messages[1].content[1].type, 'image_url');
});
