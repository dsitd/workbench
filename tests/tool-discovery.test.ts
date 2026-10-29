import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolDiscovery, discoveryTool } from '../src/agent/tool-discovery';
import type { ToolDefinition } from '../src/shared/types';

const tool = (index: number): ToolDefinition => ({ name: `mcp_server_${index}`, description: index === 11 ? 'Search invoices and payment receipts' : 'Inspect weather forecast', permission: 'mcp', parameters: { type: 'object', properties: { value: { type: 'string' } } }, source: { kind: 'mcp', serverId: 'server', serverName: 'Accounting', toolName: `tool_${index}` } });
const builtin: ToolDefinition = { name: 'read_file', description: 'Read permitted file', parameters: { type: 'object' }, permission: 'read' };

test('a large MCP catalog exposes discovery and loads only explicit relevant schemas', () => {
  const selection = new ToolDiscovery(); const all = Array.from({ length: 65 }, (_, i) => tool(i));
  assert.deepEqual(selection.catalog([builtin], all).map(item => item.name), [discoveryTool.name, builtin.name]);
  const found = JSON.parse(selection.find({ id: 'find', name: discoveryTool.name, arguments: { query: 'invoices', limit: 2 } }).text);
  assert.equal(found.totalAvailable, 65); assert.deepEqual(found.loadedForNextStep.map((item: any) => item.name), ['mcp_server_11']);
  assert.deepEqual(selection.catalog([builtin], [...all].reverse()).map(item => item.name), [discoveryTool.name, 'mcp_server_11', builtin.name]);
  // A refreshed permission/catalog removal revokes previously loaded tools immediately.
  assert.ok(!selection.catalog([builtin], all.filter(item => item.name !== 'mcp_server_11')).some(item => item.name === 'mcp_server_11'));
});

test('discovery does not load unrelated tools and cannot bypass schema validation', () => {
  const selection = new ToolDiscovery(); const all = Array.from({ length: 10 }, (_, i) => tool(i));
  selection.catalog([builtin], all);
  assert.equal(JSON.parse(selection.find({ id: 'none', name: discoveryTool.name, arguments: { query: 'unrelatedterm' } }).text).loadedForNextStep.length, 0);
  assert.throws(() => selection.find({ id: 'invalid', name: discoveryTool.name, arguments: { query: 'weather', limit: 9 } }));
  assert.throws(() => selection.catalog([builtin], [...all, { ...tool(99), name: 'read_file' }]), /повторяющиеся/);
  assert.throws(() => selection.catalog([builtin], [{ ...tool(0), name: 'bad name' }]), /некорректное имя/);
});

test('small catalogs remain available with stable ordering and bounded persisted selections', () => {
  const small = Array.from({ length: 8 }, (_, i) => tool(i)); const selection = new ToolDiscovery(['mcp_server_1']);
  const first = selection.catalog([builtin], small);
  assert.equal(first.filter(item => item.permission === 'mcp').length, 8);
  assert.ok(!first.some(item => item.name === discoveryTool.name));
  assert.deepEqual(selection.catalog([builtin], [...small].reverse()), first);
});
