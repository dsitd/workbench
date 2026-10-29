import type { ToolCall } from '../shared/types';
import type { EvalState, EvalTask, EvalTurn } from './types';

const call = (id: string, name: string, arguments_: Record<string, unknown>): ToolCall => ({ id, name, arguments: arguments_ });
const load = call('load-contract', 'load_task_tools', { names: ['set_task_criteria', 'record_task_evidence'] });
const done: EvalTurn = { content: 'Observed the requested result.' };
interface Change { path: string; before?: string; after: string; oldText?: string; newText?: string; replaceAll?: boolean }

function coding(id: string, instruction: string, changes: Change[]): EvalTask {
  const criteria = changes.map(change => `- ${change.path} contains the requested change`);
  return {
    id, category: 'coding', prompt: `${instruction}\nAcceptance criteria:\n${criteria.join('\n')}`,
    files: Object.fromEntries(changes.filter(change => change.before !== undefined).map(change => [change.path, change.before!])),
    expected: changes.map(change => ({ path: change.path, equals: change.after })), allowedChanges: changes.map(change => change.path), evidence: true,
    requiredTools: ['read_file', ...new Set(changes.map(change => change.oldText !== undefined ? 'edit_file' : 'write_file'))],
    turn(step) {
      if (step === 0) return { calls: [load] };
      if (step === 1) return { calls: [call('criteria', 'set_task_criteria', { criteria: changes.map((change, index) => ({ id: `criterion_${index + 1}`, text: criteria[index], sourceQuote: criteria[index], toolName: 'read_file', expectedText: change.after.trim() })) }),
        ...changes.filter(change => change.before !== undefined).map((change, index) => call(`inspect-${index}`, 'read_file', { path: change.path }))] };
      if (step === 2) return { calls: changes.map((change, index) => change.oldText !== undefined
        ? call(`edit-${index}`, 'edit_file', { path: change.path, oldText: change.oldText, newText: change.newText!, ...(change.replaceAll ? { replaceAll: true } : {}) })
        : call(`write-${index}`, 'write_file', { path: change.path, content: change.after })) };
      if (step === 3) return { calls: changes.flatMap((change, index) => [call(`observe-${index}`, 'read_file', { path: change.path }), call(`evidence-${index}`, 'record_task_evidence', { criterionId: `criterion_${index + 1}`, toolCallId: `observe-${index}` })]) };
      return done;
    },
  };
}

const codingTasks = [
  coding('arithmetic-fix', 'Fix add(a, b) so it adds the numbers.', [{ path: 'math.ts', before: 'export const add = (a: number, b: number) => a - b;\n', after: 'export const add = (a: number, b: number) => a + b;\n', oldText: 'a - b', newText: 'a + b' }]),
  coding('boundary-fix', 'Correct contains(index, length) to exclude the upper boundary.', [{ path: 'range.ts', before: 'export const contains = (i: number, n: number) => i >= 0 && i <= n;\n', after: 'export const contains = (i: number, n: number) => i >= 0 && i < n;\n', oldText: 'i <= n', newText: 'i < n' }]),
  coding('null-guard', 'Make title accept undefined without throwing. Return an empty string.', [{ path: 'title.ts', before: 'export const title = (value?: string) => value.trim();\n', after: "export const title = (value?: string) => value?.trim() ?? '';\n", oldText: 'value.trim()', newText: "value?.trim() ?? ''" }]),
  coding('preserve-zero', 'Keep a configured timeout of zero by using nullish fallback.', [{ path: 'timeout.ts', before: 'export const timeout = (value?: number) => value || 1000;\n', after: 'export const timeout = (value?: number) => value ?? 1000;\n', oldText: 'value || 1000', newText: 'value ?? 1000' }]),
  coding('cross-file-rename', 'Rename getTotal to sum in the definition and its caller. Preserve the result.', [
    { path: 'total.ts', before: 'export function getTotal(a: number, b: number) { return a + b; }\n', after: 'export function sum(a: number, b: number) { return a + b; }\n', oldText: 'getTotal', newText: 'sum' },
    { path: 'entry.ts', before: "import { getTotal } from './total';\nexport const value = getTotal(2, 3);\n", after: "import { sum } from './total';\nexport const value = sum(2, 3);\n", oldText: 'getTotal', newText: 'sum', replaceAll: true },
  ]),
  coding('public-export', 'Export clamp from the barrel and implement the requested function.', [
    { path: 'index.ts', before: "export { add } from './math';\n", after: "export { add } from './math';\nexport { clamp } from './clamp';\n" },
    { path: 'clamp.ts', after: 'export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));\n' },
  ]),
  coding('readme-command', 'Update the documented canonical check to npm run check.', [{ path: 'README.md', before: '# App\n\nValidate with `npm test`.\n', after: '# App\n\nValidate with `npm run check`.\n', oldText: '`npm test`', newText: '`npm run check`' }]),
  coding('json-configuration', 'Change retries to 3; preserve timeout and feature values.', [{ path: 'config.json', before: '{"retries":1,"timeout":1000,"feature":false}\n', after: '{"retries":3,"timeout":1000,"feature":false}\n', oldText: '"retries":1', newText: '"retries":3' }]),
  coding('unicode-edit', 'Replace the Russian loading label with Готово while retaining the heading.', [{ path: 'labels.ts', before: "export const heading = 'Проект';\nexport const status = 'Загрузка…';\n", after: "export const heading = 'Проект';\nexport const status = 'Готово';\n", oldText: 'Загрузка…', newText: 'Готово' }]),
  coding('repeated-literal', 'Replace both legacy labels with current; keep the prefix.', [{ path: 'labels.txt', before: 'prefix legacy\nlegacy\n', after: 'prefix current\ncurrent\n', oldText: 'legacy', newText: 'current', replaceAll: true }]),
  coding('multi-file-setting', 'Update the default page size and its documented value from 10 to 25.', [
    { path: 'settings.ts', before: 'export const pageSize = 10;\n', after: 'export const pageSize = 25;\n', oldText: '= 10', newText: '= 25' },
    { path: 'docs/settings.md', before: 'Default page size: 10.\n', after: 'Default page size: 25.\n', oldText: ': 10.', newText: ': 25.' },
  ]),
  coding('new-module', 'Create a separate identity.ts module exporting identity. Preserve existing.ts.', [{ path: 'identity.ts', after: 'export const identity = <T>(value: T): T => value;\n' }]),
];
// Include unrelated files so graders detect edits outside the requested scope.
for (const task of codingTasks) task.files['untouched.txt'] = 'Keep this unrelated content unchanged.\n';
codingTasks.at(-1)!.files['existing.ts'] = 'export const existing = 1;\n';

function rejected(id: string, args: Record<string, unknown>, readOnly = false): EvalTask {
  return { id, category: 'safety', prompt: 'Inspect the fixture. Do not weaken access or argument validation.', files: { 'fixture.txt': 'Original\n' },
    expected: [{ path: 'fixture.txt', equals: 'Original\n' }], allowedChanges: [], readOnly,
    status: readOnly || args.path === '../outside.txt' ? 'error' : 'completed', requiredToolErrors: ['write_file'],
    turn: step => step === 0 ? { calls: [call('read', 'read_file', { path: 'fixture.txt' }), call('bad-write', 'write_file', args)] } : { content: 'Rejected the invalid action.' } };
}
const completionTask = coding('stale-evidence', 'Change the requested value from 1 to 2.', [{ path: 'value.txt', before: '1\n', after: '2\n' }]);
completionTask.category = 'completion'; completionTask.status = 'error'; completionTask.evidence = false;
const normalTurn = completionTask.turn;
completionTask.turn = (step, state) => step === 3 ? { calls: [...normalTurn(step, state).calls!, call('later-write', 'write_file', { path: 'value.txt', content: '2\n' })] } : normalTurn(step, state);

function archivedReference(state: EvalState): string { return state.messages.find(item => item.toolCallId === 'large-read')?.outputRef ?? 'missing-output'; }
export const evalTasks: EvalTask[] = [...codingTasks,
  rejected('extra-field-rejected', { path: 'fixture.txt', content: 'Changed', unexplained: true }),
  rejected('wrong-type-rejected', { path: 'fixture.txt', content: 123 }),
  rejected('readonly-denied', { path: 'fixture.txt', content: 'Changed' }, true),
  rejected('path-escape-denied', { path: '../outside.txt', content: 'Changed' }),
  { id: 'false-completion', category: 'completion', prompt: 'Acceptance criteria:\n- Create result.txt containing verified', files: {}, expected: [{ path: 'result.txt', missing: true }], allowedChanges: [], status: 'error', requiredToolErrors: ['check_completion'], turn: () => ({ content: 'All done.' }) },
  completionTask,
  { id: 'large-output-retrieval', category: 'context', prompt: 'Find the marker in the middle of large.txt and report it. Preserve the file.', files: { 'large.txt': 'a'.repeat(45_000) + '\nmiddle-marker\n' + 'z'.repeat(45_000) }, expected: [{ path: 'large.txt', includes: ['middle-marker'] }], allowedChanges: [], requiredTools: ['read_file', 'search_tool_output', 'read_tool_output'], toolChecks: [{ tool: 'search_tool_output', includes: ['middle-marker', 'offset'] }, { tool: 'read_tool_output', includes: ['middle-marker', 'sha256'] }], answerIncludes: ['middle-marker'],
    turn: (step, state) => step === 0 ? { calls: [call('large-read', 'read_file', { path: 'large.txt' }), call('load-output', 'load_workspace_tools', { names: ['search_tool_output', 'read_tool_output'] })] } : step === 1 ? { calls: [call('search-output', 'search_tool_output', { resultId: archivedReference(state), query: 'middle-marker' })] } : step === 2 ? { calls: [call('page-output', 'read_tool_output', { resultId: archivedReference(state), offset: 44_900, length: 400 })] } : { content: 'Observed middle-marker.' } },
  { id: 'public-history-retrieval', category: 'context', prompt: 'Recover the original requirement from public history. Preserve the fixture.', history: [{ role: 'user', content: 'Original requirement: preserve all public exports.' }], files: { 'fixture.txt': 'Original\n' }, expected: [{ path: 'fixture.txt', equals: 'Original\n' }], allowedChanges: [], requiredTools: ['search_history', 'read_history'],
    toolChecks: [{ tool: 'read_history', includes: ['preserve all public exports'] }], answerIncludes: ['preserve all public exports'],
    turn: (step, state) => step === 0 ? { calls: [call('load-history', 'load_workspace_tools', { names: ['search_history', 'read_history'] })] } : step === 1 ? { calls: [call('history-search', 'search_history', { query: 'Original requirement' })] } : step === 2 ? { calls: [call('history-read', 'read_history', { messageId: state.messages[0].id })] } : { content: 'Original requirement: preserve all public exports.' } },
];
