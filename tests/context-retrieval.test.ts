import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import { accessScope } from '../src/shared/task-evidence';
import type { ToolContext } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-retrieval-'))), projectRoot = path.join(root, 'project'), data = path.join(root, 'state');
  await mkdir(projectRoot); const host = new WorkspaceServices(data, { approve: async () => true, emit: () => {} }); await host.bootstrap();
  const project = await host.createProject({ name: 'Fixture', folders: [{ path: projectRoot, access: 'write' }] }), session = await host.createSession(project.id, 'demo');
  const context: ToolContext = { project, sessionId: session.id, signal: new AbortController().signal };
  t.after(() => rm(root, { recursive: true, force: true })); return { root, data, host, context };
}
test('large results survive restart and paged retrieval finds omitted middle without repeating actions', async t => {
  const { data, context, host } = await fixture(t);
  const full = 'a'.repeat(20_000) + 'middle-target' + 'z'.repeat(20_000);
  const result = await host.outputs.retain({ id: 'call', name: 'read_file', arguments: {} }, context, { text: full });
  assert.ok(result.outputRef); assert.ok(result.text.length < 18_000); assert.ok(!result.text.includes('middle-target'));
  const restarted = new WorkspaceServices(data, { approve: async () => true, emit: () => {} });
  const search = JSON.parse((await restarted.outputs.search(result.outputRef!, 'middle-target', context)).text);
  assert.equal(search.matches[0].offset, 20_000);
  const page = JSON.parse((await restarted.outputs.read(result.outputRef!, context, 20_000, 13)).text); assert.equal(page.text, 'middle-target');
  const info = await stat(path.join(data, 'tool-output', result.outputRef! + '.json')); assert.equal(info.mode & 0o777, 0o600);
  await assert.rejects(restarted.outputs.read(result.outputRef!, { ...context, sessionId: 'another' }), /unavailable/);
  await assert.rejects(restarted.outputs.read(result.outputRef!, { ...context, project: { ...context.project, folders: [] } }), /scope changed/);
});
test('history tools expose public sources with pagination and exclude opaque items and revoked observations', async t => {
  const { host, context } = await fixture(t);
  await host.appendMessage(context.sessionId, { id: 'user', role: 'user', content: 'Keep the requested behavior', createdAt: '' });
  await host.appendMessage(context.sessionId, { id: 'observation', role: 'tool', content: 'requested observation', toolName: 'read_file', toolCallId: 'read', createdAt: '', providerItems: [{ opaque: 'synthetic-hidden-item' }], reasoningDetails: [{ opaque: 'synthetic-hidden-reasoning' }] });
  const search = JSON.parse((await host.executeTool({ id: 'search', name: 'search_history', arguments: { query: 'requested', limit: 1 } }, context)).text);
  assert.equal(search.matches[0].messageId, 'user'); assert.equal(search.nextOffset, 1);
  const read = await host.history.read('observation', context); assert.ok(read.text.includes('requested observation')); assert.ok(!read.text.includes('synthetic-hidden'));
  const narrowed = { ...context, project: { ...context.project, folders: [] } };
  await assert.rejects(host.history.read('observation', narrowed), /unavailable/);
  assert.ok((await host.history.read('user', narrowed)).text.includes('Keep the requested'));
  assert.equal((await host.getMessages(context.sessionId))[1].accessScope, accessScope(context.project));
});
