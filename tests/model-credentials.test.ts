import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isOpenRouterCredentialProfile, modelCredentialSource } from '../src/shared/model-credentials';
import { WorkspaceServices } from '../src/backend';
import { CredentialVault } from '../src/main/credentials';
import type { ModelConfig } from '../src/shared/types';

// All storage and values in these tests are synthetic and isolated in temporary folders.
const source: ModelConfig = { id: 'source-fixture', name: 'Source fixture', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture-source', apiKeyEnv: '', contextWindow: 32_000, maxOutputTokens: 2048, vision: false, enabled: true };
const target: ModelConfig = { ...source, id: 'target-fixture', kind: 'openai-responses', model: 'fixture-target', credentialModelId: source.id };

test('OpenRouter credential references accept only the official chat and Responses destination', () => {
  assert.equal(isOpenRouterCredentialProfile(source), true);
  assert.equal(isOpenRouterCredentialProfile(target), true);
  assert.equal(isOpenRouterCredentialProfile({ ...target, baseUrl: source.baseUrl + '/' }), true);
  for (const baseUrl of ['http://openrouter.ai/api/v1', 'https://openrouter.ai.evil.example/api/v1', 'https://user@openrouter.ai/api/v1', 'https://openrouter.ai:8443/api/v1', source.baseUrl + '//', source.baseUrl + '?fixture=1', source.baseUrl + '#fixture', 'https://openrouter.ai/api/v2'])
    assert.equal(isOpenRouterCredentialProfile({ ...source, baseUrl }), false);
  for (const kind of ['demo', 'anthropic'] as const) assert.equal(isOpenRouterCredentialProfile({ ...source, kind }), false);
  assert.equal(modelCredentialSource(source, []), source);
  assert.equal(modelCredentialSource(target, [source, target]), source);
});

test('missing, self, MCP, cyclic, multi-hop and foreign credential metadata is rejected', () => {
  for (const model of [{ ...target, credentialModelId: 'missing' }, { ...target, credentialModelId: target.id }, { ...target, credentialModelId: 'mcp:fixture:bearer' }, { ...target, credentialModelId: '' }, { ...target, id: 'mcp:fixture:bearer' }, { ...target, baseUrl: 'https://fixture.invalid/v1' }])
    assert.throws(() => modelCredentialSource(model, [source, target]));
  assert.throws(() => modelCredentialSource(target, [{ ...source, credentialModelId: 'third-fixture' }, target]));
  assert.throws(() => modelCredentialSource(target, [{ ...source, credentialModelId: target.id }, target]));
  assert.throws(() => modelCredentialSource(target, [{ ...source, baseUrl: 'https://fixture.invalid/v1' }, target]));
});

async function temporary(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-credential-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('saving and reopening persists references without duplicating credentials; source deletion and endpoint edits are blocked', async t => {
  const root = await temporary(t);
  const workspace = new WorkspaceServices(root, { approve: async () => true, emit: () => undefined }); await workspace.bootstrap();
  await workspace.saveModel(source); const saved = await workspace.saveModel(target);
  assert.equal(saved.credentialModelId, source.id);
  const reopened = new WorkspaceServices(root, { approve: async () => true, emit: () => undefined }); await reopened.bootstrap();
  assert.equal((await reopened.getModel(target.id)).credentialModelId, source.id);
  await assert.rejects(reopened.deleteModel(source.id), /предоставляет ключ/);
  await assert.rejects(reopened.saveModel({ ...source, baseUrl: 'https://fixture.invalid/v1' }), /официального API/);
  await assert.rejects(reopened.saveModel({ ...source, credentialModelId: target.id }), /один уровень/);
  await assert.rejects(reopened.saveModel({ ...target, credentialModelId: 'missing' }), /не найден/);
  assert.equal((await reopened.getModel(source.id)).baseUrl, source.baseUrl);
  await reopened.saveModel({ ...target, credentialModelId: undefined }); await reopened.deleteModel(source.id);
  assert.equal((await reopened.getModel(target.id)).credentialModelId, undefined);
});

test('vault uses the selected source while preserving an independent key for removal of the reference', async t => {
  const root = await temporary(t); let decryptions = 0;
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' as const, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => { decryptions++; return value.toString(); } };
  const vault = new CredentialVault(root, storage); await vault.initialize();
  assert.equal(vault.hasModel(target, [source, target]), false);
  await vault.save(source.id, 'artificial-source-placeholder');
  assert.equal(vault.has(target.id), false); assert.equal(vault.hasModel(target, [source, target]), true); assert.equal(decryptions, 0);
  assert.equal(await vault.resolve(target, [source, target]), 'artificial-source-placeholder'); assert.equal(decryptions, 1);
  assert.equal(vault.has(target.id), false, 'Resolving must not copy a vault record');
  await vault.save(target.id, 'artificial-independent-placeholder');
  assert.equal(await vault.resolve(target, [source, target]), 'artificial-source-placeholder'); assert.equal(decryptions, 2);
  assert.equal(await vault.resolve({ ...target, credentialModelId: undefined }, [source, target]), 'artificial-independent-placeholder'); assert.equal(decryptions, 3);
  const reopened = new CredentialVault(root, storage); await reopened.initialize();
  assert.equal(reopened.hasModel(target, [source, target]), true);
  assert.equal(await reopened.resolve(target, [source, target]), 'artificial-source-placeholder');
  assert.equal(await reopened.resolve({ ...target, credentialModelId: undefined }, [source, target]), 'artificial-independent-placeholder');
});

test('vault refuses edited foreign sources and targets before decrypting even an independently stored key', async t => {
  const root = await temporary(t); let decryptions = 0;
  const vault = new CredentialVault(root, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' as const, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => { decryptions++; return value.toString(); } });
  await vault.initialize(); await vault.save(source.id, 'artificial-source-placeholder'); await vault.save(target.id, 'artificial-independent-placeholder');
  const foreignSource = { ...source, baseUrl: 'https://fixture.invalid/v1' };
  assert.equal(vault.hasModel(target, [foreignSource, target]), false);
  await assert.rejects(vault.resolve(target, [foreignSource, target]), /официального API/);
  await assert.rejects(vault.resolve({ ...target, baseUrl: 'https://fixture.invalid/v1' }, [source, target]), /официального API/);
  await assert.rejects(vault.resolve(target, []), /не найден/);
  assert.equal(decryptions, 0);
});

test('Linux vault refuses basic_text and unknown backends without touching encrypted records', async t => {
  const root = await temporary(t);
  for (const backend of ['basic_text', 'unknown']) {
    let encrypted = false;
    const vault = new CredentialVault(root, {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend as 'basic_text' | 'unknown',
      encryptString: () => { encrypted = true; return Buffer.alloc(0); },
      decryptString: () => { throw new Error('Unsafe backend must never decrypt'); },
    }, 'linux');
    await vault.initialize();
    await assert.rejects(vault.save(source.id, 'artificial-placeholder'), /GNOME Keyring/);
    assert.equal(encrypted, false);
    assert.equal(vault.has(source.id), false);
  }
});
