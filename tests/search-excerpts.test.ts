import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/backend';
import type { ToolContext } from '../src/shared/types';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-search-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'); await mkdir(directory);
  const host = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => {} });
  await host.bootstrap();
  const project = await host.createProject({ name: 'Search', folders: [{ path: directory, access: 'write' }] });
  const session = await host.createSession(project.id, 'Search');
  const context: ToolContext = { project, sessionId: session.id, signal: new AbortController().signal };
  const search = (args: Record<string, unknown>) => host.executeTool({ id: 'search', name: 'search_files', arguments: args }, context);
  return { root, directory, host, context, search };
}

test('search supplies numbered context, merges nearby hits and exposes omitted ranges', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'code.py'), 'before\nNeedle one\nbetween\nneedle two\nafter\nunused\nunused\nunused\nneedle far\nend');
  const result = await f.search({ query: 'needle', contextLines: 1 });
  assert.equal(result.error, undefined);
  assert.match(result.text, /1-5 of 10/);
  assert.match(result.text, /1: before\n> 2: Needle one\n  3: between\n> 4: needle two\n  5: after/);
  assert.match(result.text, /8-10 of 10/);
  assert.equal(result.text.split('between').length - 1, 1);
  assert.doesNotMatch(result.text, /6:|7:/);
});

test('search preserves its default format and retrieves grouped branches only on request', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'branch.py'), 'if missing:\n    return fallback\n# literal a.*b\nelse:\n    return normal');
  assert.match((await f.search({ query: 'a.*b', contextLines: 2 })).text, /return fallback/);
  assert.doesNotMatch((await f.search({ query: 'a.*b' })).text, /return fallback/);
  assert.equal((await f.search({ query: 'a.*b' })).text, `${f.directory}/branch.py:3: # literal a.*b`);
  const compact = await f.search({ query: 'a.*b', contextLines: 0 });
  assert.match(compact.text, /> 3: # literal a\.\*b/);
  assert.doesNotMatch(compact.text, /return fallback/);
  assert.match((await f.search({ query: 'aZZb' })).text, /No matching/);
});

test('match limit counts hits, not surrounding lines, and marks only actual omission', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'hits.py'), 'start\nhit one\nmiddle\nhit two\nend');
  const limited = await f.search({ query: 'hit', maxResults: 1, contextLines: 1 });
  assert.match(limited.text, /start/);
  assert.match(limited.text, /middle/);
  assert.match(limited.text, /Result limit reached/);
  assert.doesNotMatch(limited.text, /hit two/);
  assert.doesNotMatch((await f.search({ query: 'hit', maxResults: 2, contextLines: 1 })).text, /Result limit reached/);
});

test('search preserves access boundaries and does not authorize edits', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'safe.py'), 'findme allowed');
  await writeFile(path.join(f.root, 'outside.py'), 'findme outside');
  await symlink(path.join(f.root, 'outside.py'), path.join(f.directory, 'escape.py'));
  await symlink(path.join(f.root, 'state'), path.join(f.directory, 'private'));
  await writeFile(path.join(f.directory, '.env'), '# findme synthetic fixture only');
  await writeFile(path.join(f.directory, 'binary'), Buffer.from([0, 102, 105, 110, 100, 109, 101]));
  const result = await f.search({ query: 'findme', contextLines: 2 });
  assert.match(result.text, /allowed/);
  assert.doesNotMatch(result.text, /outside|synthetic fixture|workspace.json|binary/);
  assert.equal((await f.search({ query: 'findme', path: '../outside.py', contextLines: 2 })).error, true);
  const edit = await f.host.executeTool({ id: 'edit', name: 'edit_file', arguments: { path: 'safe.py', oldText: 'allowed', newText: 'changed' } }, f.context);
  assert.equal(edit.error, true);
  assert.match(edit.text, /Read this file/);
});

test('invalid context is rejected and long lines have explicit retrieval guidance', async t => {
  const f = await fixture(t);
  for (const contextLines of [-1, 21, 1.5, '2']) assert.equal((await f.search({ query: 'hit', contextLines })).error, true);
  await writeFile(path.join(f.directory, 'long.py'), 'x'.repeat(600) + 'hit');
  const result = await f.search({ query: 'hit', contextLines: 0 });
  assert.match(result.text, /line truncated/);
  assert.match(result.text, /read_file/);
});

test('UI search retains its existing path:line format', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'ui.py'), 'before\nhit\nafter');
  assert.equal(await f.host.searchFiles(f.context.project.id, 'hit'), `${f.directory}/ui.py:2: hit`);
});
