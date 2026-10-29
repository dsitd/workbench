import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/agent/context';
import { providerId } from '../src/agent/reasoning';
import { harnessFixture } from './agent-fixture';
import type { ChatMessage } from '../src/shared/types';

test('context budget counts retained Responses content once, ignoring its duplicate display text', async () => {
  const f = harnessFixture({ kind: 'openai-responses', contextWindow: 100_000 });
  const content = 'returned explanation '.repeat(300);
  const native = [{ type: 'message', id: 'provider-msg', role: 'assistant', content: [{ type: 'output_text', text: content }] }];
  const history: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'Explain.', createdAt: '' },
    { id: 'a1', role: 'assistant', content, providerItems: native, providerId: providerId(f.model), createdAt: '' },
    { id: 'u2', role: 'user', content: 'Continue.', createdAt: '' }];
  const build = (messages: ChatMessage[]) => buildContext(f.deps, f.session, f.project, f.model, messages, [], new AbortController().signal);
  const duplicate = await build(history);
  const nativeOnly = await build(history.map(m => m.role === 'assistant' ? { ...m, content: '' } : m));
  assert.equal(duplicate.report.estimatedTokens, nativeOnly.report.estimatedTokens);
});

test('wire estimates preserve opaque reasoning, tool calls, cross-provider fallback and image reserve', async () => {
  const { messageTokens, estimateTokens } = await import('../src/agent/context-cost');
  const { responsesBody, chatBody, anthropicBody } = await import('../src/agent/mappings');
  for (const kind of ['openai-responses', 'openai-compatible', 'anthropic'] as const) {
    const f = harnessFixture({ kind });
    const call = { id: 'call1', name: 'read_file', arguments: { path: 'fixture.ts' } };
    const items = kind === 'anthropic'
      ? [{ type: 'thinking', thinking: 'observed', signature: 'opaque-signature' }, { type: 'tool_use', id: call.id, name: call.name, input: call.arguments }]
      : [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque-fixture' }, { type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }];
    const message = { role: 'assistant' as const, content: '', toolCalls: [call], providerId: providerId(f.model), providerItems: items, reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-fixture' }] };
    const before = structuredClone(message);
    const request = { model: f.model, messages: [message], system: '', tools: [], signal: new AbortController().signal };
    const expected = kind === 'anthropic' ? anthropicBody(request).messages : kind === 'openai-responses' ? responsesBody(request).input : chatBody(request).messages.slice(1);
    assert.equal(messageTokens(f.model, message), estimateTokens(JSON.stringify(expected)) + 16);
    assert.deepEqual(message, before);
    const foreign = { ...message, providerId: 'foreign-provider' };
    assert.equal(messageTokens(f.model, foreign), messageTokens(f.model, { role: 'assistant', content: '', toolCalls: [call] }));
    const image = { role: 'tool' as const, content: 'selected', toolCallId: call.id, images: [{ mimeType: 'image/png', base64: 'x'.repeat(100_000) }] };
    assert.equal(messageTokens(f.model, image) - messageTokens(f.model, { ...image, images: undefined }), 4096);
  }
});
