import type { AgentEvent, McpServerConfig, WorkbenchAPI } from '../shared/types';
import type { WorkspaceServices } from '../backend';
import { McpManager } from '../backend/mcp';
import type { CredentialVault } from './credentials';
import { mcpCredentialId, validateMcpSecrets } from './mcp-credentials';
import type { ApprovalBroker } from './approvals';
import { McpOAuth, type McpBrowserOptions } from './mcp-oauth';

type TestRun = { controller: AbortController; done: Promise<void> };

/** Main-process composition; renderer only sees metadata and write-only secret inputs. */
export function createMcpBridge(workspace: WorkspaceServices, vault: CredentialVault, broker: ApprovalBroker,
  emit: (event: AgentEvent) => void, isBusy: () => boolean, browser?: McpBrowserOptions) {
  const oauth = browser ? new McpOAuth(vault, browser) : undefined;
  const manager = new McpManager(workspace.store, { approve: (request, signal) => broker.request(request, signal), emit }, server => vault.resolveMcp(server), {
    authProvider: oauth ? (server, project, signal, interactive, secrets) => oauth.provider(server, project, signal, interactive, secrets) : undefined,
  });
  const tests = new Map<string, TestRun>();
  let mutation: Promise<void> | undefined;
  let shuttingDown = false;
  const decorate = (server: McpServerConfig): McpServerConfig => ({
    ...server, hasToken: vault.has(mcpCredentialId(server, 'bearer')),
    hasOAuth: vault.has(mcpCredentialId(server, 'oauth')),
    secretNames: server.envNames.filter(name => vault.has(mcpCredentialId(server, `env:${name}`))),
  });
  const idle = () => {
    if (shuttingDown || isBusy() || tests.size || mutation) throw new Error('Дождитесь завершения задач и проверок перед изменением MCP-подключений.');
  };
  const modify = async <T>(operation: () => Promise<T>): Promise<T> => {
    idle();
    let finish!: () => void;
    mutation = new Promise<void>(resolve => { finish = resolve; });
    try { return await operation(); }
    finally { mutation = undefined; finish(); }
  };
  const handlers: Pick<WorkbenchAPI, 'listMcpServers' | 'saveMcpServer' | 'deleteMcpServer' | 'testMcpServer' | 'getMcpStatus' | 'disconnectMcpServer'> = {
    listMcpServers: async () => (await manager.listServers()).map(decorate),
    saveMcpServer: (input, secrets) => modify(async () => {
      validateMcpSecrets(input, secrets);
      const server = await manager.saveServer(input);
      if (secrets?.bearerToken?.trim()) await vault.save(mcpCredentialId(server, 'bearer'), secrets.bearerToken.trim());
      for (const [name, value] of Object.entries(secrets?.env ?? {}))
        if (value) await vault.save(mcpCredentialId(server, `env:${name}`), value);
      emit({ type: 'refresh' });
      return decorate(server);
    }),
    deleteMcpServer: id => modify(async () => {
      const server = (await manager.listServers()).find(item => item.id === id);
      if (!server) throw new Error('MCP-сервер не найден.');
      await manager.deleteServer(id);
      await vault.removeMcp(id);
      oauth?.forget(id);
      emit({ type: 'refresh' });
    }),
    testMcpServer: async (id, projectId) => {
      idle();
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      tests.set(id, { controller, done });
      try {
        const report = await manager.discover(id, projectId, controller.signal);
        emit({ type: 'refresh' });
        return report;
      } finally { tests.delete(id); finish(); }
    },
    getMcpStatus: async (id, projectId) => ({ ...await manager.status(id, projectId), authorizing: oauth?.authorizing(id) ?? false }),
    disconnectMcpServer: async (id, projectId) => {
      tests.get(id)?.controller.abort();
      await manager.disconnect(id, projectId);
      emit({ type: 'refresh' });
    },
  };
  return {
    manager, handlers, decorate, isTesting: () => tests.size > 0 || Boolean(mutation),
    async disconnectProject(projectId: string) {
      for (const server of await manager.listServers()) await manager.disconnect(server.id, projectId);
    },
    async stop() {
      shuttingDown = true;
      const pending = [...tests.values()];
      for (const test of pending) test.controller.abort();
      await mutation;
      await manager.close();
      await Promise.all(pending.map(test => test.done));
    },
  };
}
