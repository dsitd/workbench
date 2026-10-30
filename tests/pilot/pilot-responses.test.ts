import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { forwardResponses } from '../../scripts/harness-pilot/response-stream';
import { sweImplementation, sweResults } from '../../scripts/harness-pilot/swe';

test('Responses proxy preserves fragmented opaque events and retains terminal billing', async () => {
  const terminal = { id: 'r1', status: 'incomplete', usage: { input_tokens: 22, output_tokens: 8, cost: 0.002 }, output: [] };
  const source = [
    { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'opaque-fixture-данные' } },
    { type: 'response.incomplete', response: terminal },
  ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(source), chunks: Buffer[] = [];
  const upstream = new Response(new ReadableStream({ start(controller) {
    for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7)); controller.close();
  } }));
  const client = { writeHead: () => {}, write: (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)); } } as unknown as ServerResponse;
  assert.deepEqual(await forwardResponses(upstream,client),terminal);
  assert.equal(Buffer.concat(chunks).toString(),source);
  await assert.rejects(forwardResponses(new Response('data: {"type":"response.created"}\n\n'),client),/without a terminal event/);
});

test('SWE grading excludes tests and escaping paths and distinguishes required passes from xfails', () => {
  assert.equal(sweImplementation('sympy/core/assumptions.py'),true);
  for(const file of ['sympy/core/tests/test_assumptions.py','sympy/conftest.py','sympy/../outside.py','bin/test','.docs/instructions.md'])
    assert.equal(sweImplementation(file),false,file);
  assert.deepEqual(sweResults('test_existing ok\ntest_new F\ntest_expected f\n'),{test_existing:'ok',test_new:'F',test_expected:'f'});
});
