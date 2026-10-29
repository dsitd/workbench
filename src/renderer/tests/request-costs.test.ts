import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, RunRecord } from '../../shared/types';
import { chatCosts, costDescription, moneyLabel } from '../request-costs';

const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'Fixture task', createdAt: '2026-10-07T12:00:00.000Z' });
const run = (id: string, userMessageId: string | undefined, cost: number | undefined, patch: Partial<RunRecord> = {}): RunRecord => ({
  id, projectId: 'p', sessionId: 's', modelId: 'm', kind: 'agent', status: 'completed', phase: 'final',
  startedAt: '2026-10-07T12:00:00.000Z', steps: 1, stepLog: [], limits: {},
  usage: { inputTokens: 10, outputTokens: 2, costUsd: cost, tokenSource: 'reported', costSource: cost === undefined ? 'unknown' : 'api' },
  checkpoint: userMessageId ? { userMessageId } : undefined, ...patch,
});

test('costs group every continuation with its original user request and include title exactly once', () => {
  const data = chatCosts([
    run('first', 'a', 0.5, { status: 'limited' }), run('continue', undefined, 0.2, { parentRunId: 'first' }),
    run('second', 'b', 0.3), run('title', undefined, 0.00001, { kind: 'title' }),
  ], [user('a'), user('b')], 's');
  assert.equal(data.requests.get('a')!.runCount, 3);
  assert.ok(Math.abs(data.requests.get('a')!.costUsd! - 0.70001) < 1e-10);
  assert.equal(data.requests.get('a')!.includesTitle, true);
  assert.equal(data.requests.get('b')!.costUsd, 0.3);
  assert.equal(data.total.runCount, 4);
  assert.ok(Math.abs(data.total.costUsd! - 1.00001) < 1e-10);
  assert.equal(data.total.costSource, 'api'); assert.equal(data.total.partial, false);
});

test('snapshot updates never charge a run twice and other chats are excluded', () => {
  const data = chatCosts([run('a', 'user', 0.1, { status: 'running' }), run('a', 'user', 0.4), run('other', 'user', 8, { sessionId: 'other-chat' })], [user('user')], 's');
  assert.equal(data.total.costUsd, 0.4); assert.equal(data.total.runCount, 1); assert.equal(data.total.ongoing, false);
  assert.equal(data.requests.get('user')!.costUsd, 0.4);
});

test('unknown costs and historical requests remain visibly incomplete beside known API subtotals', () => {
  const data = chatCosts([run('known', 'a', 0.7), run('unknown', 'a', undefined), run('title', undefined, 0.00001, { kind: 'title' })], [user('a'), user('old')], 's');
  assert.equal(data.total.costSource, 'unknown'); assert.equal(data.total.partial, true); assert.equal(data.total.missingRequests, 1);
  assert.match(moneyLabel(data.total), /^от \$0\.7000 · часть неизвестна$/);
  assert.equal(moneyLabel(data.requests.get('old')!), 'Нет данных');
  assert.match(costDescription(data.total), /Полная стоимость неизвестна/);
});

test('a known subtotal from an incomplete run and estimates never masquerade as complete API charges', () => {
  const incomplete = run('partial', 'a', 0.1); incomplete.usage.costSource = 'unknown';
  assert.equal(moneyLabel(chatCosts([incomplete], [user('a')], 's').total), 'от $0.1000 · часть неизвестна');
  const estimate = run('estimate', 'a', 0.2); estimate.usage.costSource = 'estimated';
  const mixed = chatCosts([run('api', 'a', 0.1), estimate], [user('a')], 's').total;
  assert.equal(mixed.costSource, 'mixed'); assert.equal(moneyLabel(mixed), '≈ $0.3000');
  assert.match(costDescription(mixed), /API и оценок/);
});

test('running charges and tiny nonzero helper costs stay visible', () => {
  const ongoing = chatCosts([run('running', 'a', 0.02, { status: 'running' })], [user('a')], 's').total;
  assert.equal(moneyLabel(ongoing), '$0.0200 · пока');
  const title = chatCosts([run('title', undefined, 0.0000112, { kind: 'title' })], [], 's');
  assert.equal(moneyLabel(title.total), '$0.000011');
  assert.match(costDescription(title.total, true), /Включая автоматическое название/);
});

test('unlinked legacy and cyclic parent records contribute to chat total without assigning another request', () => {
  const data = chatCosts([run('cycle-a', undefined, 0.1, { parentRunId: 'cycle-b' }), run('cycle-b', undefined, 0.2, { parentRunId: 'cycle-a' }), run('orphan', undefined, 0.3)], [user('a')], 's');
  assert.equal(data.unassignedRuns, 3); assert.equal(data.requests.get('a')!.costUsd, undefined);
  assert.ok(Math.abs(data.total.costUsd! - 0.6) < 1e-10); assert.equal(data.total.partial, true);
  assert.match(costDescription(data.total, true, data.unassignedRuns), /привязка к сообщению отсутствует/);
});

test('a title alone does not claim the first user request has complete known cost', () => {
  const data = chatCosts([run('title', undefined, 0.00001, { kind: 'title' })], [user('old')], 's');
  assert.equal(data.requests.get('old')!.partial, true); assert.equal(data.total.missingRequests, 1);
  assert.equal(moneyLabel(chatCosts([], [], 's').total), '$0.0000');
  assert.equal(moneyLabel(chatCosts([run('free', 'a', 0), run('unknown', 'a', undefined)], [user('a')], 's').total), 'Стоимость неизвестна');
});

test('request and chat controls expose scope, source, partial charges and details action accessibly', async () => {
  const { RequestCost, ChatCost } = await import('../components/RequestCost');
  const cost = chatCosts([run('known', 'a', 0.1), run('failed', 'a', undefined)], [user('a')], 's').total;
  const requestHtml = renderToStaticMarkup(createElement(RequestCost, { cost, onDetails: () => {} }));
  assert.match(requestHtml, /data-testid="request-cost"/); assert.match(requestHtml, /Запрос/);
  assert.match(requestHtml, /от \$0\.1000 · часть неизвестна/); assert.match(requestHtml, /Полная стоимость неизвестна/);
  const chatHtml = renderToStaticMarkup(createElement(ChatCost, { cost, onDetails: () => {}, unassignedRuns: 0 }));
  assert.match(chatHtml, /data-testid="chat-total-cost"/); assert.match(chatHtml, /Чат · от \$0\.1000/);
  const failed = renderToStaticMarkup(createElement(ChatCost, { cost, onDetails: () => {}, unassignedRuns: 0, error: 'Журнал недоступен' }));
  assert.match(failed, /Расходы недоступны/); assert.doesNotMatch(failed, /\$0\.1000/);
});

test('cached input remains an inclusive subset and API cost is never discounted a second time', () => {
  const cached = run('cached', 'a', 0.6); cached.usage.cacheReadTokens = 7; cached.usage.cacheWriteTokens = 2;
  const continued = run('continued', 'a', 0.4); continued.usage.cacheReadTokens = 5; continued.usage.cacheWriteTokens = 1;
  const total = chatCosts([cached, continued], [user('a')], 's').total;
  assert.equal(total.inputTokens, 20); assert.equal(total.cacheReadTokens, 12); assert.equal(total.cacheWriteTokens, 3);
  assert.equal(total.cacheDetailsPartial, undefined); assert.equal(total.costUsd, 1);
  assert.match(costDescription(total), /Вход: 20 токенов; чтение из кэша: 12; запись в кэш: 3/);
  assert.match(costDescription(total), /Стоимость API уже учитывает кэш/);
  const partial = chatCosts([cached, run('missing-details', 'a', 0.4)], [user('a')], 's').total;
  assert.equal(partial.cacheReadTokens, 7); assert.equal(partial.cacheDetailsPartial, true);
  assert.match(costDescription(partial), /только для части вызовов/);
  assert.equal(partial.costSource, 'api', 'Missing cache breakdown does not invalidate reported API dollars.');
});

test('cache inspector distinguishes unknown breakdown from a reported zero and flags incomplete cache metadata', async () => {
  const { CacheUsage, StepCacheUsage } = await import('../components/CacheUsage');
  const usage = run('cached', 'a', 0.5).usage;
  assert.equal(renderToStaticMarkup(createElement(CacheUsage, { usage })), '');
  const cached = { ...usage, cacheReadTokens: 0, cacheWriteTokens: 12, cacheDetailsPartial: true };
  const html = renderToStaticMarkup(createElement(CacheUsage, { usage: cached }));
  assert.match(html, /data-testid="run-cache-read"/); assert.match(html, /<strong>0<\/strong>/);
  assert.match(html, /Запись входа в кэш/); assert.match(html, /Стоимость API уже учитывает кэш/);
  assert.match(html, /только для части вызовов/);
  const step = renderToStaticMarkup(createElement(StepCacheUsage, { usage: { cacheReadTokens: 5 } }));
  assert.match(step, /5 из кэша/); assert.match(step, /запись кэша неизвестна/);
});
