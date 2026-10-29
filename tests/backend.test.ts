import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { WorkspaceServices, sandboxAvailable } from '../src/backend';
import { decodeSkillArchive } from '../src/backend/skills';
import { isPublicAddress, validatePublicUrl } from '../src/backend/network';
import { sandboxProfile } from '../src/backend/commands';
import { modelPresets } from '../src/shared/model-presets';
import type { ModelConfig } from '../src/shared/types';

const legacyDefault: ModelConfig = {
  id: 'deepinfra-claude-sonnet-55', name: 'Claude Sonnet 5.5 · DeepInfra', kind: 'openai-compatible',
  baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'anthropic/claude-sonnet-5-5',
  apiKeyEnv: 'DEEPINFRA_API_KEY', contextWindow: 1_000_000, maxOutputTokens: 8192, vision: true, enabled: true,
};

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-backend-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writable = path.join(root, 'project');
  const readonly = path.join(writable, 'reference');
  const outside = path.join(root, 'outside');
  await Promise.all([mkdir(readonly, { recursive: true }), mkdir(outside)]);
  const service = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => undefined });
  await service.bootstrap();
  const project = await service.createProject({ name: 'Example', folders: [{ path: writable, access: 'write' }, { path: readonly, access: 'read' }] });
  return { root, writable, readonly, outside, service, project };
}

test('provider presets initialize once and a deleted default stays deleted after reopening', async t => {
  const { root, service } = await fixture(t);
  const preset = modelPresets[0];
  assert.deepEqual((await service.bootstrap()).models.find(model => model.id === preset.id), { id: preset.id, ...preset.configuration });
  assert.equal((await service.store.read()).modelPresetsRevision, 2);
  await service.deleteModel(preset.id);
  const reopened = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => undefined });
  assert.equal((await reopened.bootstrap()).models.some(model => model.id === preset.id), false);
  assert.equal((await reopened.bootstrap()).models.some(model => model.id === preset.id), false);
  const restartedAgain = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  assert.equal((await restartedAgain.bootstrap()).models.some(model => model.id === preset.id), false);
});

test('preset migration preserves an existing API model without adding another provider', async t => {
  const { service } = await fixture(t);
  const custom = await service.saveModel({ ...modelPresets[0].configuration, id: 'existing-provider', name: 'Existing provider', baseUrl: 'https://provider.example.test/v1', model: 'user-model', apiKeyEnv: 'CUSTOM_PROVIDER_KEY', contextWindow: 64_000, maxOutputTokens: 4096, vision: false, enabled: false });
  await service.store.mutate(state => {
    state.models = state.models.filter(model => model.kind === 'demo' || model.id === custom.id);
    state.modelPresetsInitialized = true;
    delete state.modelPresetsRevision;
  });
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  const models = (await reopened.bootstrap()).models;
  assert.equal(models.filter(model => model.kind !== 'demo').length, 1);
  assert.deepEqual(models.find(model => model.id === custom.id), custom);
  assert.equal((await reopened.store.read()).modelPresetsRevision, 2);
});

test('legacy default migration adds the current preset once without changing old models or sessions', async t => {
  const { service, project } = await fixture(t);
  await service.store.mutate(state => {
    state.models = [...state.models.filter(model => model.kind === 'demo'), structuredClone(legacyDefault)];
    state.modelPresetsInitialized = true;
    delete state.modelPresetsRevision;
  });
  const session = await service.createSession(project.id, legacyDefault.id);
  await service.appendMessage(session.id, { id: 'legacy-message', role: 'user', content: 'Keep the old provider selected.', createdAt: new Date().toISOString() });
  const oldMessages = await service.getMessages(session.id);
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  const models = (await reopened.bootstrap()).models;
  assert.deepEqual(models.find(model => model.id === legacyDefault.id), legacyDefault);
  assert.deepEqual(models.find(model => model.id === modelPresets[0].id), { id: modelPresets[0].id, ...modelPresets[0].configuration });
  assert.equal(models.filter(model => model.kind !== 'demo').length, 2);
  assert.equal((await reopened.getSession(session.id)).modelId, legacyDefault.id);
  assert.deepEqual(await reopened.getMessages(session.id), oldMessages);
  await reopened.deleteModel(modelPresets[0].id);
  const restartedAgain = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  const afterDeletion = (await restartedAgain.bootstrap()).models;
  assert.deepEqual(afterDeletion.filter(model => model.kind !== 'demo'), [legacyDefault]);
  assert.equal((await restartedAgain.store.read()).modelPresetsInitialized, true);
  assert.equal((await restartedAgain.store.read()).modelPresetsRevision, 2);
});

test('a customized legacy default counts as a user provider and is not migrated', async t => {
  const { service } = await fixture(t);
  const customized = { ...legacyDefault, name: 'My Claude profile', maxOutputTokens: 4096 };
  await service.store.mutate(state => {
    state.models = [...state.models.filter(model => model.kind === 'demo'), customized];
    state.modelPresetsInitialized = true;
    delete state.modelPresetsRevision;
  });
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  assert.deepEqual((await reopened.bootstrap()).models.filter(model => model.kind !== 'demo'), [customized]);
  assert.equal((await reopened.store.read()).modelPresetsRevision, 2);
});

test('an existing current preset ID is never duplicated or overwritten during legacy migration', async t => {
  const { service } = await fixture(t);
  const customized = await service.saveModel({ id: modelPresets[0].id, ...modelPresets[0].configuration, name: 'Existing customized current profile', contextWindow: 64_000, maxOutputTokens: 4096 });
  await service.store.mutate(state => { state.modelPresetsInitialized = true; state.modelPresetsRevision = 1; });
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  assert.deepEqual((await reopened.bootstrap()).models.filter(model => model.id === customized.id), [customized]);
  assert.equal((await reopened.store.read()).modelPresetsRevision, 2);
});

test('legacy initialized installs without API providers receive the new preset only once', async t => {
  const { service } = await fixture(t);
  await service.store.mutate(state => {
    state.models = state.models.filter(model => model.kind === 'demo');
    state.modelPresetsInitialized = true;
    delete state.modelPresetsRevision;
  });
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  assert.deepEqual((await reopened.bootstrap()).models.filter(model => model.kind !== 'demo'), [{ id: modelPresets[0].id, ...modelPresets[0].configuration }]);
  await reopened.deleteModel(modelPresets[0].id);
  const restartedAgain = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  assert.equal((await restartedAgain.bootstrap()).models.some(model => model.kind !== 'demo'), false);
});

test('filesystem enforces write scopes, nested read-only folders and traversal', async t => {
  const { service, project, writable, readonly, outside } = await fixture(t);
  await writeFile(path.join(readonly, 'reference.txt'), 'reference');
  await writeFile(path.join(outside, 'other.txt'), 'outside');
  await service.writeFile(project.id, 'src/example.ts', 'export const answer = 42;');
  assert.equal((await service.readFile(project.id, path.join(writable, 'src/example.ts'))).content, 'export const answer = 42;');
  assert.equal((await service.readFile(project.id, path.join(readonly, 'reference.txt'))).writable, false);
  await assert.rejects(service.writeFile(project.id, path.join(readonly, 'reference.txt'), 'changed'), /read-only/);
  await assert.rejects(service.readFile(project.id, '../outside/other.txt'), /outside/);
  await assert.rejects(service.writeFile(project.id, '../../escape.txt', 'escape'), /outside/);
});

test('symlinks cannot escape a project or bypass credential-file protections', async t => {
  const { service, project, writable, outside } = await fixture(t);
  await writeFile(path.join(outside, 'outside.txt'), 'outside');
  await symlink(outside, path.join(writable, 'escape'));
  await assert.rejects(service.readFile(project.id, 'escape/outside.txt'), /Symbolic link/);
  await assert.rejects(service.writeFile(project.id, 'escape/new.txt', 'escape'), /Symbolic link/);
  await writeFile(path.join(writable, '.env'), 'PLACEHOLDER=not-a-secret');
  await symlink(path.join(writable, '.env'), path.join(writable, 'looks-safe.txt'));
  await assert.rejects(service.readFile(project.id, '.env'), /credential/);
  await assert.rejects(service.readFile(project.id, 'looks-safe.txt'), /credential/);
  await assert.rejects(service.writeFile(project.id, '.env', 'anything'), /credential/);
  assert.equal(await service.searchFiles(project.id, 'PLACEHOLDER'), 'No matching text found in permitted files.');
});

test('an explicitly writable nested folder overrides its read-only parent', async t => {
  const { service, writable, readonly } = await fixture(t);
  const project = await service.createProject({ name: 'Nested writable', folders: [{ path: writable, access: 'read' }, { path: readonly, access: 'write' }] });
  await service.writeFile(project.id, path.join(readonly, 'new.txt'), 'allowed');
  await assert.rejects(service.writeFile(project.id, path.join(writable, 'new.txt'), 'blocked'), /read-only/);
});

test('undo restores original content and refuses to overwrite later external edits', async t => {
  const { service, project, writable } = await fixture(t);
  await writeFile(path.join(writable, 'example.txt'), 'original');
  await service.writeFile(project.id, 'example.txt', 'agent edit');
  const [change] = await service.getChanges(project.id);
  assert.equal(change.before, 'original');
  await writeFile(path.join(writable, 'example.txt'), 'user edit');
  await assert.rejects(service.revertChange(project.id, change.id), /preserve newer edits/);
  assert.equal(await readFile(path.join(writable, 'example.txt'), 'utf8'), 'user edit');
  await writeFile(path.join(writable, 'example.txt'), 'agent edit');
  await service.revertChange(project.id, change.id);
  assert.equal(await readFile(path.join(writable, 'example.txt'), 'utf8'), 'original');
  await service.writeFile(project.id, 'new.txt', 'new content');
  const [created] = await service.getChanges(project.id);
  await service.revertChange(project.id, created.id);
  await assert.rejects(readFile(path.join(writable, 'new.txt')), { code: 'ENOENT' });
});

test('command snapshots record edited, created and deleted files with guarded undo', async t => {
  const { service, project, writable } = await fixture(t);
  await writeFile(path.join(writable, 'edited.txt'), 'before edit');
  await writeFile(path.join(writable, 'deleted.txt'), 'before delete');
  const output = await service.files.trackCommand(project, 'command-session', async () => {
    await writeFile(path.join(writable, 'edited.txt'), 'after edit');
    await rm(path.join(writable, 'deleted.txt'));
    await writeFile(path.join(writable, 'created.txt'), 'new content');
    return 'Exit 0';
  });
  assert.match(output, /Recorded 3 text file changes/);
  const changes = await service.getChanges(project.id);
  const deleted = changes.find(change => change.path.endsWith('/deleted.txt'))!;
  assert.equal(deleted.after, null);
  assert.equal(deleted.before, 'before delete');
  await writeFile(path.join(writable, 'deleted.txt'), 'new user content');
  await assert.rejects(service.revertChange(project.id, deleted.id), /preserve newer edits/);
  await rm(path.join(writable, 'deleted.txt'));
  await service.revertChange(project.id, deleted.id);
  assert.equal(await readFile(path.join(writable, 'deleted.txt'), 'utf8'), 'before delete');
  await service.revertChange(project.id, changes.find(change => change.path.endsWith('/created.txt'))!.id);
  await assert.rejects(readFile(path.join(writable, 'created.txt')), { code: 'ENOENT' });
  await service.revertChange(project.id, changes.find(change => change.path.endsWith('/edited.txt'))!.id);
  assert.equal(await readFile(path.join(writable, 'edited.txt'), 'utf8'), 'before edit');
});

test('command snapshots disclose size limits and do not mistake untracked existing files for new files', async t => {
  const { service, project, writable } = await fixture(t);
  await writeFile(path.join(writable, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await mkdir(path.join(writable, 'node_modules'));
  const output = await service.files.trackCommand(project, 'command-session', async () => {
    await writeFile(path.join(writable, 'large.txt'), 'resized existing file');
    await writeFile(path.join(writable, 'node_modules/ignored.txt'), 'generated dependency');
    return 'Exit 0';
  });
  assert.match(output, /1 file reads were skipped/);
  assert.equal((await service.getChanges(project.id)).length, 0);
});

test('changes and session tool contexts cannot cross project boundaries', async t => {
  const { service, project, outside } = await fixture(t);
  const other = await service.createProject({ name: 'Other', folders: [{ path: outside, access: 'write' }] });
  await service.writeFile(project.id, 'new.txt', 'example');
  const [change] = await service.getChanges(project.id);
  await assert.rejects(service.revertChange(other.id, change.id), /not found in this project/);
  const session = await service.createSession(project.id, 'demo');
  const result = await service.executeTool({ id: 'tool', name: 'write_file', arguments: { path: 'foreign.txt', content: 'bad' } }, { project: other, sessionId: session.id, signal: new AbortController().signal });
  assert.equal(result.error, true);
  assert.match(result.text, /does not belong/);
});

test('stale tool contexts cannot redirect pending relative writes after folders change', async t => {
  const { service, project, outside } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await service.saveProject({ ...project, folders: [{ path: outside, access: 'write' }] });
  const result = await service.executeTool({ id: 'old-context', name: 'write_file', arguments: { path: 'unexpected.txt', content: 'wrong folder' } }, { project, sessionId: session.id, signal: new AbortController().signal });
  assert.equal(result.error, true);
  assert.match(result.text, /folders changed/);
  await assert.rejects(readFile(path.join(outside, 'unexpected.txt')), { code: 'ENOENT' });
});

test('selecting an application-storage ancestor does not expose private state through file tools or scans', async t => {
  const { service, root } = await fixture(t);
  const privateRoot = path.join(root, 'data');
  const project = await service.createProject({ name: 'Ancestor folder', folders: [{ path: root, access: 'write' }] });
  await writeFile(path.join(privateRoot, 'AGENTS.md'), 'private-only-marker');
  await symlink(privateRoot, path.join(root, 'state-alias'));
  await mkdir(path.join(root, '.workbench'), { recursive: true });
  await service.writeFile(project.id, '.workbench/user-document.txt', 'ordinary user content');
  assert.equal((await service.readFile(project.id, '.workbench/user-document.txt')).content, 'ordinary user content');
  await assert.rejects(service.readFile(project.id, 'data/workspace.json'), /Application storage is private/);
  await assert.rejects(service.writeFile(project.id, 'data/workspace.json', '{}'), /Application storage is private/);
  await assert.rejects(service.readFile(project.id, 'state-alias/workspace.json'), /Application storage is private/);
  await assert.rejects(service.listFiles(project.id, privateRoot), /Application storage is private/);
  assert.equal(await service.searchFiles(project.id, 'private-only-marker'), 'No matching text found in permitted files.');
  assert.ok(!(await service.files.walk(project)).some(file => file.startsWith(`${privateRoot}/`)));
  assert.ok(!(await service.getRules(project.id)).some(rule => rule.path === path.join(privateRoot, 'AGENTS.md')));
});

test('persistence survives reopening and bootstrap refresh preserves active runs', async t => {
  const { service, project, root } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await service.appendMessage(session.id, { id: 'message', role: 'user', content: 'Remember this', createdAt: new Date().toISOString() });
  await service.updateSession(session.id, { status: 'running' });
  assert.equal((await service.bootstrap()).sessions.find(value => value.id === session.id)?.status, 'running');
  const reopened = new WorkspaceServices(path.join(root, 'data'), { approve: async () => true, emit: () => undefined });
  assert.equal((await reopened.bootstrap()).sessions.find(value => value.id === session.id)?.status, 'stopped');
  assert.equal((await reopened.getMessages(session.id))[0].content, 'Remember this');
  assert.equal((await reopened.getProject(project.id)).name, 'Example');
});

test('chat modes default to auto-edit, validate updates, and survive reopening', async t => {
  const { service, project } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  assert.equal(session.mode, 'auto-edit');
  await assert.rejects(service.updateSession(session.id, { mode: 'unknown' as any }), /Invalid chat mode/);
  assert.equal((await service.getSession(session.id)).mode, 'auto-edit');
  await service.updateSession(session.id, { mode: 'plan' });
  const reopened = new WorkspaceServices(service.store.directory, { approve: async () => true, emit: () => undefined });
  await reopened.bootstrap();
  assert.equal((await reopened.getSession(session.id)).mode, 'plan');
});

test('Plan mode rejects direct write, edit and command calls before side effects while read tools remain available', async t => {
  const { service, project, writable } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await service.updateSession(session.id, { mode: 'plan' });
  await writeFile(path.join(writable, 'existing.txt'), 'original');
  const context = { project, sessionId: session.id, signal: new AbortController().signal };
  for (const tool of [
    { id: 'write', name: 'write_file', arguments: { path: 'new.txt', content: 'forbidden' } },
    { id: 'edit', name: 'edit_file', arguments: { path: 'existing.txt', oldText: 'original', newText: 'forbidden' } },
    { id: 'command', name: 'run_command', arguments: { command: "printf '%s' 'forbidden' > command.txt" } },
  ]) {
    const result = await service.executeTool(tool, context);
    assert.equal(result.error, true); assert.match(result.text, /Plan mode/);
  }
  await assert.rejects(service.commands.run(context, "printf '%s' 'forbidden' > command.txt"), /Plan mode/);
  assert.equal(await readFile(path.join(writable, 'existing.txt'), 'utf8'), 'original');
  await assert.rejects(readFile(path.join(writable, 'new.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(writable, 'command.txt')), { code: 'ENOENT' });
  assert.deepEqual(await service.getChanges(project.id), []);
  assert.match((await service.executeTool({ id: 'read', name: 'read_file', arguments: { path: 'existing.txt' } }, context)).text, /original/);
});

test('stored chat mode is authoritative and legacy sessions retain auto-edit behavior', async t => {
  const { service, project, writable } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  const context = { project, sessionId: session.id, signal: new AbortController().signal };
  const tool = { id: 'write', name: 'write_file', arguments: { path: 'mode.txt', content: 'allowed legacy edit' } };
  await service.updateSession(session.id, { mode: 'plan' });
  const spoofed = await service.executeTool(tool, { ...context, mode: 'bypass' });
  assert.equal(spoofed.error, true); assert.match(spoofed.text, /Chat mode changed/);
  await assert.rejects(service.commands.run({ ...context, mode: 'bypass' }, 'true'), /Chat mode changed/);
  await assert.rejects(readFile(path.join(writable, 'mode.txt')), { code: 'ENOENT' });
  await service.store.mutate(state => { delete state.sessions.find(item => item.id === session.id)!.mode; });
  assert.equal((await service.executeTool(tool, context)).error, undefined);
  assert.equal(await readFile(path.join(writable, 'mode.txt'), 'utf8'), 'allowed legacy edit');
});

test('Bypass mode preserves readonly folders, containment, protected files and disabled internet', async t => {
  const { service, project, readonly, outside, writable } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await service.updateSession(session.id, { mode: 'bypass' });
  await writeFile(path.join(readonly, 'reference.txt'), 'reference');
  await writeFile(path.join(writable, '.env'), 'PLACEHOLDER=not-a-real-secret');
  const context = { project, sessionId: session.id, signal: new AbortController().signal, mode: 'bypass' as const };
  for (const file of [path.join(readonly, 'reference.txt'), path.join(outside, 'escape.txt'), path.join(writable, '.env')]) {
    const result = await service.executeTool({ id: 'write', name: 'write_file', arguments: { path: file, content: 'forbidden' } }, context);
    assert.equal(result.error, true);
  }
  const network = await service.executeTool({ id: 'internet', name: 'web_fetch', arguments: { url: 'https://example.com' } }, context);
  assert.equal(network.error, true); assert.match(network.text, /Internet access is disabled/);
  assert.equal(await readFile(path.join(readonly, 'reference.txt'), 'utf8'), 'reference');
  await assert.rejects(readFile(path.join(outside, 'escape.txt')), { code: 'ENOENT' });
});

test('actual macOS Ask confirms sandbox-policy commands, Bypass skips prompts, and mode changes revoke pending commands', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run from ordinary macOS Terminal for sandbox-exec command acceptance.'); return; }
  const { service, project, writable, readonly } = await fixture(t);
  let approvals = 0;
  let approve = async () => false;
  const controlled = new WorkspaceServices(service.store.directory, { approve: async () => { approvals++; return approve(); }, emit: () => undefined });
  await controlled.bootstrap();
  const current = await controlled.saveProject({ ...project, commandPolicy: 'sandbox' });
  const session = await controlled.createSession(current.id, 'demo');
  await controlled.updateSession(session.id, { mode: 'ask' });
  const context = { project: current, sessionId: session.id, signal: new AbortController().signal };
  const command = { id: 'command', name: 'run_command', arguments: { command: "printf '%s' 'fixture result' > mode-command.txt" } };
  const declined = await controlled.executeTool(command, context);
  assert.equal(declined.error, true); assert.match(declined.text, /declined/); assert.equal(approvals, 1);
  await assert.rejects(readFile(path.join(writable, 'mode-command.txt')), { code: 'ENOENT' });
  await controlled.updateSession(session.id, { mode: 'bypass' });
  const askProject = await controlled.saveProject({ ...current, commandPolicy: 'ask' });
  const bypass = await controlled.executeTool(command, { ...context, project: askProject });
  assert.equal(bypass.error, undefined, bypass.text); assert.equal(approvals, 1);
  assert.equal(await readFile(path.join(writable, 'mode-command.txt'), 'utf8'), 'fixture result');
  const forbidden = await controlled.executeTool({ id: 'readonly-command', name: 'run_command', arguments: { command: `printf '%s' 'forbidden' > '${path.join(readonly, 'forbidden.txt')}'` } }, { ...context, project: askProject });
  assert.equal(forbidden.error, true); assert.equal(approvals, 1);
  await assert.rejects(readFile(path.join(readonly, 'forbidden.txt')), { code: 'ENOENT' });
  await controlled.updateSession(session.id, { mode: 'ask' });
  approve = async () => { await controlled.updateSession(session.id, { mode: 'plan' }); return true; };
  const revoked = await controlled.executeTool({ id: 'revoked-command', name: 'run_command', arguments: { command: "printf '%s' 'forbidden' > revoked.txt" } }, { ...context, project: askProject });
  assert.equal(revoked.error, true); assert.match(revoked.text, /Chat mode changed/);
  await assert.rejects(readFile(path.join(writable, 'revoked.txt')), { code: 'ENOENT' });
});

test('concurrent independent state updates preserve all messages', async t => {
  const { service, project } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await Promise.all(Array.from({ length: 20 }, (_value, index) => service.appendMessage(session.id, { id: `message-${index}`, role: 'user', content: String(index), createdAt: new Date().toISOString() })));
  assert.equal((await service.getMessages(session.id)).length, 20);
});

test('concurrent exact edits preserve both changes instead of overwriting stale content', async t => {
  const { service, project } = await fixture(t);
  await service.writeFile(project.id, 'parallel.txt', 'one\ntwo\n');
  await Promise.all([
    service.files.edit(project, 'parallel.txt', 'one', 'ONE'),
    service.files.edit(project, 'parallel.txt', 'two', 'TWO'),
  ]);
  assert.equal((await service.readFile(project.id, 'parallel.txt')).content, 'ONE\nTWO\n');
});

test('projects sharing a writable folder serialize overlapping file mutations', async t => {
  const { service, project, writable } = await fixture(t);
  const other = await service.createProject({ name: 'Shared project', folders: [{ path: writable, access: 'write' }] });
  await service.writeFile(project.id, 'parallel.txt', 'one\ntwo\n');
  await Promise.all([
    service.files.edit(project, 'parallel.txt', 'one', 'ONE'),
    service.files.edit(other, 'parallel.txt', 'two', 'TWO'),
  ]);
  assert.equal((await service.readFile(project.id, 'parallel.txt')).content, 'ONE\nTWO\n');
});

test('scoped project rules include nested AGENTS.md and editable settings', async t => {
  const { service, project, writable, readonly } = await fixture(t);
  await mkdir(path.join(writable, 'src'));
  await writeFile(path.join(writable, 'src/AGENTS.md'), 'Nested source rules');
  await writeFile(path.join(readonly, 'AGENTS.md'), 'Reference rules');
  await service.saveRule(project.id, `project:${project.id}`, 'Project-wide preference');
  const rules = await service.getRules(project.id);
  assert.ok(rules.some(rule => rule.scope === path.join(writable, 'src') && rule.content === 'Nested source rules'));
  assert.ok(rules.some(rule => rule.path === `project:${project.id}` && rule.content === 'Project-wide preference'));
  assert.equal(rules.find(rule => rule.path === path.join(readonly, 'AGENTS.md'))?.writable, false);
  await assert.rejects(service.saveRule(project.id, path.join(readonly, 'AGENTS.md'), 'bad'), /read-only/);
});

test('skill archive traversal and decompression-limit violations are rejected', () => {
  assert.throws(() => decodeSkillArchive(zipSync({ '../outside.txt': Buffer.from('bad') })), /traversal/);
  assert.throws(() => decodeSkillArchive(zipSync({ '/absolute/SKILL.md': Buffer.from('bad') })), /Unsafe/);
  assert.throws(() => decodeSkillArchive(zipSync({ 'C:\\outside': Buffer.from('bad') })), /Unsafe/);
  assert.throws(() => decodeSkillArchive(zipSync({ 'repo/large.bin': new Uint8Array(17 * 1024 * 1024) })), /limits/);
  const files = decodeSkillArchive(zipSync({ 'repo/SKILL.md': Buffer.from('Safe'), 'repo/.env': Buffer.from('PLACEHOLDER') }));
  assert.ok(files.has('repo/SKILL.md'));
  assert.equal(files.has('repo/.env'), false);
});

test('local skill install, edit, export and project scope remain isolated', async t => {
  const { service, project, outside, root } = await fixture(t);
  const other = await service.createProject({ name: 'Other', folders: [{ path: outside, access: 'write' }] });
  const source = path.join(root, '.codex/skills/my-skill');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: source-skill\ndescription: Imported safely\n---\n\nDo useful work.');
  await writeFile(path.join(source, '.env'), 'PLACEHOLDER=not-a-secret');
  const [installed] = await service.installSkill({ kind: 'folder', location: source }, project.id);
  assert.equal(installed.name, 'source-skill');
  assert.ok((await service.listSkills(project.id)).some(skill => skill.id === installed.id));
  assert.equal((await service.listSkills(other.id)).length, 0);
  await service.saveSkill(installed.id, '---\nname: edited-skill\ndescription: Updated\n---\nNew content');
  assert.match(await service.readSkill(installed.id), /New content/);
  const exported = await service.exportSkill(installed.id);
  const files = decodeSkillArchive(await readFile(exported));
  assert.ok(files.has('SKILL.md'));
  assert.equal(files.has('.env'), false);
  await service.removeSkill(installed.id);
  assert.equal((await service.listSkills(project.id)).length, 0);
  const global = await service.createSkill({ name: 'Global helper', description: 'Shared instruction', content: 'Useful instruction' });
  assert.ok((await service.listSkills(other.id)).some(skill => skill.id === global.id));
});

test('local skill import refuses symlinked resources', async t => {
  const { service, root, outside } = await fixture(t);
  const source = path.join(root, 'skill');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '# Skill');
  await symlink(outside, path.join(source, 'resources'));
  await assert.rejects(service.installSkill({ kind: 'folder', location: source }), /symbolic links/);
});

test('skill resource reads respect enabled state, project scope and containment', async t => {
  const { service, project, outside, root } = await fixture(t);
  const other = await service.createProject({ name: 'Other', folders: [{ path: outside, access: 'read' }] });
  const source = path.join(root, 'resource-skill');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: resource-reader\ndescription: References\n---\nRead references/example.md.');
  await writeFile(path.join(source, 'references/example.md'), 'Relevant reference');
  const [skill] = await service.installSkill({ kind: 'folder', location: source }, project.id);
  assert.equal(await service.skills.readResource(project.id, skill.name, 'references/example.md'), 'Relevant reference');
  await assert.rejects(service.skills.readResource(other.id, skill.id, 'references/example.md'), /not found/);
  await assert.rejects(service.skills.readResource(project.id, skill.id, '../workspace.json'), /traversal/);
  await symlink(outside, path.join(skill.path, 'escaped'));
  await writeFile(path.join(outside, 'other.txt'), 'Other project data');
  await assert.rejects(service.skills.readResource(project.id, skill.id, 'escaped/other.txt'), /leaves/);
  await service.setSkillEnabled(skill.id, false);
  await assert.rejects(service.skills.readResource(project.id, skill.id, 'references/example.md'), /not found/);
});

test('range file reads can access text beyond the initial output limit', async t => {
  const { service, project } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  await service.writeFile(project.id, 'many-lines.txt', `${'First line '.repeat(5000)}\nSecond line\nThird line`);
  const result = await service.executeTool({ id: 'read-range', name: 'read_file', arguments: { path: 'many-lines.txt', startLine: 2, endLine: 3 } }, { project, sessionId: session.id, signal: new AbortController().signal });
  assert.equal(result.error, undefined);
  assert.match(result.text, /Second line\nThird line/);
  assert.doesNotMatch(result.text, /First line/);
});

test('image imports validate magic, retain many attachments and enforce session ownership', async t => {
  const { service, root, project } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3wAAAABJRU5ErkJggg==', 'base64');
  const image = path.join(root, 'image.png');
  const fake = path.join(root, 'fake.png');
  await writeFile(image, png);
  await writeFile(fake, 'This is not an image');
  await assert.rejects(service.importImages([fake]), /formats/);
  const images = await service.importImages(Array.from({ length: 20 }, () => image));
  assert.equal(images.length, 20);
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].width, 1);
  const first = await service.createSession(project.id, 'demo');
  const second = await service.createSession(project.id, 'demo');
  await service.appendMessage(first.id, { id: 'with-image', role: 'user', content: 'Inspect', attachmentIds: [images[0].id], createdAt: new Date().toISOString() });
  const call = { id: 'inspect', name: 'inspect_image', arguments: { attachmentId: images[0].id } };
  const valid = await service.executeTool(call, { project, sessionId: first.id, signal: new AbortController().signal });
  assert.deepEqual(valid.attachmentIds, [images[0].id]);
  const invalid = await service.executeTool(call, { project, sessionId: second.id, signal: new AbortController().signal });
  assert.equal(invalid.error, true);
  assert.match(invalid.text, /not available in this session/);
});

test('public network validation rejects private destinations and credential URLs', () => {
  for (const value of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://127.0.0.1', 'http://localhost', 'https://user:pass@example.com', 'https://example.com?api_key=placeholder', 'file:///tmp/example']) assert.throws(() => validatePublicUrl(url));
  assert.equal(validatePublicUrl('https://example.com/docs').hostname, 'example.com');
});

test('disabled project internet tools fail before network activity', async t => {
  const { service, project } = await fixture(t);
  const session = await service.createSession(project.id, 'demo');
  const result = await service.executeTool({ id: 'network', name: 'web_fetch', arguments: { url: 'https://example.com' } }, { project, sessionId: session.id, signal: new AbortController().signal });
  assert.equal(result.error, true);
  assert.match(result.text, /Internet access is disabled/);
});

test('macOS command profile explicitly restricts writable roots and credentials', () => {
  const profile = sandboxProfile([{ path: '/example/project', access: 'write' }, { path: '/example/project/reference', access: 'read' }], '/example/scratch', false);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/example\/project\/reference"\)\)/);
  assert.ok(profile.includes('\\\\.[eE][nN][vV]'));
  assert.doesNotMatch(profile, /\(allow network-outbound\)/);
});

test('command profile denies private appdata while making only scratch and enabled skill reads exceptional', () => {
  const privateRoot = '/example/project/.workbench/state';
  const temporary = `${privateRoot}/command-scratch/run`;
  const skillRoot = `${privateRoot}/skills/global/skill`;
  const profile = sandboxProfile([{ path: '/example/project', access: 'write' }, { path: skillRoot, access: 'read' }], temporary, false, privateRoot, [skillRoot]);
  assert.ok(profile.includes(`(deny file-read* (require-all (subpath "${privateRoot}") (require-not (subpath "${temporary}")) (require-not (subpath "${skillRoot}"))))`));
  assert.ok(profile.includes(`(deny file-write* (require-all (subpath "${privateRoot}") (require-not (subpath "${temporary}"))))`));
  assert.ok(profile.includes('(deny file-write-unlink (literal "/example/project/.workbench"))'));
});
