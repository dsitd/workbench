import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Bootstrap, ChatMessage } from '../src/shared/types';
import { applyStatusUpdates, mergeLoadedMessages } from '../src/renderer/state';

const message = (id: string, content: string): ChatMessage => ({ id, content, role: 'assistant', createdAt: '2026-10-06T00:00:00Z' });

test('session history arriving late preserves a final live answer and historical order', () => {
  const loaded = [message('old', 'Предыдущая задача'), message('current', 'Частичный ответ')];
  const live = [message('current', 'Полный ответ после запроса истории')];
  assert.deepEqual(mergeLoadedMessages(loaded, live), [loaded[0], live[0]]);
  assert.equal(loaded[1].content, 'Частичный ответ');
});

test('session history arriving late keeps new streaming messages without duplication', () => {
  const loaded = [message('existing', 'История')];
  const live = [message('existing', 'История с обновлением'), message('stream', 'Первые токены')];
  assert.deepEqual(mergeLoadedMessages(loaded, live).map((item) => [item.id, item.content]), [
    ['existing', 'История с обновлением'], ['stream', 'Первые токены'],
  ]);
});

test('a session with no live updates loads its full persisted history', () => {
  const loaded = [message('a', 'Первое сообщение'), message('b', 'Второе сообщение')];
  assert.deepEqual(mergeLoadedMessages(loaded, []), loaded);
  assert.deepEqual(mergeLoadedMessages([], [loaded[0]]), [loaded[0]]);
});

test('a bootstrap requested during a run cannot replace a later completion with running', () => {
  const snapshot: Bootstrap = { projects: [], models: [], skills: [], version: '1', platform: 'darwin', sandboxAvailable: true,
    sessions: [{ id: 'session', projectId: 'project', title: 'A renamed task', modelId: 'model', status: 'running', createdAt: 'old', updatedAt: 'old', summary: '' }] };
  const updates = new Map([['session', { revision: 2, status: 'completed' as const, updatedAt: 'new' }]]);
  const result = applyStatusUpdates(snapshot, 1, updates);
  assert.equal(result.sessions[0].status, 'completed');
  assert.equal(result.sessions[0].title, 'A renamed task');
  assert.equal(snapshot.sessions[0].status, 'running');
  assert.equal(applyStatusUpdates(snapshot, 2, updates).sessions[0].status, 'running');
});
