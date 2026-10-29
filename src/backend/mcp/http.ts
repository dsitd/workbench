import type { FetchLike } from '@modelcontextprotocol/client';
import { endpoint, McpFailure, MESSAGE_LIMIT } from './safety';

/** Authentication stays on the explicitly configured origin, including SSE and DELETE. */
export function originFetch(url: URL, lifetime: AbortSignal, fetcher: FetchLike = fetch, timeoutMs = 30_000): FetchLike {
  return async (input, init = {}) => {
    const target = endpoint(input instanceof Request ? input.url : String(input));
    if (target.origin !== url.origin || target.pathname !== url.pathname) throw new McpFailure('MCP attempted to leave its configured endpoint.');
    const controller = new AbortController();
    const signals = [lifetime, controller.signal, init.signal, input instanceof Request ? input.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cleanup = () => { clearTimeout(timer); };
    try {
      const response = await fetcher(input, { ...init, credentials: 'omit', redirect: 'error', signal });
      if (response.status >= 300 && response.status < 400) throw new McpFailure('MCP endpoint redirects are disabled.');
      if (response.url && new URL(response.url).origin !== url.origin) throw new McpFailure('MCP response changed origin.');
      const length = Number(response.headers.get('content-length'));
      if (length > MESSAGE_LIMIT) throw new McpFailure('MCP response exceeds the supported size.');
      if (!response.body) { cleanup(); return response; }
      reader = response.body.getReader();
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            const next = await reader!.read();
            if (next.done) { cleanup(); stream.close(); return; }
            bytes += next.value.length;
            if (bytes > MESSAGE_LIMIT) throw new McpFailure('MCP response exceeds the supported size.');
            stream.enqueue(next.value);
          } catch (error) {
            cleanup(); controller.abort(); await reader?.cancel().catch(() => undefined); stream.error(error);
          }
        },
        async cancel() { cleanup(); controller.abort(); await reader?.cancel().catch(() => undefined); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      cleanup(); controller.abort(); await reader?.cancel().catch(() => undefined);
      throw error;
    }
  };
}
