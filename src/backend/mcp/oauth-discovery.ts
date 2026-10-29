import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, type FetchLike, type OAuthDiscoveryState } from '@modelcontextprotocol/client';

/** Some mounted OAuth servers publish OAuth metadata below the issuer path,
 * while their OIDC alias omits required OpenID fields. Keep SDK schema/issuer
 * validation; retry the separate OAuth document, never weaken OIDC validation. */
export async function discoverMcpOAuth(resource: URL, resourceMetadataUrl: URL | undefined, fetchFn: FetchLike): Promise<OAuthDiscoveryState> {
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(resource, { resourceMetadataUrl }, fetchFn);
  const issuer = resourceMetadata.authorization_servers?.[0] ?? resource.href;
  let authorizationServerMetadata: OAuthDiscoveryState['authorizationServerMetadata'];
  try { authorizationServerMetadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn }); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'ZodError') throw error; }
  const url = new URL(issuer), mountedPath = url.pathname.replace(/\/$/, '');
  if (!authorizationServerMetadata && mountedPath) {
    const standard = new URL('/.well-known/oauth-authorization-server' + mountedPath, url);
    const mounted = new URL(mountedPath + '/.well-known/oauth-authorization-server', url);
    authorizationServerMetadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: (input, init) => fetchFn((input instanceof Request ? input.url : String(input)) === standard.href ? mounted : input, init),
    });
  }
  return { authorizationServerUrl: issuer, authorizationServerMetadata, resourceMetadata,
    ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}) };
}
