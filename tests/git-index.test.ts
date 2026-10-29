import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceServices, sandboxAvailable } from '../src/backend';
import { GitService } from '../src/backend/git';
import { ProjectIndexService, sourceSymbols } from '../src/backend/project-index';

const exec = promisify(execFile);
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-index-')));
  const services = new WorkspaceServices(path.join(root, 'state'), { approve: async () => true, emit: () => undefined }); await services.bootstrap();
  const project = await services.createProject({ name: 'Map fixture', folders: [{ path: root, access: 'write' }] });
  const git = new GitService(services.files, services.commands); const index = new ProjectIndexService(services.files);
  t.after(async () => { await services.commands.close(); await rm(root, { recursive: true, force: true }); });
  return { root, services, project, git, index };
}
async function fixtureGit(root: string, args: string[]) {
  return exec('/usr/bin/git', args, { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
}

test('project maps are bounded, prioritize entry files and omit private/credential/symlink paths', async t => {
  const { root, services, project, index } = await fixture(t);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'node_modules')); await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'README.md'), '# Fixture');
  await writeFile(path.join(root, 'src/main.ts'), 'export class Example {}\nexport async function start() {}\nconst hidden = 1;');
  await writeFile(path.join(root, '.env'), 'PLACEHOLDER=not-a-real-secret');
  await writeFile(path.join(root, 'node_modules/ignored.ts'), 'class NeverIndex {}');
  await writeFile(path.join(services.store.directory, 'private.ts'), 'class PrivateState {}');
  await symlink(services.store.directory, path.join(root, 'private-alias'));
  const map = await index.build(project);
  assert.equal(path.basename(map.files[0].path), 'README.md');
  assert.deepEqual(map.files.find(file => file.relativePath === 'src/main.ts')!.symbols, ['Example', 'start', 'hidden']);
  assert.ok(!map.files.some(file => /(?:state|private-alias|node_modules|\.git|\.env)(?:\/|$)/.test(file.relativePath)));
  assert.equal(map.truncated, false); assert.equal(map.scanned, 2);
  assert.deepEqual(sourceSymbols('def python_name():\n pass\nfunc (r Thing) Method() {}\npub struct RustThing {}'), ['python_name', 'Method', 'RustThing']);
});

test('project map discloses incomplete symbol coverage instead of loading large source files', async t => {
  const { root, project, index } = await fixture(t);
  await writeFile(path.join(root, 'large.ts'), ' '.repeat(129 * 1024) + '\nclass Unread {}');
  const map = await index.build(project);
  assert.equal(map.truncated, true); assert.deepEqual(map.files[0].symbols, []);
});

test('Git does not initialize an ordinary folder and refuses paths outside assigned roots', async t => {
  const { root, project, git } = await fixture(t);
  assert.deepEqual(await git.status(project), { roots: [{ root, repository: false, files: [] }] });
  assert.match((await git.diff(project, root)).text, /not a Git repository/);
  await assert.rejects(git.diff(project, path.dirname(root)), /outside/);
  await assert.rejects(readFile(path.join(root, '.git/HEAD')), { code: 'ENOENT' });
});

test('actual macOS Git reads branch/status/staged and working diffs without config/hooks or private contents', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run in ordinary macOS Terminal for actual read-only Git sandbox.'); return; }
  const { root, services, project, git } = await fixture(t);
  await fixtureGit(root, ['init', '-b', 'fixture-main']);
  await writeFile(path.join(root, 'tracked.txt'), 'original\n'); await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fixtureGit(root, ['add', 'tracked.txt', '.gitignore']); await fixtureGit(root, ['commit', '-m', 'Fixture baseline']);
  await writeFile(path.join(root, 'tracked.txt'), 'staged\n'); await fixtureGit(root, ['add', 'tracked.txt']);
  await writeFile(path.join(root, 'tracked.txt'), 'working\n');
  await writeFile(path.join(root, 'new.txt'), 'untracked'); await writeFile(path.join(root, 'ignored.txt'), 'ignored');
  await writeFile(path.join(root, '.env'), 'PLACEHOLDER=not-a-real-secret');
  // This controlled fixture config would break normal Git config parsing. The
  // service must use its sanitized metadata view, never inspect this file.
  await writeFile(path.join(root, '.git/config'), '[include]\npath = /path/that/does/not/exist\n[core]\nfsmonitor = /path/that/must/never/run\n');
  await writeFile(path.join(services.store.directory, 'private.txt'), 'fixture-private-data');
  const status = await git.status(project);
  assert.equal(status.roots[0].error, undefined, status.roots[0].error);
  assert.equal(status.roots[0].repository, true); assert.equal(status.roots[0].branch, 'fixture-main');
  assert.match(status.roots[0].head!, /^[a-f0-9]{40}$/);
  const tracked = status.roots[0].files.find(file => file.path.endsWith('/tracked.txt'))!;
  assert.equal(tracked.index, 'M'); assert.equal(tracked.worktree, 'M');
  assert.ok(status.roots[0].files.some(file => file.path.endsWith('/new.txt') && file.index === '?'));
  assert.ok(!status.roots[0].files.some(file => /(?:state\/|\.env$|ignored\.txt$)/.test(file.path)));
  const working = await git.diff(project, root, 'tracked.txt');
  assert.match(working.text, /-staged/); assert.match(working.text, /\+working/); assert.equal(working.truncated, false);
  const staged = await git.diff(project, root, 'tracked.txt', true);
  assert.match(staged.text, /-original/); assert.match(staged.text, /\+staged/);
  await assert.rejects(git.diff(project, root, '.env'), /credential or protected/);
  await assert.rejects(git.diff(project, root, path.join(services.store.directory, 'private.txt')), /Application storage is private/);
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'working\n');
});

test('actual macOS unborn Git repositories expose branch and permitted untracked files', async t => {
  if (!(await sandboxAvailable())) { t.skip('Run in ordinary macOS Terminal for actual Git sandbox.'); return; }
  const { root, project, git } = await fixture(t);
  await fixtureGit(root, ['init', '-b', 'fixture-empty']); await writeFile(path.join(root, 'new.txt'), 'new');
  const status = await git.status(project);
  assert.equal(status.roots[0].error, undefined, status.roots[0].error);
  assert.equal(status.roots[0].branch, 'fixture-empty'); assert.equal(status.roots[0].head, undefined);
  assert.ok(status.roots[0].files.some(file => file.path.endsWith('/new.txt')));
});

test('linked or escaping Git metadata fails closed before reading metadata contents', async t => {
  const { root, project, git } = await fixture(t);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-git-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.git'));
  const status = await git.status(project);
  assert.match(status.roots[0].error!, /Linked or external/);
});
