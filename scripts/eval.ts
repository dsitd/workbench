import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runEvaluations } from '../src/evals/runner';
import { evalTasks } from '../src/evals/tasks';
import type { EvalOptions } from '../src/evals/types';

async function main(): Promise<void> {
const { values } = parseArgs({ options: { report: { type: 'string' }, case: { type: 'string' }, live: { type: 'boolean' }, 'base-url': { type: 'string' }, model: { type: 'string' }, 'api-key-env': { type: 'string' }, 'allow-paid': { type: 'boolean' } } });
const candidates = values.live ? evalTasks.filter(task => task.category === 'coding' || task.category === 'context') : evalTasks;
const selected = (values.case ? candidates.filter(task => task.id === values.case) : candidates).map(task => values.live ? { ...task, requiredTools: task.category === 'coding' ? ['read_file'] : [], toolChecks: [] } : task);
if (!selected.length) throw new Error('Unknown evaluation case.');
const options: EvalOptions = { onCase: result => {
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}: ${result.status}, ${result.metrics.steps} steps, ${result.metrics.toolCalls} calls\n`);
  for (const failure of result.failures) process.stdout.write(`  ${failure}\n`);
} };
if (values.live) {
  if (!values['base-url'] || !values.model) throw new Error('--live requires --base-url and --model.');
  const url = new URL(values['base-url']);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model URL must be HTTP(S) without credentials, query or fragment.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !values['allow-paid']) throw new Error('Remote model calls require explicit --allow-paid authorization.');
  if (values['api-key-env'] && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(values['api-key-env'])) throw new Error('Invalid credential environment variable name.');
  options.live = { model: { id: 'eval-live', name: 'Evaluation model', kind: 'openai-compatible', baseUrl: url.toString(), model: values.model, apiKeyEnv: '', enabled: true, vision: false, contextWindow: 96_000, maxOutputTokens: 4000 },
    resolveCredential: async () => values['api-key-env'] ? process.env[values['api-key-env']] : undefined };
} else if (values['base-url'] || values.model || values['api-key-env'] || values['allow-paid']) throw new Error('Model options require explicit --live.');
const report = await runEvaluations(selected, options), destination = path.resolve(values.report ?? '.workbench/evals/latest.json');
await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(`${report.passed}/${report.total} passed (${report.mode}). Report: ${destination}\n${report.scope}\n`);
if (report.passed !== report.total) process.exitCode = 1;
}
void main().catch(() => { process.stderr.write('Evaluation failed. Check the case name, model options and filesystem access. Remote model calls require --live and --allow-paid.\n'); process.exitCode = 1; });
