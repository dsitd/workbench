import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { buildContext } from '../src/agent/context';
import { harnessFixture, reply, tool } from './agent-fixture';
import type { VerificationResult } from '../src/shared/types';

function snapshot(body: any) {
  const texts = body.messages.filter((m: any) => m.role === 'user').map((m: any) => typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join(''));
  return texts.join('\n');
}

test('a clean pass adds no review cue; later mutations surface stale verification without hiding tools', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'check' });
  f.deps.verifyRun = async run => ({ runId: run.id, projectId: 'p', sessionId: 's', command: 'check', cwd: f.project.folders[0].path, status: 'passed', exitCode: 0, output: 'ok' } as VerificationResult);
  let step = 0;
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (++step === 1) return reply('', undefined, 'tool_calls', [tool('v', 'verify_project', {})]);
    const data = snapshot(body);
    if (step === 2) assert.doesNotMatch(data, /"kind":"completion-state"/);
    assert.ok(body.tools.some((t: any) => t.function.name === 'write_file'));
    // The user's remaining work can still require a mutation after a passing check.
    if (step === 2) return reply('', undefined, 'tool_calls', [tool('w', 'write_file', { path: 'remaining.txt', content: 'remaining requirement' })]);
    assert.match(data, /"verification":"stale"/);
    return reply('Done');
  } }).run({ sessionId: 's', text: 'Implement both requested changes and verify.', attachmentIds: [] });
  assert.equal(f.lastRun().status, 'completed');
  assert.equal(step, 3);
});

test('a passed project check never hides unmet user criteria in completion context', async () => {
  const f = harnessFixture({}, {}, { verificationCommand: 'check' });
  f.deps.verifyRun = async run => ({ runId: run.id, projectId: 'p', sessionId: 's', command: 'check', cwd: f.project.folders[0].path, status: 'passed', exitCode: 0, output: 'ok' } as VerificationResult);
  let step = 0, observed = false;
  await new AgentRuntime(f.deps, { maxSteps: 2, fetch: async (_url, init) => {
    if (++step === 1) return reply('', undefined, 'tool_calls', [tool('v', 'verify_project', {})]);
    const data = snapshot(JSON.parse(String(init?.body)));
    assert.match(data, /"missingCriteria":\["criterion_1"\]/); observed = true;
    return reply('Done');
  } }).run({ sessionId: 's', text: 'Acceptance criteria:\nThe requested artifact exists', attachmentIds: [] });
  assert.equal(observed, true);
  assert.notEqual(f.lastRun().status, 'completed');
});

test('minimal text-only context omits unavailable feature tutorials but preserves trust and access policy', async () => {
  const f = harnessFixture({ vision: false });
  const history = [{ id: 'u', role: 'user' as const, content: 'Inspect this file', createdAt: '' }];
  const c = await buildContext(f.deps, f.session, f.project, f.model, history, f.deps.tools, new AbortController().signal);
  assert.doesNotMatch(c.system, /inspect_image|read_skill_resource|External MCP tools|explore_code|typescript_diagnostics/);
  assert.match(c.system, /untrusted/);
  assert.match(c.system, /Permitted folders/);
  assert.match(c.system, /secrets/);
});
