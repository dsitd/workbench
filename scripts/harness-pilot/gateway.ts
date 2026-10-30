import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { reserveRequestCost, resolvePilotModel, type PilotModel } from './models';
import { forwardResponses, offlineResponses } from './response-stream';
import { summarizeUpstreamFailure } from './upstream-error';
import { durableJson } from './durable-json';

type Transport = (url: string, init: RequestInit) => Promise<Response>;
// Electron is loaded lazily so the gateway stays testable under plain Node.
const electronTransport: Transport = async (url, init) => process.versions.electron ? (await import('electron')).net.fetch(url, init) : fetch(url, init);

class PilotRejection extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

// A shared, sequential billing boundary for both harnesses. No credentials in logs.
export async function gateway(file: string, credential: () => Promise<string | undefined>, dry: boolean, limits = { calls: 0, usd: 3.8, taskUsd: 0.30 }, model: PilotModel = resolvePilotModel(), capturePublicPayloads = false, transport: Transport = electronTransport, honorOutputLimit = false) {
  const ledger: any = { limitUsd: limits.usd, model: model.id, maxRequestBytes: model.maxRequestBytes, pricingPerMillion: model, provider: model.provider ?? 'openai', calls: [], rejections: [], chargedUsd: 0 };
  let active: { arm: string; task: string; calls: number; charged: number } | undefined;
  let pending = Promise.resolve();
  const save = () => durableJson(file, ledger);
  const endpoint = model.api === 'responses' ? 'responses' : 'chat/completions';
  const server = createServer(async (req, res) => {
    // A Responses client may start its next turn on response.completed, before
    // the preceding stream closes and its usage is persisted. Serialize that
    // follow-up behind accounting instead of spuriously rejecting it with 403.
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    if (!active || req.method !== 'POST' || req.url !== `/${active.arm}/v1/${endpoint}`) {
      release();
      res.writeHead(403).end('{}'); return;
    }
    const owner = active;
    let reservation = 0;
    let record: any;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > model.maxRequestBytes) throw new PilotRejection(413, 'request-size', 'Request size limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const requestedOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
      const outputLimit = honorOutputLimit && Number.isSafeInteger(requestedOutput) && requestedOutput > 0 ? Math.min(6000, requestedOutput) : 6000;
      const stream = body.stream;
      body.model = ledger.model; body.stream = model.api === 'responses'; delete body.stream_options;
      delete body.max_completion_tokens;
      if (model.api === 'responses') { delete body.max_tokens; body.max_output_tokens = outputLimit; body.service_tier = 'default'; }
      else body.max_tokens = outputLimit;
      delete body.temperature; body.reasoning = { ...body.reasoning, effort: model.reasoning };
      body.provider = { only: [model.provider ?? 'openai'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: model.input, completion: model.output } };
      delete body.reasoning_effort; delete body.plugins;
      // UTF-8 bytes + framing is a deliberately conservative input-token upper bound.
      const payload = JSON.stringify(body);
      // Fail closed if private repository/home paths enter model context.
      if (payload.includes('/Users/') || payload.includes('/home/') || payload.includes('claude_code') || payload.includes('credentials.encrypted')) throw new PilotRejection(403, 'private-context', 'Private context boundary rejected request');
      if (dry) await writeFile(file.replace('billing.json', `outbound-${owner.arm}.json`), payload, { mode: 0o600 });
      // Opt-in only for synthetic public replay fixtures; never capture credentials or headers.
      if (capturePublicPayloads) await writeFile(file.replace('billing.json', `request-${owner.arm}-${owner.calls + 1}.json`), payload, { mode: 0o600 });
      reservation = dry ? 0 : reserveRequestCost(model, Buffer.byteLength(payload));
      if (limits.calls > 0 && owner.calls >= limits.calls) throw new PilotRejection(409, 'request-count', 'Pilot request limit reached');
      if (owner.charged + reservation > limits.taskUsd || ledger.chargedUsd + reservation > ledger.limitUsd) throw new PilotRejection(402, 'budget', 'Pilot budget reservation limit reached');
      owner.calls++; owner.charged += reservation; ledger.chargedUsd += reservation;
      record = { arm: owner.arm, task: owner.task, reservationUsd: reservation, state: 'uncertain', dispatched: false, startedAt: new Date().toISOString() };
      ledger.calls.push(record); await save();
      let response: any;
      if (dry) response = model.api === 'responses' ? await forwardResponses(offlineResponses(), res)
        : { id: 'offline', choices: [{ message: { role: 'assistant', content: 'Offline transport check.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } };
      else {
        const key = await credential(); if (!key) throw new Error('No saved OpenRouter credential');
        record.dispatched = true;
        await save();
        const upstream = await transport(`https://openrouter.ai/api/v1/${endpoint}`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(model.api === 'responses' ? 300_000 : 120_000),
        });
        if (!upstream.ok) {
          record.httpStatus = upstream.status;
          // Request parameter names (not values) show what require_parameters had to satisfy.
          record.requestKeys = Object.keys(body).sort();
          record.upstreamError = summarizeUpstreamFailure(upstream.status, await upstream.text().catch(() => ''));
          throw new PilotRejection(upstream.status, 'upstream-http', `Upstream HTTP ${upstream.status}`);
        }
        response = model.api === 'responses' ? await forwardResponses(upstream, res) : await upstream.json();
        if (response.error || model.api === 'chat' && !response.choices?.length) throw new Error('Upstream returned no completion');
      }
      const cost = response.usage?.cost;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        ledger.chargedUsd += cost - reservation; owner.charged += cost - reservation;
        Object.assign(record, { state: 'reported', costUsd: cost, inputTokens: response.usage.prompt_tokens ?? response.usage.input_tokens, outputTokens: response.usage.completion_tokens ?? response.usage.output_tokens, cachedTokens: response.usage.prompt_tokens_details?.cached_tokens, reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens, provider: response.provider, finishedAt: new Date().toISOString() });
      }
      else record.state = 'reserved-no-cost';
      await save();
      if (model.api === 'responses') res.end();
      else if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const choice = response.choices[0], msg = choice.message;
        const base = { id: response.id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: ledger.model };
        const delta = { ...msg, tool_calls: msg.tool_calls?.map((call: any, index: number) => ({ ...call, index })) };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: response.usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response)); }
    } catch (error) {
      const status = error instanceof PilotRejection ? error.status : 502;
      const code = error instanceof PilotRejection ? error.code : 'gateway-failure';
      ledger.rejections.push({ arm: owner.arm, task: owner.task, status, code, reservationUsd: reservation, chargedUsd: owner.charged, at: new Date().toISOString() });
      if (record && !record.dispatched) {
        record.state = 'local-failure'; record.costUsd = 0;
        ledger.chargedUsd -= reservation; owner.charged -= reservation;
      }
      await save();
      if (res.headersSent) res.destroy();
      else res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code, message: error instanceof PilotRejection ? error.message : 'Gateway stopped' } }));
    } finally { release(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { ledger, port, select(arm: string, task: string) { active = { arm, task, calls: 0, charged: 0 }; }, close() { server.close(); } };
}
