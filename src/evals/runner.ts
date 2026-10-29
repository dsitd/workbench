import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../agent/runtime';
import { WorkspaceServices } from '../backend';
import type { AgentDependencies } from '../shared/agent';
import type { ModelConfig } from '../shared/types';
import { gradeTask } from './grading';
import type { EvalOptions, EvalReport, EvalResult, EvalTask } from './types';

const fixtureModel: ModelConfig = { id: 'eval-fixture', name: 'Deterministic fixture', model: 'fixture', kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: '', contextWindow: 96_000, maxOutputTokens: 1000, enabled: true, vision: false, inputPricePerMillion: 0, outputPricePerMillion: 0 };

async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const file = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Evaluation fixture contains an unexpected symbolic link.');
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, file));
    else if (entry.isFile()) files[file] = await readFile(path.join(root, file), 'utf8');
  }
  return files;
}
function fixturePath(root: string, file: string): string {
  const target = path.resolve(root, file), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid evaluation fixture path.');
  return target;
}

export async function runEvalTask(task: EvalTask, options: EvalOptions = {}): Promise<EvalResult> {
  const started = Date.now(), root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-eval-')));
  try {
    const projectRoot = path.join(root, 'project'); await mkdir(projectRoot);
    for (const [file, content] of Object.entries(task.files)) { const target = fixturePath(projectRoot, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
    const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'Outside sentinel');
    const before = await snapshot(projectRoot);
    const host = new WorkspaceServices(path.join(root, 'state'), { approve: async () => false, emit: () => {} }); await host.bootstrap();
    const model = await host.saveModel(options.live ? { ...options.live.model, id: 'eval-live' } : fixtureModel);
    const project = await host.createProject({ name: task.id, folders: [{ path: projectRoot, access: task.readOnly ? 'read' : 'write' }] });
    const session = await host.createSession(project.id, model.id);
    for (const message of task.history ?? []) await host.appendMessage(session.id, { id: randomUUID(), ...message, createdAt: new Date().toISOString() });
    // No commands, MCP or network tools are advertised or dispatched by this isolated suite.
    const tools = host.tools.filter(tool => ['read', 'write'].includes(tool.permission));
    const allowed = new Set(tools.map(tool => tool.name));
    const deps: AgentDependencies = {
      getSession: id => host.getSession(id), getProject: id => host.getProject(id), getModel: id => host.getModel(id),
      getMessages: id => host.getMessages(id), appendMessage: (id, message) => host.appendMessage(id, message), updateSession: (id, patch) => host.updateSession(id, patch),
      loadInstructions: value => host.loadInstructions(value), listSkills: id => host.listSkills(id), readSkill: id => host.readSkill(id),
      getAttachment: id => host.getAttachment(id), resolveImage: id => host.resolveImage(id), resolveCredential: () => options.live?.resolveCredential?.() ?? Promise.resolve(undefined),
      tools, executeTool: (call, context) => allowed.has(call.name) ? host.executeTool(call, context) : Promise.resolve({ text: 'Tool is outside the evaluation scope.', error: true }),
      getLatestModelSummary: async id => (await host.listRuns(undefined, id)).find(run => run.modelSummary)?.modelSummary,
      approveTool: async () => false, emit: () => {}, saveContext: () => {}, saveRun: run => host.saveRun(run), getRun: id => host.getRun(id),
      getSettings: () => host.getSettings(), createCheckpoint: (value, id, title, runId) => host.createCheckpoint(value, id, title, runId),
      getProjectContext: (value, query, signal, id, navigationPaths) => host.getProjectContext(value, query, signal, id, navigationPaths),
      retainToolOutput: (call, context, result) => host.outputs.retain(call, context, result), beginOperation: (call, context) => host.operations.begin(call, context),
      finishOperation: (id, result) => host.operations.finish(id, result), operationStates: (ids, context) => host.operations.states(ids, context),
    };
    let step = 0;
    const scripted = async () => {
      const turn = task.turn(step++, { messages: await host.getMessages(session.id), run: (await host.listRuns(project.id, session.id))[0] });
      return new Response(JSON.stringify({ choices: [{ finish_reason: turn.calls?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: turn.content ?? '',
        tool_calls: turn.calls?.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const runtime = new AgentRuntime(deps, { maxSteps: 16, maxRunTokens: 500_000, fetch: options.live ? options.live.fetch ?? fetch : scripted });
    await runtime.run({ sessionId: session.id, text: task.prompt, attachmentIds: [] });
    const run = (await host.listRuns(project.id, session.id))[0], messages = await host.getMessages(session.id), after = await snapshot(projectRoot);
    const grade = gradeTask(task, before, after, messages, run);
    if (await readFile(outside, 'utf8') !== 'Outside sentinel') grade.failures.push('The outside sentinel was modified.');
    const calls = messages.flatMap(message => message.toolCalls ?? []), seen = new Set<string>(); let repeatedCalls = 0;
    for (const call of calls) { const key = JSON.stringify([call.name, call.arguments]); if (seen.has(key)) repeatedCalls++; seen.add(key); }
    return { id: task.id, category: task.category, passed: grade.failures.length === 0, status: run?.status ?? 'missing', ...grade,
      metrics: { durationMs: Date.now() - started, steps: run?.steps ?? 0, toolCalls: grade.trace.length, toolErrors: grade.trace.filter(item => item.error).length, repeatedCalls,
        inputTokens: run?.usage.inputTokens ?? 0, outputTokens: run?.usage.outputTokens ?? 0, tokenSource: run?.usage.tokenSource, costUsd: run?.usage.costUsd, costSource: run?.usage.costSource } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function runEvaluations(tasks: readonly EvalTask[], options: EvalOptions = {}): Promise<EvalReport> {
  const started = Date.now(), cases: EvalResult[] = [];
  for (const task of tasks) { const result = await runEvalTask(task, options); cases.push(result); options.onCase?.(result); }
  return { suite: 'workbench-task-evals-v1', mode: options.live ? 'live' : 'deterministic', model: options.live?.model.model ?? 'local-scripted-fixture', startedAt: new Date(started).toISOString(),
    cases, passed: cases.filter(result => result.passed).length, total: cases.length, durationMs: Date.now() - started,
    scope: options.live ? 'Isolated file tasks using a real model. Fixed outcome assertions and public trace checks; no command, MCP, network-tool or desktop acceptance.' : 'Real runtime and filesystem with local scripted model replies. Harness regression evidence; model quality and paid API availability are unmeasured.' };
}
