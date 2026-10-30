import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, ModelConfig } from '../shared/types';
import { mcpCredentialId } from './mcp-credentials';
import { modelCredentialSource } from '../shared/model-credentials';

type SecureStorage = Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  & Partial<Pick<typeof safeStorage, 'getSelectedStorageBackend'>>;

// Only encrypted bytes are persisted; plaintext never crosses back to the renderer.
export class CredentialVault {
  private records: Record<string, string> = {};
  private updates: Promise<void> = Promise.resolve();
  private readonly file: string;
  constructor(dataDir: string, private readonly storage: SecureStorage = safeStorage, private readonly platform: NodeJS.Platform = process.platform) { this.file = path.join(dataDir, 'credentials.encrypted.json'); }
  private encryptionAvailable(): boolean {
    if (!this.storage.isEncryptionAvailable()) return false;
    if (this.platform !== 'linux') return true;
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.storage.getSelectedStorageBackend?.() ?? 'unknown');
  }
  async initialize() {
    try { this.records = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось открыть защищённое хранилище ключей.'); }
  }
  has(id: string) { return Boolean(this.records[id]); }
  hasModel(model: ModelConfig, models: readonly ModelConfig[] = []): boolean {
    try { const source = modelCredentialSource(model, models); return this.has(source.id); }
    catch { return false; }
  }
  async save(id: string, value: string) {
    if (!this.encryptionAvailable()) throw new Error('Защищённое хранилище ключей недоступно. На Linux включите GNOME Keyring или KWallet, либо укажите переменную окружения для ключа.');
    const encrypted = this.storage.encryptString(value).toString('base64');
    await this.mutate(records => ({ ...records, [id]: encrypted }));
  }
  async remove(id: string) { await this.mutate(records => { const next = { ...records }; delete next[id]; return next; }); }
  async removeMcp(id: string) {
    await this.mutate(records => Object.fromEntries(Object.entries(records).filter(([key]) => !key.startsWith(`mcp:${id}:`))));
  }
  async resolve(model: ModelConfig, models: readonly ModelConfig[] = []): Promise<string | undefined> {
    const source = modelCredentialSource(model, models);
    await this.updates;
    // The explicitly selected source is authoritative. A profile's own saved key
    // remains untouched and becomes active again when its reference is removed.
    return this.resolveRecord(source.id, source.apiKeyEnv);
  }
  async resolveMcp(server: McpServerConfig): Promise<{ bearerToken?: string; env: Record<string, string> }> {
    const env: Record<string, string> = {};
    for (const name of server.envNames) {
      const value = await this.resolveRecord(mcpCredentialId(server, `env:${name}`), name);
      if (value !== undefined) Object.defineProperty(env, name, { value, enumerable: true });
    }
    return { bearerToken: await this.resolveRecord(mcpCredentialId(server, 'bearer'), server.bearerTokenEnv), env };
  }
  async resolveMcpOAuth(server: McpServerConfig): Promise<string | undefined> {
    return this.resolveRecord(mcpCredentialId(server, 'oauth'), '');
  }
  private async resolveRecord(id: string, environmentName: string): Promise<string | undefined> {
    await this.updates;
    const encrypted = this.records[id];
    if (encrypted && this.encryptionAvailable()) return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
    return environmentName ? process.env[environmentName] : undefined;
  }
  private mutate(operation: (records: Record<string, string>) => Record<string, string>): Promise<void> {
    const pending = this.updates.then(async () => {
      const next = operation(this.records);
      await this.persist(next); this.records = next;
    });
    this.updates = pending.catch(() => undefined);
    return pending;
  }
  private async persist(records: Record<string, string>) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}
