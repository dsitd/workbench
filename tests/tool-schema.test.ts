import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolArguments, strictToolSchema, toolValidator, validateToolArguments } from '../src/shared/tool-schema';
import { ToolRegistry } from '../src/backend/tool-registry';
import { chatBody, responsesBody } from '../src/agent/mappings';
import type { ToolContext, ToolDefinition } from '../src/shared/types';
import { fixtureModel } from './agent-fixture';

const definition: ToolDefinition = { name: 'fixture', permission: 'read', description: 'Fixture contract', parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 5 }, label: { type: 'string' } }, required: ['count'], additionalProperties: false } };
test('schema rejects malformed input before the handler and never coerces or echoes values', async () => {
  let executions = 0;
  const registry = new ToolRegistry([{ definition, execute: async () => { executions++; return { text: 'ok' }; } }]);
  const context = { project: { internet: false }, signal: new AbortController().signal } as ToolContext;
  for (const args of [{ count: 'synthetic-invalid-value' }, { count: 0 }, { count: 6 }, { count: Infinity }, { count: NaN }, { count: 1, label: null }, { count: 1, extra: true }, {}]) {
    await assert.rejects(registry.execute({ id: 'call', name: 'fixture', arguments: args }, context, {}), error => /Invalid tool arguments/.test(String(error)) && !String(error).includes('synthetic-invalid-value'));
  }
  assert.equal(executions, 0);
  await registry.execute({ id: 'good', name: 'fixture', arguments: { count: 2 } }, context, {}); assert.equal(executions, 1);
});
test('strict wire optional null normalizes to omission while a required null remains invalid', () => {
  const wire = strictToolSchema(definition.parameters)!;
  assert.deepEqual(wire.required, ['count', 'label']);
  assert.deepEqual(normalizeToolArguments(definition, { count: 2, label: null }), { count: 2 });
  assert.throws(() => validateToolArguments(definition, { count: null }), /Invalid tool arguments/);
  assert.equal(strictToolSchema({ type: 'object' }), undefined);
  assert.equal(strictToolSchema({ type: 'object', properties: { count: { type: 'integer' } } }), undefined);
});
test('draft-2020 local refs work; remote and async schema compilation never fetches', () => {
  const parameters = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { count: { $ref: '#/$defs/count' } }, $defs: { count: { type: 'integer', minimum: 2 } } };
  assert.throws(() => validateToolArguments({ parameters }, { count: 1 }), /Invalid tool arguments/);
  validateToolArguments({ parameters }, { count: 2 });
  assert.throws(() => toolValidator({ $ref: 'https://example.test/schema' }), /external/);
  assert.throws(() => toolValidator({ type: 'object', $async: true }), /Async/);
});
test('strict schemas are used on official OpenAI routes with compatible native schemas only', () => {
  const request = { model: { ...fixtureModel, baseUrl: 'https://api.openai.com/v1' }, system: '', messages: [], tools: [definition], signal: new AbortController().signal };
  assert.equal(chatBody(request).tools[0].function.strict, true);
  assert.equal(responsesBody(request).tools[0].strict, true);
  assert.equal(responsesBody({ ...request, model: fixtureModel }).tools[0].strict, false);
  assert.equal(responsesBody({ ...request, tools: [{ ...definition, source: { kind: 'mcp', serverId: 's', serverName: 'S', toolName: 'fixture' } }] }).tools[0].strict, false);
});
