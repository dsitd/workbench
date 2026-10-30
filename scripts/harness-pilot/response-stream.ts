import type { ServerResponse } from 'node:http';

/** Inspect terminal billing only; forward provider events without rewriting reasoning or tools. */
export async function forwardResponses(upstream: Response, client: ServerResponse): Promise<any> {
  if (!upstream.body) throw new Error('Missing Responses stream');
  const decoder = new TextDecoder(); let pending = '', response: any;
  client.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const inspect = (line: string) => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim(); if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) response = event.response;
  };
  for await (const chunk of upstream.body as any) {
    client.write(chunk);
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 8_000_000) throw new Error('Responses event too large');
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) inspect(line);
  }
  pending += decoder.decode(); if (pending) inspect(pending);
  if (!response) throw new Error('Responses stream ended without a terminal event');
  return response;
}

export function offlineResponses(): Response {
  const item = { id: 'msg_offline', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline transport check.', annotations: [] }] };
  const response = { id: 'resp_offline', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0 } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
