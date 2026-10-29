import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskEvidence } from '../components/TaskEvidence';
import type { RunRecord } from '../../shared/types';

test('task evidence UI distinguishes current proof, stale checks and uncertain effects', () => {
  const base: RunRecord = { id: 'r', projectId: 'p', sessionId: 's', modelId: 'm', status: 'completed', phase: 'final', startedAt: '', steps: 1, stepLog: [], limits: {}, mutationRevision: 2, evidenceScope: 'current', usage: { inputTokens: 0, outputTokens: 0, tokenSource: 'reported', costSource: 'unknown' } };
  assert.equal(renderToStaticMarkup(createElement(TaskEvidence, { run: base })), '');
  const run: RunRecord = { ...base, acceptanceCriteria: [
    { id: 'fresh', text: 'Fresh check', sourceQuote: 'Fresh check', sourceMessageId: 'u', toolName: 'read_file', expectedText: 'observed', evidence: { toolCallId: 't', messageId: 'm', revision: 2, scope: 'current', recordedAt: '' } },
    { id: 'stale', text: 'Stale check', sourceQuote: 'Stale check', sourceMessageId: 'u', toolName: 'read_file', expectedText: 'observed', evidence: { toolCallId: 't', messageId: 'm', revision: 1, scope: 'current', recordedAt: '' } },
    { id: 'revoked', text: 'Revoked check', sourceQuote: 'Revoked check', sourceMessageId: 'u', toolName: 'read_file', expectedText: 'observed', evidence: { toolCallId: 't', messageId: 'm', revision: 2, scope: 'old', recordedAt: '' } },
  ], operations: [{ id: 'op', toolCallId: 'effect', toolName: 'write_file', status: 'uncertain' }] };
  const html = renderToStaticMarkup(createElement(TaskEvidence, { run }));
  assert.match(html, /подтверждено 1 из 3/); assert.match(html, /Требуется новая проверка/); assert.match(html, /Исход неизвестен/);
});
