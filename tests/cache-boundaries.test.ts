import test from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, responsesBody } from '../src/agent/mappings';
import type { ModelMessage, ModelRequest } from '../src/shared/agent';
import { fixtureModel } from './agent-fixture';

const mark = 'prompt_cache_breakpoint';
const marked = (value: unknown): boolean => JSON.stringify(value).includes(`"${mark}"`);
const source: ModelMessage = { role: 'user', content: 'Implement and verify the requested behavior.' };
function history(turns: number): ModelMessage[] {
  return [source, ...Array.from({ length: turns }, (_, i): ModelMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: `call-${i}`, name: 'read_file', arguments: { path: `file-${i}.ts` } }] },
    { role: 'tool', content: `Observed version ${i}`, toolCallId: `call-${i}` },
  ]).flat(), { role: 'user', content: `Current mutable map ${turns}`, contextData: true }];
}
function request(messages: ModelMessage[], responses: boolean, direct: boolean): ModelRequest {
  return { model: { ...fixtureModel, kind: responses ? 'openai-responses' : 'openai-compatible',
    baseUrl: direct ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1', model: direct ? 'gpt-6-luna' : 'openai/gpt-6-luna' },
  system: 'Stable policy', messages, tools: [], signal: new AbortController().signal, cachePolicy: { enabled: true }, sessionId: 'cache-boundary-fixture' };
}

for (const responses of [false, true]) for (const direct of [false, true]) {
  test(`${responses ? 'Responses' : 'Chat'} ${direct ? 'OpenAI' : 'OpenRouter'} preserves previously written cache boundaries as history grows`, () => {
    let previous: any[] | undefined;
    for (let turn = 0; turn < 6; turn++) {
      const messages = history(turn), before = structuredClone(messages);
      const body = (responses ? responsesBody : chatBody)(request(messages, responses, direct));
      const items = responses ? body.input : body.messages;
      assert.equal(marked(items.at(-1)), false, 'volatile snapshots must remain outside explicit boundaries');
      const stable = items.slice(0, -1);
      if (previous) assert.deepEqual(stable.slice(0, previous.length), previous, 'wire-format prefix, including markers, must not be rewritten');
      const results = stable.filter((item:any) => responses ? item.type === 'function_call_output' : item.role === 'tool');
      assert.equal(results.length, turn); assert.ok(results.every(marked));
      assert.ok(marked(stable.find((item:any) => item.role === 'user')));
      assert.deepEqual(messages, before, 'provider mapping must not mutate stored history');
      previous = stable;
    }
  });
}

test('explicit boundary matching can reuse the preceding conversation before a fresh volatile snapshot', () => {
  // A common text prefix alone is insufficient: the earlier written endpoint
  // must still be a lookup boundary in the subsequent explicit-only request.
  const map = (n:number) => chatBody(request(history(n), false, false)).messages as any[];
  const first = map(1), second = map(2);
  const boundaries = (messages:any[]) => messages.flatMap((item,index) => marked(item) ? [JSON.stringify(messages.slice(0,index+1))] : []);
  const written = boundaries(first), available = boundaries(second);
  assert.ok(available.includes(written.at(-1)!));
});
