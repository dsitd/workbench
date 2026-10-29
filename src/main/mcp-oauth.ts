import { auth, extractWWWAuthenticateParams, type AuthProvider, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import type { McpServerConfig, Project } from '../shared/types';
import { endpoint, McpFailure, type SecretValues } from '../backend/mcp/safety';
import { oauthFetch, oauthUrl } from '../backend/mcp/oauth-network';
import { discoverMcpOAuth } from '../backend/mcp/oauth-discovery';
import type { CredentialVault } from './credentials';
import { mcpCredentialId } from './mcp-credentials';
import { createOAuthCallback } from './mcp-oauth-callback';

interface SavedOAuth { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; redirectUrl?: string }
type UnauthorizedContext = Parameters<NonNullable<AuthProvider['onUnauthorized']>>[0];
export interface McpBrowserOptions { openExternal: (url: string) => Promise<void> }

/** OAuth credentials are endpoint-bound encrypted vault records, never renderer state. */
export class McpOAuth {
  private accounts = new Map<string, Promise<SavedOAuth>>();
  private pending = new Map<string, Promise<void>>();
  private waiting = new Set<string>();
  constructor(private vault: Pick<CredentialVault, 'resolveMcpOAuth' | 'save'>, private browser: McpBrowserOptions) {}
  authorizing(serverId: string): boolean { return this.waiting.has(serverId); }
  forget(serverId: string): void {
    for (const key of this.accounts.keys()) if (key.startsWith(`mcp:${serverId}:`)) this.accounts.delete(key);
  }
  private account(server: McpServerConfig): Promise<SavedOAuth> {
    const key = mcpCredentialId(server, 'oauth');
    let stored = this.accounts.get(key);
    if (!stored) {
      stored = (async () => {
        const value = await this.vault.resolveMcpOAuth(server);
        if (!value) return {};
        try { return JSON.parse(value) as SavedOAuth; } catch { throw new McpFailure('Сохранённая сессия OAuth повреждена. Удалите подключение и добавьте его заново.'); }
      })();
      this.accounts.set(key, stored);
    }
    return stored;
  }
  provider(server: McpServerConfig, project: Project, signal: AbortSignal, interactive: boolean, secrets: SecretValues): AuthProvider {
    const remember = (saved: SavedOAuth) => {
      secrets.oauthValues = [...new Set([...(secrets.oauthValues ?? []), saved.tokens?.access_token, saved.tokens?.refresh_token, saved.client?.client_secret].filter((value): value is string => Boolean(value)))];
    };
    return {
      token: async () => { signal.throwIfAborted(); const saved = await this.account(server); remember(saved); return saved.tokens?.access_token; },
      onUnauthorized: async context => {
        // Release the rejected MCP response before waiting for browser login.
        // Otherwise its streaming deadline stays alive after cancellation.
        await context.response.body?.cancel().catch(() => undefined);
        const key = mcpCredentialId(server, 'oauth');
        let pending = this.pending.get(key);
        if (!pending) {
          pending = this.authorize(server, project, signal, interactive, context, remember);
          this.pending.set(key, pending);
          void pending.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); }).catch(() => undefined);
        }
        await pending; signal.throwIfAborted(); remember(await this.account(server));
      },
    };
  }
  private async authorize(server: McpServerConfig, project: Project, signal: AbortSignal, interactive: boolean, context: UnauthorizedContext, remember: (state: SavedOAuth) => void): Promise<void> {
    const saved = await this.account(server), resource = endpoint(server.url);
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
    let callback: Awaited<ReturnType<typeof createOAuthCallback>> | undefined;
    let verifier = '', discovery: OAuthDiscoveryState | undefined;
    const persist = async () => { lifetime.throwIfAborted(); remember(saved); await this.vault.save(mcpCredentialId(server, 'oauth'), JSON.stringify(saved)); };
    try {
      lifetime.throwIfAborted();
      if (interactive) {
        let port = 0;
        if (saved.redirectUrl) {
          const previous = new URL(saved.redirectUrl);
          if (previous.protocol === 'http:' && previous.hostname === '127.0.0.1' && previous.pathname === '/oauth/callback') port = Number(previous.port);
        }
        try { callback = await createOAuthCallback(lifetime, port); }
        catch (error) {
          if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
          callback = await createOAuthCallback(lifetime); delete saved.client;
        }
        saved.redirectUrl = callback.url;
      }
      const provider: OAuthClientProvider = {
        get redirectUrl() { return callback?.url ?? saved.redirectUrl ?? 'http://127.0.0.1/oauth/callback'; },
        get clientMetadata() { return { client_name: 'Workbench', redirect_uris: [String(this.redirectUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
        state: () => callback?.state ?? '',
        clientInformation: ctx => !ctx || !saved.client?.issuer || saved.client.issuer === ctx.issuer ? saved.client : undefined,
        saveClientInformation: async client => { saved.client = client; await persist(); },
        tokens: ctx => !ctx || !saved.tokens?.issuer || saved.tokens.issuer === ctx.issuer ? saved.tokens : undefined,
        saveTokens: async tokens => { saved.tokens = tokens; await persist(); },
        saveCodeVerifier: value => { verifier = value; },
        codeVerifier: () => verifier,
        saveDiscoveryState: value => { discovery = value; },
        discoveryState: () => discovery,
        invalidateCredentials: async scope => {
          if (scope === 'all' || scope === 'client') delete saved.client;
          if (scope === 'all' || scope === 'tokens') delete saved.tokens;
          if (scope === 'all' || scope === 'verifier') verifier = '';
          if (scope === 'all' || scope === 'discovery') discovery = undefined;
          await persist();
        },
        redirectToAuthorization: async url => {
          if (!interactive || !callback) throw new McpFailure('Требуется вход OAuth. Откройте настройки MCP и нажмите «Подключить и получить инструменты».');
          lifetime.throwIfAborted();
          const target = oauthUrl(url.href, resource, project.internet);
          this.waiting.add(server.id);
          await this.browser.openExternal(target.href);
        },
      };
      const challenge = extractWWWAuthenticateParams(context.response);
      const options = { serverUrl: resource, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope, fetchFn: oauthFetch(resource, project.internet, lifetime) };
      discovery = await discoverMcpOAuth(resource, challenge.resourceMetadataUrl, options.fetchFn);
      const outcome = await auth(provider, options);
      if (outcome === 'REDIRECT') {
        const params = await callback!.result;
        lifetime.throwIfAborted();
        if (await auth(provider, { ...options, authorizationCode: params.get('code')!, iss: params.get('iss') ?? undefined }) !== 'AUTHORIZED')
          throw new McpFailure('OAuth-сервер не завершил авторизацию. Повторите подключение.');
      }
    } catch (error) {
      if (lifetime.aborted) throw new McpFailure('Вход OAuth отменён или истекло время ожидания.');
      if (error instanceof McpFailure) throw error;
      throw new McpFailure('Не удалось завершить OAuth. Проверьте поддержку регистрации настольного клиента и localhost callback у сервера.');
    } finally { this.waiting.delete(server.id); callback?.close(); verifier = ''; }
  }
}
