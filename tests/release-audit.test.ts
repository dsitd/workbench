import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const modulePath = '../scripts/release-audit.mjs';
const audit = import(modulePath);
const evidence = () => ({ version: '0.5.1', sourceCanonicalSha256: 'a'.repeat(64),
  canonicalCheck: { command: 'npm run check', exitCode: 0, typecheck: true, build: true, unitTests: { total: 12, passed: 10, failed: 0, skipped: 2 } },
  packagedAcceptance: { asarSha256: 'b'.repeat(64), reports: [
    { name: 'desktop', command: 'node scripts/smoke.mjs', exitCode: 0, checks: 23, paidRequests: 0 },
    { name: 'features', command: 'node scripts/features-smoke.mjs', exitCode: 0, checks: 22, paidRequests: 0 },
    { name: 'chats', command: 'node scripts/chat-management-smoke.mjs', exitCode: 0, checks: 11, paidRequests: 0 },
    { name: 'modelsCost', command: 'node scripts/models-cost-smoke.mjs', exitCode: 0, checks: 12, paidRequests: 0 },
  ] } });

test('release source allowlist includes public code and excludes private roots, dotfiles and traversal', async () => {
  const { publicSourcePath } = await audit;
  for (const name of ['package.json', 'docs/context-caching.md', 'src/main/credentials.ts', 'scripts/release-audit.mjs', 'tests/release-audit.test.ts']) assert.equal(publicSourcePath(name), true);
  for (const name of ['.env', 'src/.env.ts', '.cache/probe.mjs', 'src/profile/private.ts', 'src/agent/../../.env', '/src/main/index.ts', 'docs/private-notes.md', 'src/vault/data.ts', 'probe.mjs']) assert.equal(publicSourcePath(name), false);
});

test('ASAR allowlist rejects profile files and symbolic links before file extraction', async () => {
  const { publicAsarPath, validateArchiveEntries } = await audit;
  for (const name of ['package.json', 'dist/main/index.js.map', 'node_modules/react/index.js']) assert.equal(publicAsarPath(name), true);
  for (const name of ['.env', 'dist/.env.production', 'node_modules/sample/.npmrc', 'profiles/data.json', 'node_modules/sample/../private']) {
    assert.equal(publicAsarPath(name), false);
  }
  assert.throws(() => validateArchiveEntries([{ path: 'dist/main/index.js', link: '../../profiles/private' }]), /symbolic link/);
  assert.throws(() => validateArchiveEntries([{ path: '.workbench/state.json' }]), /allowlist/);
});

test('aggregate release facts accept complete counts and reject failed, paid or private report fields', async () => {
  const { validateEvidence } = await audit;
  assert.deepEqual(validateEvidence(evidence(), '0.5.1'), evidence());
  const failed = evidence(); failed.canonicalCheck.unitTests.failed = 1;
  assert.throws(() => validateEvidence(failed, '0.5.1'), /counts/);
  const missing = evidence(); missing.packagedAcceptance.reports.pop();
  assert.throws(() => validateEvidence(missing, '0.5.1'), /four packaged/);
  const paid = evidence(); paid.packagedAcceptance.reports[0].paidRequests = 1;
  assert.throws(() => validateEvidence(paid, '0.5.1'), /unpaid/);
  assert.throws(() => validateEvidence({ ...evidence(), nativeExistingProfile: {} }, '0.5.1'), /Unexpected/);
  assert.throws(() => validateEvidence(evidence(), '0.5.0'), /version/);
});

test('source digest changes when an included source hash changes', async () => {
  const { sourceDigest } = await audit;
  const manifest = [{ path: 'src/main/index.ts', sha256: 'a'.repeat(64) }];
  assert.equal(sourceDigest(manifest), sourceDigest(structuredClone(manifest)));
  assert.notEqual(sourceDigest(manifest), sourceDigest([{ ...manifest[0], sha256: 'b'.repeat(64) }]));
});

test('public manifest hashes only allowed fixture files and never enters hidden or profile directories', async t => {
  const { collectPublicSources } = await audit;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-public-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['src', 'scripts', 'tests', 'src/.cache', 'src/profile']) await mkdir(path.join(directory, name), { recursive: true });
  await writeFile(path.join(directory, 'src/index.ts'), 'export const fixture = 1;');
  await writeFile(path.join(directory, 'src/.cache/excluded.ts'), 'excluded fixture');
  await writeFile(path.join(directory, 'src/profile/excluded.ts'), 'excluded fixture');
  const manifest = await collectPublicSources(directory);
  assert.deepEqual(manifest.map((entry: { path: string }) => entry.path), ['src/index.ts']);
  await symlink(path.join(directory, 'src/index.ts'), path.join(directory, 'src/link.ts'));
  await assert.rejects(collectPublicSources(directory), /symbolic link/);
});
