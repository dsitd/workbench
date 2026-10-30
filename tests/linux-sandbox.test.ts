import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLinuxSandbox } from '../src/backend/sandbox/linux';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'linux-sandbox-contract-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'project'), privateRoot = path.join(project, '.workbench', 'state');
  const temporary = path.join(privateRoot, 'command-scratch', 'fixture');
  const readonly = path.join(project, 'reference'), writable = path.join(readonly, 'output');
  await Promise.all([mkdir(temporary, { recursive: true }), mkdir(writable, { recursive: true })]);
  return { project, privateRoot, temporary, readonly, writable };
}

function mounts(args: string[]) {
  return args.flatMap((arg, index) => ['--bind', '--ro-bind'].includes(arg) ? [{ flag: arg, source: args[index + 1], target: args[index + 2], index }] : []);
}

test('Linux plan preserves nested permissions, masks appdata and exposes scratch only', async t => {
  const f = await fixture(t);
  const launch = await prepareLinuxSandbox({
    roots: [{ path: f.writable, access: 'write' }, { path: f.project, access: 'write' }, { path: f.readonly, access: 'read' }],
    temporary: f.temporary, privateRoot: f.privateRoot, internet: false,
  }, '/bin/bash', ['-c', 'true']);
  t.after(launch.cleanup);
  assert.ok(launch.args.includes('--unshare-all'));
  assert.ok(launch.args.includes('--unshare-user'));
  assert.ok(launch.args.includes('--disable-userns'));
  assert.ok(launch.args.includes('--die-with-parent'));
  assert.ok(!launch.args.includes('--share-net'));
  const entries = mounts(launch.args);
  assert.deepEqual(entries.filter(m => [f.project, f.readonly, f.writable].includes(m.target)).map(m => [m.flag, m.target]), [
    ['--bind', f.project], ['--ro-bind', f.readonly], ['--bind', f.writable],
  ]);
  const hidden = entries.find(m => m.target === f.privateRoot)!;
  assert.equal(hidden.flag, '--ro-bind');
  assert.notEqual(hidden.source, f.privateRoot);
  assert.ok(entries.find(m => m.target === f.temporary)!.index > hidden.index);
  const parent = path.dirname(f.privateRoot);
  assert.ok(entries.some(m => m.target === parent && m.source === parent && m.flag === '--bind'), 'Appdata ancestors must be mountpoints to prevent rename');
  assert.ok(!entries.some(m => m.source === os.homedir() || m.source === '/' || m.source === '/run'));
});

test('Linux masks existing protected paths without opening their contents and keeps Git alternates denied', async t => {
  const f = await fixture(t), objects = path.join(f.project, '.git', 'objects');
  await mkdir(path.join(objects, 'info'), { recursive: true });
  const protectedFile = path.join(f.project, '.env');
  const alternates = path.join(objects, 'info', 'alternates');
  await writeFile(protectedFile, 'SAFE_FIXTURE=placeholder');
  await writeFile(alternates, '/nonexistent-public-fixture');
  const launch = await prepareLinuxSandbox({ roots: [{ path: f.project, access: 'write' }], temporary: f.temporary,
    privateRoot: f.privateRoot, internet: false, metadataReadRoots: [objects], deniedFiles: [alternates] }, '/usr/bin/git', []);
  t.after(launch.cleanup);
  const entries = mounts(launch.args), mask = entries.find(m => m.target === protectedFile)!;
  assert.equal(mask.flag, '--ro-bind');
  assert.equal((await stat(mask.source)).mode & 0o777, 0);
  assert.equal((await stat(mask.source)).size, 0);
  assert.ok(entries.filter(m => m.target === alternates).at(-1)!.index > entries.find(m => m.target === objects)!.index);
});

test('Linux refuses changed root identities and protected symlinks before launching', async t => {
  const f = await fixture(t);
  const alias = path.join(path.dirname(f.project), 'alias');
  await symlink(f.project, alias);
  await assert.rejects(prepareLinuxSandbox({ roots: [{ path: alias, access: 'write' }], temporary: f.temporary, internet: false }, '/bin/true', []), /identity changed/);
  await symlink('/does-not-exist', path.join(f.project, '.env'));
  await assert.rejects(prepareLinuxSandbox({ roots: [{ path: f.project, access: 'write' }], temporary: f.temporary, internet: false }, '/bin/true', []), /protected path is a symbolic link/);
});

test('Linux only shares network for explicit internet permission', async t => {
  const f = await fixture(t);
  const launch = await prepareLinuxSandbox({ roots: [{ path: f.project, access: 'read' }], temporary: f.temporary, internet: true }, '/bin/true', []);
  t.after(launch.cleanup);
  assert.ok(launch.args.includes('--share-net'));
});
