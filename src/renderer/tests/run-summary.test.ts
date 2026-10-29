import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunRecord, VerificationResult } from '../../shared/types';
import { isRunActive } from '../state';

Object.defineProperty(globalThis, 'window', { value: { workbench: {} }, configurable: true });

const completed: RunRecord = {
  id: 'run-fixture', projectId: 'project-fixture', sessionId: 'session-fixture', modelId: 'model-fixture',
  status: 'completed', phase: 'final', startedAt: '2026-10-07T12:00:00.000Z', steps: 2, stepLog: [], limits: {},
  usage: { inputTokens: 1200, outputTokens: 40, tokenSource: 'reported', costSource: 'unknown' },
};

test('completed model answers remain distinct from missing or failed project verification', async () => {
  const { RunSummary } = await import('../components/RunSummary');
  const pending = renderToStaticMarkup(createElement(RunSummary, { run: completed }));
  assert.match(pending, /Ответ завершён/);
  assert.match(pending, /Проверка не запускалась/);
  assert.match(pending, /Стоимость неизвестна/);
  const failed = renderToStaticMarkup(createElement(RunSummary, { run: { ...completed, verification: {
    id: 'verify-fixture', projectId: completed.projectId, sessionId: completed.sessionId, command: 'fixture-check',
    cwd: '/fixture', status: 'failed', output: 'Fixture failure', exitCode: 1, startedAt: completed.startedAt,
  } } }));
  assert.match(failed, /Ответ завершён/);
  assert.match(failed, /Проверка не пройдена/);
  assert.doesNotMatch(failed, /Проверка пройдена/);
});

test('budget stops expose explicit continuation and estimated costs are marked as estimates', async () => {
  const { RunSummary } = await import('../components/RunSummary');
  const html = renderToStaticMarkup(createElement(RunSummary, { run: { ...completed,
    status: 'limited', canContinue: true, limitReason: 'tokens',
    usage: { ...completed.usage, costUsd: 0.01, costSource: 'estimated', tokenSource: 'estimated' },
  }, onContinue: () => {} }));
  assert.match(html, /Достигнут бюджет/);
  assert.match(html, /data-testid="run-continue"/);
  assert.match(html, /≈ \$0\.0100/);
  assert.match(html, /оценка/);
});

test('known subtotals never imply that the full cost is known', async () => {
  const { costLabel } = await import('../components/RunSummary');
  assert.equal(costLabel({ ...completed, usage: { ...completed.usage, costUsd: 0.02 } }), 'от $0.0200 (часть стоимости неизвестна)');
});

test('automatic naming and verification keep the chat busy after its model answer completes', () => {
  assert.equal(isRunActive(completed), false);
  assert.equal(isRunActive({ ...completed, kind: 'title', status: 'running', phase: 'naming' }), true);
  assert.equal(isRunActive({ ...completed, phase: 'verification' }), true);
  assert.equal(isRunActive({ ...completed, verification: { id: 'verification', projectId: completed.projectId,
    sessionId: completed.sessionId, command: 'fixture-check', cwd: '/fixture', status: 'running',
    output: '', startedAt: completed.startedAt } }), true);
  assert.equal(isRunActive({ ...completed, phase: 'final', verification: { id: 'verification', projectId: completed.projectId,
    sessionId: completed.sessionId, command: 'fixture-check', cwd: '/fixture', status: 'cancelled',
    output: '', startedAt: completed.startedAt } }), false);
});

test('a previously passed check is marked stale after a later mutation without discarding its historical outcome', async () => {
  const { RunSummary } = await import('../components/RunSummary');
  const { RunVerificationHistory } = await import('../components/RunsPanel');
  const verification: VerificationResult = { id: 'previous-pass', runId: completed.id, projectId: completed.projectId, sessionId: completed.sessionId,
    command: 'fixture-check', cwd: '/fixture', status: 'passed', output: 'Historical passed output', exitCode: 0, startedAt: completed.startedAt };
  const run = { ...completed, mutationRevision: 2, verifiedRevision: 1, verification };
  const summary = renderToStaticMarkup(createElement(RunSummary, { run }));
  assert.match(summary, /Требуется новая проверка/);
  assert.doesNotMatch(summary, /Проверка пройдена|verification-label passed/);
  const history = renderToStaticMarkup(createElement(RunVerificationHistory, { run }));
  assert.match(history, /Пройдена/);
  assert.match(history, /Historical passed output/);
});

test('verification history includes a later manual result once and replaces stale copies of the current evidence', async () => {
  const { RunVerificationHistory } = await import('../components/RunsPanel');
  const first: VerificationResult = { id: 'first-failure', runId: completed.id, projectId: completed.projectId, sessionId: completed.sessionId,
    command: 'fixture-check', cwd: '/fixture', status: 'failed', output: 'Initial keyboard failure', exitCode: 1, startedAt: completed.startedAt };
  const second: VerificationResult = { ...first, id: 'second-pass', status: 'passed', output: 'Repair check passed', exitCode: 0 };
  const manual: VerificationResult = { ...second, id: 'manual-pass', output: 'Manual check passed' };
  const history = renderToStaticMarkup(createElement(RunVerificationHistory, { run: { ...completed, verificationHistory: [first, second, second], verification: manual } }));
  assert.equal((history.match(/data-testid="verification-history-entry"/g) ?? []).length, 3);
  assert.equal((history.match(/data-verification-id="second-pass"/g) ?? []).length, 1);
  assert.match(history, /Initial keyboard failure/);
  assert.match(history, /Repair check passed/);
  assert.match(history, /Manual check passed/);
  assert.ok(history.indexOf('first-failure') < history.indexOf('second-pass'));
  assert.ok(history.indexOf('second-pass') < history.indexOf('manual-pass'));
  const fresh = renderToStaticMarkup(createElement(RunVerificationHistory, { run: { ...completed,
    verificationHistory: [{ ...second, status: 'running', output: 'Stale partial output' }], verification: second } }));
  assert.equal((fresh.match(/data-testid="verification-history-entry"/g) ?? []).length, 1);
  assert.match(fresh, /Пройдена.*Последняя/);
  assert.doesNotMatch(fresh, /Stale partial output|Выполняется/);
});
