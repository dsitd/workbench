import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import type { ChatMessage, RunRecord } from '../../shared/types';
import { activityCounts, conversationActivity, type AssistantResponse } from '../conversation-activity';

const message = (id: string, role: ChatMessage['role'], content = id, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: '2026-10-07T11:00:00.000Z', ...patch });
const user = message('user-1', 'user');
const read = message('read-step', 'assistant', 'Читаю файл.', { toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'fixture.ts' } }] });
const result = message('read-result', 'tool', 'export const fixture = 1;', { toolCallId: 'call-1', toolName: 'read_file' });
const edit = message('edit-step', 'assistant', 'Сохраняю правку.', { toolCalls: [{ id: 'call-2', name: 'edit_file', arguments: { path: 'fixture.ts' } }] });
const edited = message('edit-result', 'tool', 'Изменено.', { toolCallId: 'call-2', toolName: 'edit_file' });
const answer = message('answer', 'assistant', 'Готовый ответ.', { createdAt: '2026-10-07T11:00:02.000Z' });

test('one assistant response contains all public steps and tool results before its separate final answer', () => {
  const entries = conversationActivity([user, read, result, edit, edited, answer]);
  assert.equal(entries.length, 2); assert.equal(entries[0].kind, 'user');
  const response = entries[1] as AssistantResponse;
  assert.deepEqual(response.activity.map(item => item.id), ['read-step', 'read-result', 'edit-step', 'edit-result']);
  assert.equal(response.answer?.id, answer.id); assert.equal(response.active, false);
  assert.deepEqual(activityCounts(response.activity), { steps: 2, tools: 2, errors: 0 });
});

test('response keys remain stable from empty active work through streaming, tools and completion', () => {
  const empty = conversationActivity([user], true)[1] as AssistantResponse;
  const streaming = conversationActivity([user, message(read.id, 'assistant', 'Читаю')], true)[1] as AssistantResponse;
  const tools = conversationActivity([user, read, result], true)[1] as AssistantResponse;
  const complete = conversationActivity([user, read, result, answer])[1] as AssistantResponse;
  assert.equal(empty.id, streaming.id); assert.equal(empty.id, tools.id); assert.equal(empty.id, complete.id);
  assert.equal(streaming.answer, undefined); assert.equal(streaming.activity[0].content, 'Читаю');
  assert.equal(complete.answer?.content, answer.content);
});

test('continuing a completed response keeps its final answer visible and starts a separate activity group', () => {
  const entries = conversationActivity([user, read, result, answer], true, '2026-10-07T11:01:00.000Z');
  assert.equal(entries.length, 3);
  assert.equal((entries[1] as AssistantResponse).answer?.id, answer.id);
  assert.equal((entries[1] as AssistantResponse).active, false);
  assert.equal((entries[2] as AssistantResponse).active, true);
  assert.notEqual(entries[1].id, entries[2].id);
});

test('multiple requests and orphan tool results retain their order without exposing system messages', () => {
  const orphan = message('orphan', 'tool', 'Old observation.', { error: true, toolCallId: 'missing' });
  const entries = conversationActivity([message('system', 'system'), user, read, result, answer, message('user-2', 'user'), orphan, message('answer-2', 'assistant')]);
  assert.deepEqual(entries.map(entry => entry.kind), ['user', 'response', 'user', 'response']);
  assert.equal((entries[3] as AssistantResponse).activity[0].id, orphan.id);
  assert.deepEqual(activityCounts([orphan]), { steps: 0, tools: 1, errors: 1 });
});

test('one closed accessible disclosure renders public activities and paired results without provider reasoning payloads', async () => {
  Object.defineProperty(globalThis, 'window', { value: { workbench: {} }, configurable: true });
  const { ActivityDisclosure } = await import('../components/ActivityDisclosure');
  const protectedMessage = { ...read, providerItems: [{ type: 'thinking', thinking: 'hidden-provider-fixture' }], reasoningDetails: [{ type: 'reasoning.encrypted', data: 'hidden-encrypted-fixture' }] };
  const html = renderToStaticMarkup(createElement(ActivityDisclosure, { messages: [protectedMessage, result, edit, edited], active: false }));
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.match(html, /<summary data-testid="activity-toggle"/);
  assert.doesNotMatch(html, /<details[^>]* open=|hidden-provider-fixture|hidden-encrypted-fixture|Готовый ответ/);
  assert.equal((html.match(/data-testid="activity-tool"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="activity-result"/g) ?? []).length, 2);
  assert.match(html, /Читаю файл/); assert.match(html, /export const fixture = 1;/); assert.match(html, /2 шага/); assert.match(html, /2 инструмента/);
});

test('journal metadata represents the tool and final API steps once without duplicating the final answer', async () => {
  Object.defineProperty(globalThis, 'window', { value: { workbench: {} }, configurable: true });
  const { ActivityDisclosure } = await import('../components/ActivityDisclosure');
  const run: RunRecord = { id: 'run', projectId: 'project', sessionId: 'session', modelId: 'model', status: 'completed', phase: 'final', startedAt: read.createdAt, steps: 2, limits: {}, usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.003, costSource: 'api', tokenSource: 'reported' }, stepLog: [
    { index: 1, startedAt: read.createdAt, durationMs: 1300, toolNames: ['read_file'], errors: [], inputTokens: 100, outputTokens: 10, costUsd: 0.001, retries: 0, finishReason: 'tool_calls' },
    { index: 2, startedAt: answer.createdAt, durationMs: 900, toolNames: [], errors: [], inputTokens: 200, outputTokens: 30, costUsd: 0.002, retries: 0, finishReason: 'stop' },
  ] };
  const html = renderToStaticMarkup(createElement(ActivityDisclosure, { messages: [read, result], active: false, run }));
  assert.equal((html.match(/data-testid="activity-step"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="activity-step-metadata"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="activity-final-step"/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-step-index="1"') < html.indexOf('data-step-index="2"'));
  assert.match(html, /Шаг 2 · Итоговый ответ/);
  assert.match(html, /\$0\.0020/); assert.match(html, /Вход 200 · выход 30/);
  assert.doesNotMatch(html, /Готовый ответ\./);
  const finalOnly = renderToStaticMarkup(createElement(ActivityDisclosure, { messages: [], active: false, run: { ...run, steps: 1, stepLog: [{ ...run.stepLog[1], index: 1 }] } }));
  assert.equal((finalOnly.match(/data-testid="activity-step"/g) ?? []).length, 1);
  assert.match(finalOnly, /activity-final-step/);
});

const verification = message('auto-check', 'assistant', 'Проверяю результат задачи.', { runtimeKind: 'verification', createdAt: '2026-10-07T11:00:03.000Z',
  toolCalls: [{ id: 'verify-call', name: 'verify_project', arguments: {} }] });
const verified = message('verified', 'tool', 'Focus tests passed.', { toolName: 'verify_project', toolCallId: 'verify-call', createdAt: '2026-10-07T11:00:04.000Z' });

test('successful automatic verification stays with its candidate answer and keeps the response identity', () => {
  const prefix = [user, read, result, answer];
  const initial = conversationActivity(prefix)[1] as AssistantResponse;
  const checked = conversationActivity([...prefix, verification, verified]);
  assert.equal(checked.length, 2);
  const response = checked[1] as AssistantResponse;
  assert.equal(response.id, initial.id);
  assert.equal(response.answer?.id, answer.id);
  assert.deepEqual(response.activity.map(item => item.id), ['read-step', 'read-result', 'auto-check', 'verified']);
  assert.deepEqual(activityCounts(response.activity), { steps: 1, tools: 2, errors: 0 });
  const checking = conversationActivity([...prefix, verification], true)[1] as AssistantResponse;
  assert.equal(checking.id, initial.id);
  assert.equal(checking.answer, undefined, 'a candidate is not a final answer while its check is running');
  assert.deepEqual(checking.activity.map(item => item.id), ['read-step', 'read-result', 'answer', 'auto-check']);
});

test('failed verification and repair replace the candidate final answer while preserving its earlier public claim', () => {
  const failed = { ...verified, error: true, content: 'Focus tests failed.' };
  const fixed = message('fixed-answer', 'assistant', 'Focus tests now pass.', { createdAt: '2026-10-07T11:00:05.000Z' });
  const entries = conversationActivity([user, read, result, answer, verification, failed, edit, edited, fixed]);
  assert.equal(entries.length, 2, 'the candidate must not remain as a separate successful response');
  const response = entries[1] as AssistantResponse;
  assert.equal(response.answer?.id, fixed.id);
  assert.deepEqual(response.activity.map(item => item.id), ['read-step', 'read-result', 'answer', 'auto-check', 'verified', 'edit-step', 'edit-result']);
  const pending = conversationActivity([user, answer, verification, failed], true)[1] as AssistantResponse;
  assert.equal(pending.answer, undefined);
  assert.equal(pending.active, true);
  assert.deepEqual(pending.activity.map(item => item.id), ['answer', 'auto-check', 'verified']);
});

test('stopped verification and final errors do not expose the candidate as a successful final answer', () => {
  const cancelled = { ...verified, error: true, content: 'Verification cancelled.' };
  const stopped = conversationActivity([user, answer, verification, cancelled])[1] as AssistantResponse;
  assert.equal(stopped.answer, undefined);
  assert.equal(stopped.active, false);
  assert.deepEqual(stopped.activity.map(item => item.id), ['answer', 'auto-check', 'verified']);
  const failure = message('final-error', 'assistant', 'Task stopped before verification passed.', { error: true });
  const entries = conversationActivity([user, answer, verification, cancelled, failure]);
  assert.equal(entries.length, 2);
  const response = entries[1] as AssistantResponse;
  assert.equal(response.answer?.id, failure.id);
  assert.equal(response.answer?.error, true);
  assert.equal(response.activity.filter(item => item.id === answer.id).length, 1);
});

test('child requests and synthetic verification cannot consume the next parent request metadata', async () => {
  Object.defineProperty(globalThis, 'window', { value: { workbench: {} }, configurable: true });
  const { ActivityDisclosure } = await import('../components/ActivityDisclosure');
  const parent = message('parent-explore', 'assistant', 'Исследую реализацию.', { toolCalls: [{ id: 'explore-call', name: 'explore_code', arguments: { task: 'Find focus handlers.' } }] });
  const explored = message('explored', 'tool', 'Focus handlers are in focus.ts.', { toolName: 'explore_code', toolCallId: 'explore-call' });
  const run: RunRecord = { id: 'run', projectId: 'project', sessionId: 'session', modelId: 'model', status: 'completed', phase: 'final',
    startedAt: parent.createdAt, steps: 4, limits: {}, usage: { inputTokens: 1010, outputTokens: 40, costUsd: 0.01, costSource: 'api', tokenSource: 'reported' }, stepLog: [
      { kind: 'agent', assistantMessageId: parent.id, index: 1, startedAt: parent.createdAt, durationMs: 100, toolNames: ['explore_code'], errors: [], inputTokens: 101, outputTokens: 11, retries: 0 },
      { kind: 'explore', index: 2, startedAt: parent.createdAt, durationMs: 100, toolNames: ['read_file'], errors: [], inputTokens: 202, outputTokens: 22, retries: 0 },
      { kind: 'agent', assistantMessageId: read.id, index: 3, startedAt: read.createdAt, durationMs: 100, toolNames: ['read_file'], errors: [], inputTokens: 303, outputTokens: 33, retries: 0 },
      { kind: 'agent', assistantMessageId: answer.id, index: 4, startedAt: answer.createdAt, durationMs: 100, toolNames: [], errors: [], inputTokens: 404, outputTokens: 44, retries: 0, finishReason: 'stop' },
    ] };
  const html = renderToStaticMarkup(createElement(ActivityDisclosure, { messages: [parent, explored, read, result, verification, verified], active: false, run }));
  const $ = load(html);
  assert.equal($('[data-testid="activity-step"]').length, 4);
  assert.equal($('[data-testid="activity-step-metadata"]').length, 4);
  assert.match($('[data-step-index="2"]').text(), /Исследование кода.*Вход 202/);
  assert.match($('[data-step-index="3"]').text(), /Вход 303.*Читаю файл/);
  assert.doesNotMatch($('[data-step-index="3"]').text(), /Вход 202|Вход 404/);
  assert.match($('[data-step-index="4"]').text(), /Итоговый ответ.*Вход 404/);
  assert.deepEqual($('[data-testid="activity-step"]').map((_index, element) => $(element).attr('data-step-index')).get(), ['1', '2', '3', '4']);
  assert.equal($('[data-testid="activity-tool"]').length, 3);
  const checkSection = $('.activity-step').filter((_index, element) => $(element).find('.activity-step-heading').text() === 'Проверка проекта');
  assert.equal(checkSection.length, 1);
  assert.equal(checkSection.find('[data-testid="activity-step-metadata"]').length, 0);
  assert.equal(checkSection.attr('data-step-index'), undefined);
  assert.match($('.activity-count').text(), /4 шага/);
});
