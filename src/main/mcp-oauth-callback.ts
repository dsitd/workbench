import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpFailure } from '../backend/mcp/safety';

/** Codes and state remain in the main process; nothing is logged or sent over IPC. */
export async function createOAuthCallback(signal: AbortSignal, preferredPort = 0) {
  const state = randomBytes(32).toString('hex');
  let resolve!: (params: URLSearchParams) => void, reject!: (error: Error) => void;
  const result = new Promise<URLSearchParams>((done, fail) => { resolve = done; reject = fail; });
  void result.catch(() => undefined);
  let origin = '', consumed = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const finish = (status: number, text: string) => { response.writeHead(status); response.end(text); };
    if (!origin || request.method !== 'GET' || request.headers.host !== new URL(origin).host || (request.url?.length ?? 0) > 16_384)
      return finish(400, 'Invalid authorization callback.');
    const url = new URL(request.url!, origin);
    if (url.origin !== origin || url.pathname !== '/oauth/callback') return finish(404, 'Not found.');
    const supplied = url.searchParams.get('state') ?? '';
    if (consumed || signal.aborted || url.searchParams.getAll('state').length !== 1 || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) return finish(400, 'Invalid or expired authorization state.');
    if (url.searchParams.has('error')) {
      consumed = true; finish(200, 'Вход отменён. Вернитесь в Workbench.'); reject(new McpFailure('Вход OAuth отклонён. Повторите подключение, когда будете готовы.')); return;
    }
    if (!url.searchParams.get('code') || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('iss').length > 1)
      return finish(400, 'Authorization code is missing or ambiguous.');
    consumed = true; finish(200, 'Ответ получен. Вернитесь в Workbench для завершения подключения.'); resolve(url.searchParams);
  });
  const close = () => { server.closeAllConnections(); server.close(); };
  const abort = () => { reject(new McpFailure('Вход OAuth отменён или истекло время ожидания.')); close(); };
  try {
    if (signal.aborted) throw new McpFailure('Вход OAuth отменён.');
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(preferredPort, '127.0.0.1', () => { server.removeListener('error', fail); done(); });
    });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    server.on('error', () => abort());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return { url: origin + '/oauth/callback', state, result, close: () => { signal.removeEventListener('abort', abort); close(); } };
  } catch (error) { close(); throw error; }
}
