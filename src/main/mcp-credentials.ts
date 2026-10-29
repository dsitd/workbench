import { createHash } from 'node:crypto';
import type { McpSecretsInput, McpServerConfig } from '../shared/types';

/** A saved secret cannot move to a different endpoint or executable by editing a profile. */
export function mcpCredentialId(server: McpServerConfig, slot: string): string {
  const destination = server.transport === 'http' ? [server.transport, server.url] : [server.transport, server.command, server.args];
  const binding = createHash('sha256').update(JSON.stringify(destination)).digest('hex').slice(0, 24);
  return `mcp:${server.id}:${binding}:${slot}`;
}

export function validateMcpSecrets(input: McpServerConfig, secrets?: McpSecretsInput): void {
  if (!secrets) return;
  if (typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error('Некорректные поля доступа MCP.');
  if (secrets.bearerToken !== undefined && (typeof secrets.bearerToken !== 'string' || secrets.bearerToken.length > 8192 || /[\r\n]/.test(secrets.bearerToken)))
    throw new Error('Некорректный размер токена MCP.');
  if (secrets.env !== undefined && (!secrets.env || typeof secrets.env !== 'object' || Array.isArray(secrets.env)))
    throw new Error('Некорректные поля переменных MCP.');
  const entries = Object.entries(secrets.env ?? {});
  if (entries.length > 32) throw new Error('Для MCP поддерживается до 32 переменных.');
  for (const [name, value] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || !Array.isArray(input.envNames) || !input.envNames.includes(name))
      throw new Error('Сначала добавьте имя переменной в настройки MCP.');
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Некорректный размер переменной MCP.');
  }
}
