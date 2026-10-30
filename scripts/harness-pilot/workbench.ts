import path from 'node:path';
import { WorkspaceServices } from '../../src/backend';
import { AgentRuntime } from '../../src/agent';
import { verifyProjectRun } from '../../src/backend/verification';
import type { AgentDependencies } from '../../src/shared/agent';
import { resolvePilotModel, type PilotModel } from './models';
import { randomUUID } from 'node:crypto';
import { benchmarkPath, runtimeRoots } from './platform';

export interface ReplayOptions {
  contextWindow: number;
  sessionId?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export async function runWorkbench(root: string, state: string, endpoint: string, prompt: string, command: string, dry: boolean, resume = false, maxCostUsd = 0.30, maxDurationMs = 600_000, pilot: PilotModel = resolvePilotModel(), readRoots: string[] = [], behaviorChecks = false, replay?: ReplayOptions) {
  const host = new WorkspaceServices(state, { approve: async () => true, emit: () => {} }, { readRoots: runtimeRoots.map(root => root.path), path: benchmarkPath });
  await host.bootstrap();
  if (!resume) await host.saveSettings({ ...await host.getSettings(), behaviorVerification: behaviorChecks });
  // Keep the real provider identity: replacing it with localhost disables the
  // application's native cache controls and API-reported cost parsing.
  const model = await host.saveModel({ id: 'bench', name: `${pilot.name} pilot`, kind: pilot.api === 'responses' ? 'openai-responses' : 'openai-compatible', reasoningEffort: pilot.reasoning === 'none' ? 'auto' : pilot.reasoning, baseUrl: 'https://openrouter.ai/api/v1', model: pilot.id, apiKeyEnv: '', enabled: true, vision: false, contextWindow: replay?.contextWindow ?? 96_000, maxOutputTokens: 6000, inputPricePerMillion: pilot.input, outputPricePerMillion: pilot.output });
  const maxSteps = 0;
  const contextReports: unknown[] = [];
  const existing = replay?.sessionId ? await host.getProject((await host.getSession(replay.sessionId)).projectId) : resume ? (await host.listProjects())[0] : undefined;
  const project = existing ? await host.saveProject({ ...existing, runLimits: { ...existing.runLimits, maxSteps } })
    : await host.createProject({ name: path.basename(root), folders: [{ path: root, access: 'write' }, ...readRoots.map(path => ({ path, access: 'read' as const }))], internet: false, commandPolicy: 'sandbox', verificationCommand: dry ? '' : command, runLimits: { maxSteps, maxTokens: 10_000_000, maxCostUsd, maxDurationMs } });
  const session = replay?.sessionId ? await host.getSession(replay.sessionId) : resume ? (await host.listSessions(project.id))[0] : await host.createSession(project.id, model.id);
  for (const message of replay?.history ?? []) await host.appendMessage(session.id, { ...message, id: randomUUID(), createdAt: new Date().toISOString() });
  const parent = resume ? (await host.listRuns(project.id, session.id))[0] : undefined;
  // Match the public pilot scope: local files and foreground shell, no network/MCP/background tools.
  const tools = host.tools.filter(tool => ['read', 'write'].includes(tool.permission) || tool.name === 'run_command');
  const allowed = new Set(tools.map(tool => tool.name));
  const deps: AgentDependencies = {
    getSession: id => host.getSession(id), getProject: id => host.getProject(id), getModel: id => host.getModel(id),
    getMessages: id => host.getMessages(id), appendMessage: (id, message) => host.appendMessage(id, message), updateSession: (id, patch) => host.updateSession(id, patch),
    loadInstructions: p => host.loadInstructions(p), listSkills: id => host.listSkills(id), readSkill: id => host.readSkill(id),
    getAttachment: id => host.getAttachment(id), resolveImage: id => host.resolveImage(id), resolveCredential: async () => pilot.api === 'responses' ? 'unused-local-placeholder' : undefined,
    tools, executeTool: (call, context) => allowed.has(call.name) ? host.executeTool(call, context) : Promise.resolve({ text: 'Outside pilot scope', error: true }),
    approveTool: async () => true, emit: () => {}, saveContext: report => { contextReports.push(report); }, saveRun: run => host.saveRun(run), getRun: id => host.getRun(id), getSettings: () => host.getSettings(),
    createCheckpoint: (p, id, title, runId) => host.createCheckpoint(p, id, title, runId),
    verifyRun: (run, signal) => verifyProjectRun(host, run, session, project, signal),
    getProjectContext: (p, query, signal, id, paths) => host.getProjectContext(p, query, signal, id, paths),
    retainToolOutput: (call, context, result) => host.outputs.retain(call, context, result), beginOperation: (call, context) => host.operations.begin(call, context),
    finishOperation: (id, result) => host.operations.finish(id, result), operationStates: (ids, context) => host.operations.states(ids, context),
    getLatestModelSummary: async id => (await host.listRuns(undefined, id)).find(run => run.modelSummary)?.modelSummary,
  };
  try {
    const runtime = new AgentRuntime(deps, { maxSteps, maxRunTokens: 10_000_000, fetch: async (url, init) => {
      const suffix = pilot.api === 'responses' ? 'responses' : 'chat/completions';
      if (String(url) !== `https://openrouter.ai/api/v1/${suffix}`) throw new Error('Unexpected benchmark transport route');
      return fetch(`${endpoint}/${suffix}`, init);
    } });
    if (parent) await runtime.resume(session.id, parent.id);
    else await runtime.run({ sessionId: session.id, text: prompt, attachmentIds: [] });
    const run = (await host.listRuns(project.id, session.id))[0];
    const messages = await host.getMessages(session.id);
    return { contextReports, status: run.status, steps: run.steps, toolCalls: messages.flatMap(m => m.toolCalls ?? []).length, toolErrors: messages.filter(m => m.role === 'tool' && m.error).length, error: run.error, verification: run.verification?.status,
      ...(replay ? { sessionId: session.id, run, answer: messages.filter(m => m.role === 'assistant' && !m.toolCalls?.length).at(-1)?.content } : {}) };
  } finally { await host.commands.close(); }
}
