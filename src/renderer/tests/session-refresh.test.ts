import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bootstrap, Session } from '../../shared/types';
import { applySessionUpdates } from '../state';

const session: Session = { id: 'chat', projectId: 'project', modelId: 'model', title: 'Автоматическое название', titleSource: 'automatic', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01', summary: '' };
const snapshot: Bootstrap = { sessions: [session], projects: [], models: [], skills: [], platform: 'darwin', version: 'fixture', sandboxAvailable: false };
test('a pending refresh preserves a manual title saved after the snapshot request', () => {
  const updated = applySessionUpdates(snapshot, 2, new Map([['chat', { revision: 3, metadata: { title: 'Моё название', titleSource: 'manual' } }]]));
  assert.equal(updated.sessions[0].title, 'Моё название');
  assert.equal(updated.sessions[0].titleSource, 'manual');
  assert.equal(updated.sessions[0].status, 'completed');
});
test('a later refresh accepts backend metadata and automatic names when no user save raced', () => {
  const updated = applySessionUpdates(snapshot, 3, new Map([['chat', { revision: 3, metadata: { title: 'Старое локальное название' } }]]));
  assert.equal(updated.sessions[0].title, session.title);
});
