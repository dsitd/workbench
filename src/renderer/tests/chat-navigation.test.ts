import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackChatModel, latestProjectChat, projectChats } from '../chat-navigation';
import { cacheReadShare, cacheShareLabel } from '../context-cache';
import { applySessionUpdates } from '../state';
import type { Bootstrap, ModelConfig, RunUsage, Session } from '../../shared/types';

const chat = (id: string, fields: Partial<Session> = {}): Session => ({ id, projectId: 'first', title: id, modelId: 'demo', status: 'idle', summary: '', createdAt: '', updatedAt: '2026-10-07T00:00:00Z', ...fields });
test('project chat lists separate archive and pins, while default selection uses the latest active chat', () => {
  const sessions = [chat('pin', { pinned: true }), chat('recent', { updatedAt: '2026-10-07T01:00:00Z' }), chat('archive', { archivedAt: '2026-10-07', updatedAt: '2026-10-07T02:00:00Z' }), chat('other', { projectId: 'second' })];
  assert.deepEqual(projectChats(sessions, 'first').map(item => item.id), ['pin', 'recent']);
  assert.deepEqual(projectChats(sessions, 'first', true).map(item => item.id), ['archive']);
  assert.equal(latestProjectChat(sessions, 'first')?.id, 'recent');
});
test('fallback uses enabled credential presence before a provider without a key or demo', () => {
  const models = [{ id: 'demo', kind: 'demo', enabled: true }, { id: 'disabled', kind: 'anthropic', enabled: false, hasKey: true }, { id: 'no-key', kind: 'anthropic', enabled: true }, { id: 'key', kind: 'openai-responses', enabled: true, hasKey: true }] as ModelConfig[];
  assert.equal(fallbackChatModel(models)?.id, 'key');
  assert.equal(fallbackChatModel(models.slice(0, 3))?.id, 'no-key');
  assert.equal(fallbackChatModel(models.slice(0, 1))?.id, 'demo');
});
test('cache fraction uses inclusive input and labels missing or partial API metadata honestly', () => {
  const usage: RunUsage = { inputTokens: 4000, outputTokens: 20, cacheReadTokens: 3000, costSource: 'api', tokenSource: 'reported' };
  assert.deepEqual(cacheReadShare(usage), { percent: 75, partial: false }); assert.equal(cacheShareLabel(usage), 'Кэш 75%');
  assert.equal(cacheReadShare({ ...usage, cacheReadTokens: undefined }), undefined);
  assert.equal(cacheReadShare({ ...usage, inputTokens: 0 }), undefined);
  for (const partial of [{ cacheDetailsPartial: true }, { unknownCostCalls: 1 }, { tokenSource: 'mixed' as const }]) assert.match(cacheShareLabel({ ...usage, ...partial }), /часть данных/);
  assert.deepEqual(cacheReadShare({ ...usage, cacheReadTokens: 0 }), { percent: 0, partial: false });
});
test('an older refresh cannot rearchive a chat after acknowledged restore', () => {
  const value = { sessions: [chat('restored', { archivedAt: '2026-10-07' })] } as Bootstrap;
  const result = applySessionUpdates(value, 1, new Map([['restored', { revision: 2, metadata: { archivedAt: undefined, pinned: true } }]]));
  assert.equal(result.sessions[0].archivedAt, undefined); assert.equal(result.sessions[0].pinned, true);
});
