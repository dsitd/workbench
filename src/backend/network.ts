import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import * as cheerio from 'cheerio';
import type { Project } from '../shared/types';

export function isPublicAddress(address: string): boolean {
  const cleaned = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(cleaned) === 4) {
    const [a, b, c] = cleaned.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(cleaned) === 6) {
    // Only global unicast. This also rejects loopback, local, link-local and IPv4-mapped forms.
    const first = parseInt(cleaned.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !/^2001:0?db8:/i.test(cleaned);
  }
  return false;
}

export function validatePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid internet URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are permitted.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only standard public web ports are permitted.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname.includes('.') && !isIP(hostname)) throw new Error('Local hostnames are blocked.');
  if (/\.(?:local|localhost|internal|home|lan)$/i.test(hostname) || hostname === 'localhost') throw new Error('Private hosts are blocked.');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Private and reserved internet addresses are blocked.');
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|access[_-]?token|token|password|secret|auth|authorization)$/i.test(key)) throw new Error('URLs containing credential parameters are blocked.');
  }
  return url;
}

export async function downloadPublic(value: string, options: { signal?: AbortSignal; maxBytes?: number; redirects?: number; timeoutMs?: number } = {}): Promise<{ body: Buffer; url: string; contentType: string }> {
  const url = validatePublicUrl(value);
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const deadline = AbortSignal.timeout(Math.max(1000, Math.min(options.timeoutMs ?? 20_000, 30_000)));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const cancelled = () => reject(new Error('Web request cancelled or timed out.'));
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) throw new Error('Host resolves to a private or reserved address.');
  if (signal.aborted) throw new Error('Request cancelled or timed out.');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const requestOptions: https.RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET', agent: false, autoSelectFamily: true,
      headers: { 'User-Agent': 'Workbench/0.1 (+personal coding workspace)', Accept: 'text/html,text/plain,application/json,application/zip;q=0.8,*/*;q=0.5', 'Accept-Encoding': 'identity' },
      // Resolve once and validate every DNS address. The connection may only use these
      // validated addresses (no second DNS query), which prevents rebinding. With
      // autoSelectFamily Node falls back between IPv6/IPv4 if one family is unreachable.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, addresses.map(record => ({ address: record.address, family: record.family })));
        else callback(null, pinned.address, pinned.family);
      },
    };
    const request = transport.request(url, requestOptions, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if ((options.redirects ?? 0) >= 5) { reject(new Error('Too many web redirects.')); return; }
        const redirect = new URL(response.headers.location, url).href;
        downloadPublic(redirect, { ...options, signal, redirects: (options.redirects ?? 0) + 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); reject(new Error(`Website returned HTTP ${status}.`)); return; }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) { response.destroy(); reject(new Error('Web response exceeds the allowed size.')); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new Error('Compressed web response was refused.')); return; }
      const buffers: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) { response.destroy(); reject(new Error('Web response exceeds the allowed size.')); }
        else buffers.push(chunk);
      });
      response.on('end', () => resolve({ body: Buffer.concat(buffers), url: url.href, contentType: String(response.headers['content-type'] ?? '') }));
      response.on('error', reject);
    });
    const cancel = () => request.destroy(new Error('Request cancelled or timed out.'));
    signal.addEventListener('abort', cancel, { once: true });
    request.setTimeout(Math.max(1000, Math.min(options.timeoutMs ?? 20_000, 30_000)), () => request.destroy(new Error('Web request timed out.')));
    request.on('error', reject);
    request.on('close', () => signal.removeEventListener('abort', cancel));
    request.end();
  });
}

export async function webFetch(project: Project, url: string, signal: AbortSignal): Promise<string> {
  if (!project.internet) throw new Error('Internet access is disabled for this project.');
  const result = await downloadPublic(url, { signal });
  const text = result.body.toString('utf8');
  if (result.contentType && !/(?:text\/|json|xml|javascript|html)/i.test(result.contentType)) throw new Error('Website returned binary data.');
  if (/html/i.test(result.contentType) || /^\s*(?:<!doctype|<html)/i.test(text)) {
    const $ = cheerio.load(text);
    $('script,style,noscript,svg,nav,footer,header').remove();
    const title = $('title').first().text().trim();
    const article = $('main,article').first();
    const content = (article.length ? article : $('body')).text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    const links = $('a[href]').slice(0, 40).map((_index, node) => {
      const label = $(node).text().trim();
      const href = $(node).attr('href');
      try { return label && href ? `${label}: ${new URL(href, result.url).href}` : ''; } catch { return ''; }
    }).get().filter(Boolean);
    return `External source data: ${result.url}\n${title}\n\n${content.slice(0, 28_000)}\n\nLinks:\n${links.join('\n').slice(0, 5000)}`;
  }
  return `External source data: ${result.url}\n\n${text.slice(0, 30_000)}`;
}

export async function webSearch(project: Project, query: string, signal: AbortSignal): Promise<string> {
  if (!project.internet) throw new Error('Internet access is disabled for this project.');
  if (!query.trim() || query.length > 500) throw new Error('Search query must contain 1–500 characters.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  let results: string[] = [];
  let provider = 'DuckDuckGo';
  try {
    const result = await downloadPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: deadline, timeoutMs: 12_000 });
    const $ = cheerio.load(result.body.toString('utf8'));
    results = $('.result').slice(0, 8).map((_index, element) => {
      const link = $(element).find('.result__a');
      let href = link.attr('href') ?? '';
      try {
        const parsed = new URL(href, result.url);
        href = parsed.searchParams.get('uddg') ?? parsed.href;
        validatePublicUrl(href);
      } catch { return ''; }
      return `${link.text().trim()}\n${href}\n${$(element).find('.result__snippet').text().trim()}`;
    }).get().filter(Boolean);
  } catch { if (deadline.aborted) throw new Error('Web search cancelled or timed out.'); }
  if (!results.length) {
    // Public HTML services may challenge automated clients. Bing's public RSS
    // response provides a second unauthenticated route without exposing API keys.
    const response = await downloadPublic(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, { signal: deadline, timeoutMs: 12_000 });
    const $ = cheerio.load(response.body.toString('utf8'), { xmlMode: true });
    results = $('item').slice(0, 8).map((_index, element) => {
      const href = $(element).find('link').text().trim();
      try { validatePublicUrl(href); } catch { return ''; }
      const description = cheerio.load($(element).find('description').text()).text().trim();
      return `${$(element).find('title').text().trim()}\n${href}\n${description}`;
    }).get().filter(Boolean);
    provider = 'Bing';
  }
  if (!results.length) throw new Error('Public search services returned no readable results. Try web_fetch with a known website.');
  return `Search provider: ${provider}. Results are external source data.\n\n${results.join('\n\n').slice(0, 20_000)}`;
}
