import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig, Project, RunRecord, Session } from '../src/shared/types';
import { StateStore } from '../src/backend/storage';
import { SessionService, migrateChatTitle } from '../src/backend/sessions';

const model = (id: string, enabled = true): ModelConfig => ({ id, name: id, kind: 'openai-compatible', baseUrl: 'https://fixture.example.test/v1', model: id, apiKeyEnv: '', contextWindow: 64000, maxOutputTokens: 1024, vision: false, enabled });
const project = (id: string): Project => ({ id, name: id, folders: [], internet: false, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' });
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-chat-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root), service = new SessionService(store);
  await store.mutate(state => { state.projects = [project('first'), project('second')]; state.models = [model('no-key'), model('connected'), { ...model('demo'), kind: 'demo' }]; });
  return { root, store, service };
}

test('a new chat inherits the last selected model, mode and reasoning for its own project', async t => {
  const { service, store } = await fixture(t);
  const first = await service.create('first', 'connected');
  await service.update(first.id, { mode: 'bypass', reasoningEffort: 'high' });
  const second = await service.create('first', 'no-key');
  assert.deepEqual([second.modelId, second.mode, second.reasoningEffort], ['connected', 'bypass', 'high']);
  assert.equal(second.title, 'Новый чат'); assert.equal(second.titleSource, 'default');
  assert.notEqual(second.id, first.id); assert.deepEqual(await store.messages(second.id), []);
  await service.update(second.id, { modelId: 'no-key', mode: 'plan', reasoningEffort: 'low' });
  await service.update(first.id, { rememberSelection: true });
  const third = await service.create('first', 'no-key');
  assert.deepEqual([third.modelId, third.mode, third.reasoningEffort], ['connected', 'bypass', 'high']);
  const other = await service.create('second', 'no-key');
  assert.equal(other.modelId, 'no-key'); assert.equal(other.reasoningEffort, 'auto'); assert.notEqual(other.mode, 'bypass');
});

test('selection remembers configuration during a running chat without changing its execution state', async t => {
  const { service, store } = await fixture(t);
  const chat = await service.create('first', 'connected');
  await service.update(chat.id, { status: 'running', mode: 'ask', reasoningEffort: 'medium' });
  const selected = await service.update(chat.id, { rememberSelection: true });
  assert.equal(selected.status, 'running');
  assert.deepEqual((await store.read()).projects[0].chatDefaults, { modelId: 'connected', mode: 'ask', reasoningEffort: 'medium' });
  await assert.rejects(service.update(chat.id, { archivedAt: new Date().toISOString() }), /остановите/);
});

test('archiving and restoring preserve message history, run billing, manual names and pinning across reload', async t => {
  const { service, store, root } = await fixture(t);
  const chat = await service.create('first', 'connected');
  await service.update(chat.id, { title: 'Своя история', pinned: true });
  const run: RunRecord = { id: 'fixture-run', projectId: 'first', sessionId: chat.id, modelId: 'connected', status: 'completed', phase: 'final', startedAt: '', steps: 1, stepLog: [], usage: { inputTokens: 100, outputTokens: 10, costUsd: .042, costSource: 'api', tokenSource: 'reported', cacheReadTokens: 80 }, limits: {} };
  await store.mutate(state => { state.runs = [run]; }); await store.appendMessage(chat.id, () => ({ id: 'user', role: 'user', content: 'Preserved', createdAt: '' }));
  const before = await store.read(), messages = await store.messages(chat.id);
  await service.update(chat.id, { archivedAt: '2026-10-07T15:00:00.000Z' });
  const reloadedStore = new StateStore(root), reloaded = new SessionService(reloadedStore);
  const archived = await reloaded.get(chat.id);
  assert.ok(archived.archivedAt); assert.equal(archived.title, 'Своя история'); assert.equal(archived.titleSource, 'manual'); assert.equal(archived.pinned, true);
  const restored = await reloaded.update(chat.id, { archivedAt: null });
  assert.equal(restored.archivedAt, undefined); assert.ok(!Object.hasOwn(restored, 'archivedAt'));
  assert.deepEqual(await reloadedStore.messages(chat.id), messages); assert.equal(messages[0].content, 'Preserved');
  assert.deepEqual((await reloadedStore.read()).runs, before.runs);
});

test('disabled inherited models fall back, while legacy chats still supply their selected defaults', async t => {
  const { service, store } = await fixture(t);
  const first = await service.create('first', 'connected');
  await service.update(first.id, { mode: 'plan', reasoningEffort: 'medium' });
  await store.mutate(state => { delete state.projects[0].chatDefaults; });
  assert.equal((await service.create('first', 'no-key')).modelId, 'connected');
  await store.mutate(state => { state.models.find(item => item.id === 'connected')!.enabled = false; });
  const fallback = await service.create('first', 'no-key');
  assert.deepEqual([fallback.modelId, fallback.mode, fallback.reasoningEffort], ['no-key', 'plan', 'medium']);
});

test('pinning sorts chats first and invalid metadata writes are atomic', async t => {
  const { service, store } = await fixture(t);
  const first = await service.create('first', 'connected'), second = await service.create('first', 'connected');
  await service.update(first.id, { pinned: true });
  assert.equal((await service.list('first'))[0].id, first.id);
  const before = await store.read();
  await assert.rejects(service.update(second.id, { pinned: 'yes' as unknown as boolean }));
  await assert.rejects(service.update(second.id, { archivedAt: 'not a date' }));
  await assert.rejects(service.update(second.id, { title: '   ' }));
  assert.deepEqual(await store.read(), before);
});

test('legacy default title migration preserves automatic and manually named chats', () => {
  const chat = { title: 'Новая задача' } as Session; migrateChatTitle(chat);
  assert.equal(chat.title, 'Новый чат'); assert.equal(chat.titleSource, 'default');
  const manual = { title: 'Новая задача', titleSource: 'manual' } as Session; migrateChatTitle(manual); assert.equal(manual.title, 'Новая задача');
  const automatic = { title: 'Название от модели', titleSource: 'automatic' } as Session; migrateChatTitle(automatic); assert.equal(automatic.title, 'Название от модели');
  const legacyManual = { title: 'Моё название' } as Session; migrateChatTitle(legacyManual); assert.equal(legacyManual.titleSource, 'manual');
});
