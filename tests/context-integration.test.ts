import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime';
import { defaultAppSettings } from '../src/shared/runs';
import { harnessFixture, reply, tool } from './agent-fixture';
import type { ToolDefinition } from '../src/shared/types';

const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((block: any) => block.text ?? '').join('');

test('Claude runtime opts into cache, keeps changed project data after replay, and trusts API charges', async () => {
  const f = harnessFixture({ model: 'anthropic/claude-sonnet-5.5' }); let calls = 0; const bodies: any[] = [];
  f.deps.getSettings = async () => ({ ...structuredClone(defaultAppSettings), promptCache: { enabled: true, ttl: '5m' } });
  f.deps.getProjectContext = async () => ({ pins: [{ source: 'README.md', content: `changed reference snapshot ${calls}` }] });
  f.deps.executeTool = async () => ({ text: 'Beginning of output\n' + 'file-data '.repeat(3200) + '\nERROR_AT_END: fixture verification failed' });
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body); calls++;
    assert.equal(body.session_id, f.session.id); assert.equal(body.messages[0].content[0].cache_control.type, 'ephemeral');
    const snapshot = body.messages.find((message: any) => text(message).startsWith('Workbench local reference snapshot'));
    assert.ok(snapshot); assert.equal(body.messages.at(-1), snapshot);
    assert.ok(!snapshot.content?.some?.((block: any) => block.cache_control));
    if (calls === 2) {
      const output = body.messages.find((message: any) => message.role === 'tool');
      assert.ok(text(output).includes('Beginning of output')); assert.ok(text(output).includes('ERROR_AT_END'));
      assert.ok(text(output).length < 19_000);
    }
    return calls === 1 ? reply('', { prompt_tokens: 1100, completion_tokens: 12, cost: 0.0011 }, 'tool_calls', [tool()]) : reply('Verified result', { prompt_tokens: 2200, prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 200 }, completion_tokens: 15, cost: 0.0004 });
  } }).run({ sessionId: f.session.id, text: 'Read README and verify the output', attachmentIds: [] });
  assert.equal(calls, 2); assert.equal(f.lastRun().status, 'completed');
  assert.equal(text(bodies[0].messages[0]), text(bodies[1].messages[0]));
  assert.equal(f.lastRun().usage.costUsd, 0.0015); assert.equal(f.lastRun().usage.cacheReadTokens, 2000);
  assert.ok(f.lastRun().contextSelection);
  assert.equal(f.lastRun().stepLog[0].contextCache?.transition, 'initial');
  assert.equal(f.lastRun().stepLog[1].contextCache?.transition, 'append');
  assert.equal(f.lastRun().stepLog[1].contextCache?.historyPrefixPreserved, true);
  assert.ok(f.messages.find(message => message.role === 'tool')!.content.length > 18_000);
});

test('large MCP catalog discovers schemas before execution and revokes removed selections', async () => {
  const f = harnessFixture(); let calls = 0, executions = 0;
  const external: ToolDefinition[] = Array.from({ length: 20 }, (_, index) => ({ name: `mcp_fixture_${index}`, description: index === 12 ? 'Invoice lookup' : 'Weather lookup', permission: 'mcp', parameters: { type: 'object' }, source: { kind: 'mcp', serverId: 'fixture', serverName: 'Accounting', toolName: `lookup_${index}` } }));
  f.deps.listAdditionalTools = async () => external;
  f.deps.executeTool = async call => { assert.equal(call.name, 'mcp_fixture_12'); executions++; return { text: 'Invoice found' }; };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    const names = body.tools.map((item: any) => item.function.name);
    assert.ok(names.includes('find_mcp_tools'));
    if (calls === 1) { assert.ok(!names.includes('mcp_fixture_12')); return reply('', undefined, 'tool_calls', [tool('find', 'find_mcp_tools', { query: 'Invoice', limit: 1 })]); }
    assert.ok(names.includes('mcp_fixture_12')); assert.equal(names.filter((name: string) => name.startsWith('mcp_fixture_')).length, 1);
    return calls === 2 ? reply('', undefined, 'tool_calls', [tool('lookup', 'mcp_fixture_12', {})]) : reply('Invoice complete');
  } }).run({ sessionId: f.session.id, text: 'Use the invoice MCP tool', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed'); assert.equal(calls, 3); assert.equal(executions, 1);
  assert.deepEqual(f.lastRun().loadedMcpToolNames, ['mcp_fixture_12']);
});
