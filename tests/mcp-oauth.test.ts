import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceServices } from '../src/backend';
import { ApprovalBroker } from '../src/main/approvals';
import { createMcpBridge } from '../src/main/mcp';
import { mcpCredentialId } from '../src/main/mcp-credentials';
import type { CredentialVault } from '../src/main/credentials';
import type { McpServerConfig } from '../src/shared/types';
import { createOAuthCallback } from '../src/main/mcp-oauth-callback';
import { oauthUrl } from '../src/backend/mcp/oauth-network';
import { discoverMcpOAuth } from '../src/backend/mcp/oauth-discovery';

// All credentials and authorization responses in this fixture are artificial.
class TestVault {
  records = new Map<string, string>();
  has(id: string) { return this.records.has(id); }
  async save(id: string, value: string) { this.records.set(id, value); }
  async resolveMcp() { return { env: {} }; }
  async resolveMcpOAuth(server: McpServerConfig) { return this.records.get(mcpCredentialId(server, 'oauth')); }
}
async function fixture(t: TestContext, browser?: (url: URL) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workbench-oauth-')));
  const folder = path.join(root, 'project'); await mkdir(folder);
  const workspace = new WorkspaceServices(path.join(root, 'data'), { approve: async () => false, emit: () => {} });
  const project = await workspace.createProject({ name: 'OAuth fixture', folders: [{ path: folder, access: 'write' }], internet: false });
  const vault = new TestVault();
  let origin = '', challenge = '', opened = 0, redeemed = 0, refreshed = 0, access = 'fixture-access';
  const http = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, origin);
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (url.pathname === '/.well-known/oauth-protected-resource') return json({ resource: origin + '/mcp', authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
    let body = ''; for await (const part of request) body += part;
    if (url.pathname === '/register') return json({ ...JSON.parse(body), client_id: 'fixture-client' }, 201);
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body);
      assert.equal(params.get('resource'), origin + '/mcp');
      if (params.get('grant_type') === 'authorization_code') {
        assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), challenge);
        assert.equal(params.get('code'), 'fixture-code'); redeemed++;
      } else { assert.equal(params.get('grant_type'), 'refresh_token'); assert.equal(params.get('refresh_token'), 'fixture-refresh'); refreshed++; }
      return json({ access_token: access, refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname !== '/mcp') return json({}, 404);
    if (request.headers.authorization !== `Bearer ${access}`) {
      response.setHeader('www-authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
      return json({}, 401);
    }
    if (request.method !== 'POST') return json({}, 405);
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object' } }] } : {};
    json({ jsonrpc: '2.0', id: message.id, result });
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const openExternal = async (value: string) => {
    opened++; const url = new URL(value); challenge = url.searchParams.get('code_challenge')!;
    assert.equal(url.origin, origin); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    if (browser) return browser(url);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', origin);
    const result = await fetch(callback); assert.equal(result.status, 200);
  };
  const bridge = createMcpBridge(workspace, vault as unknown as CredentialVault, new ApprovalBroker(() => {}), () => {}, () => false, { openExternal });
  const config: McpServerConfig = { id: 'oauth-fixture', name: 'OAuth fixture', transport: 'http', enabled: true, projectIds: [project.id], command: '', args: [], url: origin + '/mcp', envNames: [], bearerTokenEnv: '', enabledTools: [], tools: [] };
  const saved = await bridge.handlers.saveMcpServer(config);
  t.after(async () => { await bridge.stop(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { bridge, vault, saved, project, stats: () => ({ opened, redeemed, refreshed }), expire: () => { access = 'fixture-renewed-access'; } };
}

test('MCP connection opens browser on OAuth challenge, validates PKCE callback and discovers tools', async t => {
  const f = await fixture(t);
  const report = await f.bridge.handlers.testMcpServer(f.saved.id, f.project.id);
  assert.equal(report.ok, true, report.message);
  assert.deepEqual(report.tools.map(tool => tool.name), ['lookup']);
  assert.deepEqual(f.stats(), { opened: 1, redeemed: 1, refreshed: 0 });
  await f.bridge.handlers.disconnectMcpServer(f.saved.id);
  assert.equal((await f.bridge.handlers.testMcpServer(f.saved.id, f.project.id)).ok, true);
  assert.equal(f.stats().opened, 1, 'saved authorization must avoid another browser login');
  const visible = JSON.stringify(await f.bridge.handlers.listMcpServers());
  assert.doesNotMatch(visible, /fixture-access|fixture-refresh|fixture-code/);
  f.expire();
  await f.bridge.handlers.disconnectMcpServer(f.saved.id);
  assert.equal((await f.bridge.handlers.testMcpServer(f.saved.id, f.project.id)).ok, true);
  assert.deepEqual(f.stats(), { opened: 1, redeemed: 1, refreshed: 1 });
});

test('incorrect state cannot redeem a code; a valid callback can still finish the same login', async t => {
  const f = await fixture(t, async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('iss', url.origin);
    callback.searchParams.set('state', 'я'.repeat(64));
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    assert.equal((await fetch(callback)).status, 200);
  });
  assert.equal((await f.bridge.handlers.testMcpServer(f.saved.id, f.project.id)).ok, true);
  assert.equal(f.stats().redeemed, 1);
});

test('authorization issuer mismatch fails before token redemption and hides provider response data', async t => {
  const f = await fixture(t, async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('iss', 'https://wrong.example.test');
    await fetch(callback);
  });
  const report = await f.bridge.handlers.testMcpServer(f.saved.id, f.project.id);
  assert.equal(report.ok, false); assert.equal(f.stats().redeemed, 0);
  assert.doesNotMatch(report.message, /fixture-code|wrong\.example/);
});

test('disconnect cancels browser authorization promptly and closes its loopback callback', async t => {
  let announce!: () => void;
  const opened = new Promise<void>(resolve => { announce = resolve; });
  let callback = '';
  const f = await fixture(t, async url => { callback = url.searchParams.get('redirect_uri')!; announce(); });
  const pending = f.bridge.handlers.testMcpServer(f.saved.id, f.project.id);
  await opened;
  assert.equal((await f.bridge.handlers.getMcpStatus(f.saved.id, f.project.id)).authorizing, true);
  await f.bridge.handlers.disconnectMcpServer(f.saved.id);
  assert.equal((await pending).ok, false);
  assert.equal((await f.bridge.handlers.getMcpStatus(f.saved.id, f.project.id)).authorizing, false);
  await assert.rejects(fetch(callback));
  assert.equal(f.stats().redeemed, 0);
});

test('loopback callback is one-use and OAuth discovery cannot reach private endpoints from a public server', async () => {
  const controller = new AbortController();
  const callback = await createOAuthCallback(controller.signal);
  try {
    const url = new URL(callback.url); url.searchParams.set('state', callback.state); url.searchParams.set('code', 'fixture-code');
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 400);
    assert.equal((await callback.result).get('code'), 'fixture-code');
  } finally { callback.close(); }
  const publicResource = new URL('https://mcp.example.com/mcp');
  for (const target of ['http://127.0.0.1:8000/token', 'https://192.168.1.5/token', 'https://auth.local/token', 'https://user:pass@auth.example.com/token'])
    assert.throws(() => oauthUrl(target, publicResource, true));
  assert.throws(() => oauthUrl('https://auth.example.com/token', new URL('http://127.0.0.1:8000/mcp'), false));
});

test('mounted ONKRON-style OAuth metadata works without pretending an incomplete document is valid OpenID', async () => {
  const issuer = 'https://mcp.example.com/mcp', resource = new URL(issuer + '/');
  const metadata = { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
    registration_endpoint: issuer + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requested.push(url.pathname);
    const data = url.pathname === '/mcp/.well-known/oauth-protected-resource' ? { resource: resource.href, authorization_servers: [issuer] }
      : ['/mcp/.well-known/openid-configuration', '/mcp/.well-known/oauth-authorization-server'].includes(url.pathname) ? metadata : undefined;
    return new Response(JSON.stringify(data ?? {}), { status: data ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const discovered = await discoverMcpOAuth(resource, new URL(issuer + '/.well-known/oauth-protected-resource'), fetcher);
  assert.equal(discovered.authorizationServerMetadata?.issuer, issuer);
  assert.ok(requested.includes('/mcp/.well-known/oauth-authorization-server'));
  metadata.issuer = 'https://wrong.example.com';
  await assert.rejects(discoverMcpOAuth(resource, new URL(issuer + '/.well-known/oauth-protected-resource'), fetcher));
});
