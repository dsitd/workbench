// Runs against the public Pi SDK. stdin contains only the synthetic replay, never the oracle.
import fs from 'node:fs/promises';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { state, project, history, prompt, sessionFile, model = 'openai/gpt-6.1-sol', api = 'openai-responses', thinkingLevel = 'medium', dependencies } = JSON.parse(input);
if (!dependencies || !path.isAbsolute(dependencies)) throw new Error('A public Pi dependency directory is required');
const pkg = path.join(dependencies, 'node_modules/@earendil-works/pi-coding-agent/dist/core/');
const { createAgentSession } = await import(pkg + 'sdk.js');
const { SessionManager } = await import(pkg + 'session-manager.js');
const { SettingsManager } = await import(pkg + 'settings-manager.js');
const { ModelRuntime } = await import(pkg + 'model-runtime.js');
const { DefaultResourceLoader } = await import(pkg + 'resource-loader.js');
const manager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(project, path.join(state, 'sessions'));
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (const item of history ?? []) manager.appendMessage(item.role === 'user'
  ? { role: 'user', content: item.content, timestamp: Date.now() }
  : { role: 'assistant', content: [{ type: 'text', text: item.content }], api, provider: 'pilot', model, usage: zeroUsage, stopReason: 'stop', timestamp: Date.now() });
const settingsManager = SettingsManager.create(project, state);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(state, 'auth.json'), modelsPath: path.join(state, 'models.json'), allowModelNetwork: false });
const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: state, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await resourceLoader.reload();
const selected = modelRuntime.getModel('pilot', model);
if (!selected || selected.api !== api) throw new Error('Pilot model or API mismatch in models.json');
const { session } = await createAgentSession({ cwd: project, agentDir: state, sessionManager: manager, settingsManager, modelRuntime,
  model: selected, thinkingLevel, resourceLoader,
  tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] });
const events = [];
session.subscribe(event => {
  if (['compaction_start', 'compaction_end', 'message_end', 'tool_execution_end'].includes(event.type)) events.push(event);
});
try {
  await session.prompt(prompt);
  const messages = manager.buildSessionContext().messages;
  const last = messages.filter(m => m.role === 'assistant').at(-1);
  const answer = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const result = { sessionFile: manager.getSessionFile(), answer, stopReason: last?.stopReason, events,
    compactions: manager.getEntries().filter(e => e.type === 'compaction'), context: messages };
  await fs.writeFile(path.join(state, sessionFile ? 'probe-2.json' : 'probe-1.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ sessionFile: result.sessionFile, stopReason: result.stopReason, compactions: result.compactions.length }));
} finally { session.dispose(); }
