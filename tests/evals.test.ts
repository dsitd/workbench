import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeTask } from '../src/evals/grading';
import { evalTasks } from '../src/evals/tasks';
import { runEvaluations } from '../src/evals/runner';
import type { ChatMessage, RunRecord } from '../src/shared/types';

test('task evals grade changed files and paired observed evidence instead of a final success claim', () => {
  const task = evalTasks[0];
  const messages: ChatMessage[] = [{ id: 'claimed', role: 'assistant', content: 'All done', createdAt: '', toolCalls: [{ id: 'unpaired', name: 'edit_file', arguments: {} }] }];
  const run: RunRecord = { id: 'r', projectId: 'p', sessionId: 's', modelId: 'm', status: 'completed', phase: 'final', startedAt: '', steps: 1, stepLog: [], limits: {}, usage: { inputTokens: 0, outputTokens: 0, tokenSource: 'reported', costSource: 'unknown' } };
  const grade = gradeTask(task, task.files, { ...task.files, 'untouched.txt': 'Unauthorized' }, messages, run);
  assert.ok(grade.failures.some(value => value.includes('Unauthorized file change')));
  assert.ok(grade.failures.some(value => value.includes('Incorrect final contents')));
  assert.ok(grade.failures.some(value => value.includes('exactly one')));
  assert.ok(grade.failures.some(value => value.includes('evidence')));
});
test('twenty isolated task-shaped scenarios exercise the real runtime and filesystem without outbound model requests', async () => {
  assert.equal(evalTasks.length, 20); assert.equal(new Set(evalTasks.map(task => task.id)).size, 20);
  const report = await runEvaluations(evalTasks);
  assert.equal(report.mode, 'deterministic');
  assert.equal(report.passed, 20, JSON.stringify(report.cases.filter(result => !result.passed), null, 2));
  assert.ok(report.cases.every(result => result.trace.every(call => call.resultCount === 1)));
  assert.ok(report.cases.find(result => result.id === 'large-output-retrieval')!.trace.some(call => call.archived));
  assert.ok(report.cases.find(result => result.id === 'false-completion')!.status === 'error');
});
