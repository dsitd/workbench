export type McpTransport = 'stdio' | 'http';
export interface McpTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
}
/** Configuration and discovered metadata only. Credentials live in the vault. */
export interface McpServerConfig {
  id: string; name: string; transport: McpTransport; enabled: boolean;
  projectIds: string[]; command: string; args: string[]; url: string;
  envNames: string[]; bearerTokenEnv: string; enabledTools: string[];
  tools: McpTool[]; checkedAt?: string; hasToken?: boolean; hasOAuth?: boolean; secretNames?: string[];
}
export interface McpSecretsInput { bearerToken?: string; env?: Record<string, string> }
export interface McpConnectionReport {
  serverId: string; projectId: string; ok: boolean; message: string;
  tools: McpTool[]; checkedAt: string; latencyMs: number;
}
export interface McpConnectionStatus {
  serverId: string; projectId: string; connected: boolean; authorizing?: boolean;
}
