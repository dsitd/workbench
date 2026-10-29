import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/client';
import { isPublicAddress, validatePublicUrl } from '../network';
import { loopback, McpFailure } from './safety';

export function oauthUrl(value: string, resource: URL, internet: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new McpFailure('OAuth URL содержит недопустимые поля.');
  if (loopback(resource) && loopback(url) && ['http:', 'https:'].includes(url.protocol)) return url;
  if (!internet || url.protocol !== 'https:') throw new McpFailure('Для удалённого OAuth-сервера требуется HTTPS и доступ к интернету.');
  try { return validatePublicUrl(url.href); } catch { throw new McpFailure('OAuth-сервер должен использовать публичный HTTPS-адрес.'); }
}

/** Separate from MCP resource fetch: metadata/token endpoints may use another origin.
 * DNS is validated and pinned; redirects never forward client credentials. */
export function oauthFetch(resource: URL, internet: boolean, lifetime: AbortSignal): FetchLike {
  return async (input, init = {}) => {
    const url = oauthUrl(input instanceof Request ? input.url : String(input), resource, internet);
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      const abort = () => reject(new McpFailure('Вход OAuth отменён или истекло время ожидания.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); return; }
      lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (!addresses.length || !loopback(url) && addresses.some(item => !isPublicAddress(item.address))) throw new McpFailure('OAuth-сервер разрешается в закрытый сетевой адрес.');
    if (loopback(url) && addresses.some(item => item.address !== '::1' && !/^127\./.test(item.address))) throw new McpFailure('Локальный OAuth-сервер должен разрешаться в loopback-адрес.');
    signal.throwIfAborted();
    const method = init.method ?? 'GET';
    if (!['GET', 'POST'].includes(method)) throw new McpFailure('Недопустимый метод запроса OAuth.');
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof URLSearchParams)) throw new McpFailure('Недопустимое тело запроса OAuth.');
    const body = init.body == null ? undefined : String(init.body);
    if (body && Buffer.byteLength(body) > 64_000) throw new McpFailure('Запрос OAuth слишком большой.');
    const headers = new Headers(init.headers); headers.delete('cookie'); headers.set('accept-encoding', 'identity');
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers: Object.fromEntries(headers), agent: false,
        lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      }, response => {
        const chunks: Buffer[] = []; let size = 0;
        if (response.statusCode! >= 300 && response.statusCode! < 400 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new McpFailure('Перенаправление или сжатый ответ OAuth не поддерживается.')); return;
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256_000) { response.destroy(); reject(new McpFailure('Ответ OAuth слишком большой.')); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && key !== 'set-cookie') responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          const status = response.statusCode ?? 500;
          let payload: BodyInit | null = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          if (status >= 400) {
            // The SDK may log refresh failures. Never pass server error prose that could echo credentials.
            let error = 'server_error';
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (['invalid_client', 'unauthorized_client', 'invalid_grant', 'invalid_request', 'invalid_scope', 'access_denied', 'unsupported_grant_type'].includes(parsed.error)) error = parsed.error;
            } catch { /* Keep the static error. */ }
            payload = JSON.stringify({ error, error_description: 'OAuth request failed.' });
            responseHeaders.set('content-type', 'application/json'); responseHeaders.delete('content-length');
          }
          resolve(new Response(payload, { status, headers: responseHeaders }));
        });
        response.on('error', () => reject(new McpFailure('Не удалось получить ответ OAuth-сервера.')));
      });
      const abort = () => request.destroy(new Error('OAuth cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      request.on('close', () => signal.removeEventListener('abort', abort));
      request.on('error', () => reject(new McpFailure(signal.aborted ? 'Вход OAuth отменён или истекло время ожидания.' : 'Не удалось подключиться к OAuth-серверу.')));
      if (signal.aborted) abort(); else request.end(body);
    });
  };
}
