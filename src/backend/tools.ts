import type { CommandProcess, ToolDefinition } from '../shared/types';
import type { WorkspaceServices } from './index';
import type { RegisteredTool } from './tool-registry';
import { webFetch, webSearch } from './network';
import type { TextEdit } from './batch-edit';
import { behaviorCheckSchema } from '../shared/behavior-check';

const string = { type: 'string' };
function schema(properties: Record<string, unknown>, required: string[] = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const definitions: ToolDefinition[] = [
  { name: 'list_files', description: 'List project roots or entries in a permitted project directory. Credential file names can be shown, but their content cannot be opened.', permission: 'read', parameters: schema({ path: string }) },
  { name: 'read_file', description: 'Read a permitted text file (up to 2 MiB). Optional 1-based startLine/endLine allow reading specific ranges. Output capped at 40000 characters. Protected credentials are blocked.', permission: 'read', parameters: schema({ path: string, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['path']) },
  { name: 'read_skill_resource', description: 'Read a text resource referenced by an enabled skill available to this project. The path must be relative to the skill directory; protected files are blocked.', permission: 'read', parameters: schema({ skill: string, path: string }, ['skill', 'path']) },
  { name: 'search_files', description: 'Search permitted files. Default: case-insensitive literal. Set regex:true for Rust regular expressions, ignoreCase:false for case-sensitive matching, glob for a ripgrep include/exclude glob (e.g. **/*.ts or !**/*.test.ts). Skips dependencies, build outputs, secrets, binaries and oversized files.', permission: 'read', parameters: schema({ query: string, path: string, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, glob: { type: 'string', maxLength: 1000 }, maxResults: { type: 'integer', minimum: 1, maximum: 200 }, contextLines: { type: 'integer', minimum: 0, maximum: 20, description: 'Optional grouped excerpts: 0 for compact hits, 1-20 for surrounding code. Omit for standard path:line results. Read the file before editing.' } }, ['query']) },
  { name: 'write_file', description: 'Create or replace a text file inside a writable project folder. Read an existing file in this run before replacing it; refuses conflicting external changes. Saves a task checkpoint.', permission: 'write', parameters: schema({ path: string, content: string }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replace exact passages in a writable text file. Supply either oldText/newText or edits:[{oldText,newText,replaceAll?}]. All edits match the original file; overlaps reject the whole batch. A successful edit saves one reversible snapshot. Read the file in this run first; refuses version conflicts. Non-unique passages require replaceAll.', permission: 'write', parameters: schema({ path: string, oldText: string, newText: string, replaceAll: { type: 'boolean' }, edits: { type: 'array', minItems: 1, maxItems: 100, items: schema({ oldText: string, newText: string, replaceAll: { type: 'boolean' } }, ['oldText', 'newText']) } }, ['path']) },
  { name: 'inspect_image', description: 'Inspect an image attached to this session by attachmentId, or import a permitted project image by path. Choose low detail for an overview (default), high for small text, or auto. Reinspect when another visual comparison is needed.', permission: 'read', parameters: schema({ path: string, attachmentId: string, detail: { type: 'string', enum: ['low', 'high', 'auto'] } }) },
  { name: 'web_fetch', description: 'Fetch readable text from a public HTTP/HTTPS website when internet is enabled. Credential URLs, local/private destinations, binary output and oversized responses are blocked.', permission: 'network', parameters: schema({ url: string }, ['url']) },
  { name: 'web_search', description: 'Search the public web using DuckDuckGo HTML when internet is enabled. Results contain external untrusted source data.', permission: 'network', parameters: schema({ query: string }, ['query']) },
  { name: 'start_background_command', description: 'Start a managed background command in the project sandbox. Returns a process ID; stdout streams to the UI. Background edits are not included in task rollback. Stop it explicitly when finished.', permission: 'command', parameters: schema({ command: string, cwd: string, timeoutMs: { type: 'integer', minimum: 1000, maximum: 28800000 } }, ['command']) },
  { name: 'list_processes', description: 'List managed commands for this chat and their output/status.', permission: 'read', parameters: schema({}) },
  { name: 'stop_process', description: 'Stop a managed command in this project, including its child processes.', permission: 'command', parameters: schema({ processId: string }, ['processId']) },
  { name: 'run_command', description: 'Run a command inside the operating-system sandbox with normal approvals. Credentials are blocked; fails closed without sandbox. Optional behaviorCheck records an assertion suite: baseline before the fix (specific failureContains required), regression with the same command/cwd/description after. Use inline assertions or unchanged tests. If your assertion was wrong, revisionReason allows an explained correction, archives the old receipt and resets proof; never weaken user requirements. Run the final suite after other mutations; batch related cases. No extra bookkeeping call.', permission: 'command', parameters: schema({ command: string, cwd: string, timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 }, behaviorCheck: behaviorCheckSchema }, ['command']) },
  { name: 'typescript_diagnostics', description: 'Check a TypeScript project using its locally installed compiler in the approved command sandbox. Supply a configuration .json path or directory containing tsconfig.json; defaults to the first project root. Returns structured diagnostics with file, line, column and code. Preserves composite/declaration settings, emits no project files, and confines incremental metadata to disposable command scratch. Does not install dependencies or build referenced projects.', permission: 'command', parameters: schema({ path: string, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, maxDiagnostics: { type: 'integer', minimum: 1, maximum: 200 } }) },
];

function textArgument(arguments_: Record<string, unknown>, key: string, optional = false): string {
  const value = arguments_[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

type Handler = RegisteredTool<WorkspaceServices>['execute'];
const handlers: Record<string, Handler> = {
  list_files: async (args, context, services) => ({ text: JSON.stringify(await services.files.list(context.project, textArgument(args, 'path', true) || undefined), null, 2) }),
  read_file: async (args, context, services) => {
    // A delegated read cannot satisfy the parent's read-before-edit requirement.
    const file = await services.files.read(context.project, textArgument(args, 'path'), context.readOnly ? undefined : context.sessionId);
    const lines = file.content!.split('\n');
    const start = args.startLine === undefined ? 1 : Number(args.startLine);
    const end = args.endLine === undefined ? lines.length : Number(args.endLine);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error('Supply positive 1-based startLine/endLine in ascending order.');
    const selected = lines.slice(start - 1, end).join('\n');
    return { text: `${file.path} [version: ${file.version}] (lines ${start}–${Math.min(end, lines.length)} of ${lines.length})\n${selected}` };
  },
  read_skill_resource: async (args, context, services) => {
    const content = await services.skills.readResource(context.project.id, textArgument(args, 'skill'), textArgument(args, 'path'));
    return { text: content };
  },
  search_files: async (args, context, services) => ({ text: await services.files.search(context.project, textArgument(args, 'query'), textArgument(args, 'path', true) || undefined, typeof args.maxResults === 'number' ? args.maxResults : undefined, typeof args.contextLines === 'number' ? args.contextLines : undefined, { regex: args.regex as boolean | undefined, ignoreCase: args.ignoreCase as boolean | undefined, glob: args.glob as string | undefined, signal: context.signal }) }),
  write_file: async (args, context, services) => {
    await services.files.write(context.project, textArgument(args, 'path'), textArgument(args, 'content'), context.sessionId, { requireRead: true, checkpointId: context.checkpointId });
    return { text: 'File saved. A reversible snapshot was recorded.' };
  },
  edit_file: async (args, context, services) => {
    if (args.edits !== undefined) {
      if (args.oldText !== undefined || args.newText !== undefined || args.replaceAll !== undefined) throw new Error('Supply edits or oldText/newText, not both.');
      await services.files.editBatch(context.project, textArgument(args, 'path'), args.edits as TextEdit[], context.sessionId, { requireRead: true, checkpointId: context.checkpointId });
    } else await services.files.edit(context.project, textArgument(args, 'path'), textArgument(args, 'oldText'), textArgument(args, 'newText'), args.replaceAll === true, context.sessionId, { requireRead: true, checkpointId: context.checkpointId });
    return { text: 'File edited. A reversible snapshot was recorded.' };
  },
  inspect_image: async (args, context, services) => {
    if (args.detail !== undefined && !['low', 'high', 'auto'].includes(String(args.detail))) throw new Error('Image detail must be low, high or auto.');
    let id = textArgument(args, 'attachmentId', true);
    if (id) {
      const messages = await services.getMessages(context.sessionId);
      if (!messages.some(message => message.attachmentIds?.includes(id))) throw new Error('Image attachment is not available in this session.');
    } else {
      const file = await services.files.resolvePath(context.project, textArgument(args, 'path'));
      id = (await services.attachments.import([file], { reuse: true }))[0].id;
    }
    const attachment = await services.attachments.get(id);
    return { text: JSON.stringify(attachment), attachmentIds: [id], imageDetail: (args.detail ?? 'low') as 'low' | 'high' | 'auto' };
  },
  web_fetch: async (args, context) => ({ text: await webFetch(context.project, textArgument(args, 'url'), context.signal) }),
  web_search: async (args, context) => ({ text: await webSearch(context.project, textArgument(args, 'query'), context.signal) }),
  start_background_command: async (args, context, services) => ({ text: JSON.stringify(await services.commands.startBackground(context, textArgument(args, 'command'), textArgument(args, 'cwd', true) || undefined, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined, await services.skills.readRoots(context.project.id))) }),
  list_processes: async (_args, context, services) => ({ text: JSON.stringify(await services.commands.listProcesses(context.project.id, context.sessionId)) }),
  stop_process: async (args, context, services) => { await services.commands.stopManaged(context, textArgument(args, 'processId')); return { text: 'Process stopped.' }; },
  run_command: async (args, context, services) => {
    let process: CommandProcess | undefined;
    const text = await services.files.trackCommand(context.project, context.sessionId, async () => {
      process = await services.commands.runDetailed(context, textArgument(args, 'command'), textArgument(args, 'cwd', true) || undefined, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined, await services.skills.readRoots(context.project.id));
      return process.output;
    }, context.checkpointId);
    return { text, ...(process?.status !== 'completed' || !process.exitObserved ? { error: true } : {}),
      ...(process?.exitObserved ? { commandExit: { code: process.exitCode! } } : {}) };
  },
  typescript_diagnostics: async (args, context, services) => services.diagnostics.typescript(context, args),
};

// Registration fails at bootstrap if a definition has no handler; avoid a second dispatch switch.
export const builtinTools: RegisteredTool<WorkspaceServices>[] = definitions.map(definition => ({ definition, execute: handlers[definition.name] }));
export const toolDefinitions: ToolDefinition[] = builtinTools.map(tool => structuredClone(tool.definition));
