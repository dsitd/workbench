import type { AgentDependencies } from '../src/shared/agent';
import type { AgentEvent, ChatMessage, ModelConfig, Project, RunRecord, Session, ToolDefinition } from '../src/shared/types';

export const fixtureModel: ModelConfig = { id: 'm', name: 'Local fixture', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture', apiKeyEnv: '', contextWindow: 24000, maxOutputTokens: 1000, vision: true, enabled: true };
export function harnessFixture(modelPatch: Partial<ModelConfig> = {}, sessionPatch: Partial<Session> = {}, projectPatch: Partial<Project> = {}) {
  const model = { ...fixtureModel, ...modelPatch };
  const project: Project = { id: 'p', name: 'Fixture', folders: [{ path: '/tmp/workbench-fixture', access: 'write' }], internet: true, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '', ...projectPatch };
  const session: Session = { id: 's', projectId: 'p', title: 'Fixture', modelId: 'm', status: 'idle', summary: '', createdAt: '', updatedAt: '', ...sessionPatch };
  const messages: ChatMessage[] = [], events: AgentEvent[] = [], saved: RunRecord[] = [], runs = new Map<string, RunRecord>();
  const tools: ToolDefinition[] = [{ name: 'read_file', description: 'Read a selected file', permission: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { name: 'write_file', description: 'Write a selected file', permission: 'write', parameters: { type: 'object' } }];
  const deps: AgentDependencies = {
    getSession: async () => session, getProject: async () => project, getModel: async () => model,
    getMessages: async () => [...messages], appendMessage: async (_id, item) => { messages.push(item); }, updateSession: async (_id, patch) => { Object.assign(session, patch); return session; },
    loadInstructions: async () => [], listSkills: async () => [], readSkill: async () => '',
    getAttachment: async id => ({ id, name: 'fixture.png', mimeType: 'image/png', size: 10, createdAt: '' }), resolveImage: async () => ({ mimeType: 'image/png', base64: 'ZmFrZQ==' }),
    resolveCredential: async () => 'known-artificial-fixture-value', tools, executeTool: async () => ({ text: 'Observed state' }), emit: event => events.push(event), saveContext: () => undefined,
    saveRun: async run => { saved.push(structuredClone(run)); runs.set(run.id, structuredClone(run)); }, getRun: async id => runs.get(id),
  };
  return { model, project, session, messages, events, saved, runs, deps, lastRun: () => saved.at(-1)! };
}
export const reply = (content = 'Done', usage?: unknown, finishReason = 'stop', toolCalls?: unknown) => new Response(JSON.stringify({ choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }], usage }), { headers: { 'content-type': 'application/json' } });
export const tool = (id = 'call1', name = 'read_file', arguments_: Record<string, unknown> = { path: 'README.md' }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) } });
export const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
