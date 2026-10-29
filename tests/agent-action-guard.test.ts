import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent';
import { referenceError, needsActionReview } from '../src/agent/action-grounding';
import type { AgentDependencies } from '../src/shared/agent';
import type { ChatMessage, ModelConfig, Project, RunRecord, Session, ToolCall, ToolDefinition } from '../src/shared/types';

const project: Project = { id: 'p', name: 'Account fixture', folders: [{ path: '/tmp/action-guard-fixture', access: 'write' }],
  internet: true, commandPolicy: 'ask', instructions: '', createdAt: '', updatedAt: '' };
const model: ModelConfig = { id: 'm', name: 'Local fixture', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
  model: 'fixture', apiKeyEnv: '', contextWindow: 24000, maxOutputTokens: 1000, enabled: true, vision: false };
function fixture(tools: ToolDefinition[] = []) {
  const history: ChatMessage[] = [], executed: ToolCall[] = [], runs: RunRecord[] = [];
  let session: Session = { id: 's', projectId: 'p', title: 'Test', modelId: 'm', status: 'idle', createdAt: '', updatedAt: '', summary: '' };
  const deps: AgentDependencies = {
    getSession: async () => session, getProject: async () => project, getModel: async () => model,
    getMessages: async () => [...history], appendMessage: async (_id, message) => { history.push(message); },
    updateSession: async (_id, patch) => session = { ...session, ...patch },
    loadInstructions: async () => [{ path: 'POLICY', scope: '/tmp/action-guard-fixture', content: 'Follow the customer constraints. Inspect the available options before changing an account.', writable: true }],
    listSkills: async () => [], readSkill: async () => '', resolveCredential: async () => undefined,
    getAttachment: async () => { throw new Error('No attachments'); }, resolveImage: async () => { throw new Error('No images'); },
    tools, executeTool: async call => { executed.push(call); return { text: '{"ok":true}' }; },
    emit: () => {}, saveContext: () => {}, saveRun: async run => { runs.push(structuredClone(run)); },
  };
  return { deps, history, executed, runs, session: () => session };
}
const reply = (content: string, calls: ToolCall[] = []) => new Response(JSON.stringify({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop',
  message: { role: 'assistant', content, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }), { headers: { 'Content-Type': 'application/json' } });
const definition = (name: string, permission: ToolDefinition['permission'], fields: string[]): ToolDefinition => ({ name, permission, description: name,
  parameters: { type: 'object', properties: Object.fromEntries(fields.map(f => [f, { type: 'string' }])), required: fields } });

test('action review receives observed field differences without another model request or automatic authorization', async () => {
  const f = fixture([definition('get_subscription', 'read', ['subscription_id']), definition('change_subscription', 'write', ['subscription_id', 'option_id', 'category'])]);
  f.deps.executeTool = async call => {
    f.executed.push(call);
    return { text: JSON.stringify({ subscription_id: 'S1', option_id: 'old', category: 'standard', options: ['old', 'new'] }) };
  };
  let actor = 0, reviews = 0;
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages.some((m: any) => m.role === 'system' && m.content.includes('ACTION_REVIEW_V1'))) {
      reviews++;
      const data = JSON.parse(body.messages.at(-1).content);
      assert.equal(data.observedFieldComparisons[0].sourceToolCallId, 'read');
      assert.deepEqual(data.observedFieldComparisons[0].equal, ['category']);
      assert.deepEqual(data.observedFieldComparisons[0].different, { option_id: { observed: 'old', proposed: 'new' } });
      // Matching some fields is not an authorization bypass.
      return reply('{"allow":false,"reason":"The user has not confirmed the new option."}');
    }
    actor++;
    if (actor === 1) return reply('', [{ id: 'read', name: 'get_subscription', arguments: { subscription_id: 'S1' } }]);
    if (actor === 2) return reply('', [{ id: 'change', name: 'change_subscription', arguments: { subscription_id: 'S1', option_id: 'new', category: 'standard' } }]);
    return reply('Please confirm the new option.');
  } }).run({ sessionId: 's', text: 'Inspect subscription S1 and explain how to change it.', attachmentIds: [] });
  assert.equal(actor, 3); assert.equal(reviews, 1); assert.deepEqual(f.executed.map(c => c.id), ['read']);
  assert.equal(f.history.filter(m => m.toolCallId === 'change' && m.error).length, 1);
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.004);
});

test('empty final response retries once without replaying a successful tool', async () => {
  const f = fixture([definition('read_balance', 'read', [])]); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    return requests === 1 ? reply('', [{ id: 'read-once', name: 'read_balance', arguments: {} }]) : reply(requests === 2 ? '' : 'The balance was checked.');
  } }).run({ sessionId: 's', text: 'Check the balance.', attachmentIds: [] });
  assert.equal(requests, 3); assert.equal(f.executed.length, 1); assert.equal(f.session().status, 'completed');
  assert.equal(f.history.at(-1)?.content, 'The balance was checked.');
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.003);
});

test('two consecutive empty responses cannot complete the task and retry is bounded', async () => {
  const f = fixture(); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply('   '); } }).run({ sessionId: 's', text: 'Answer the customer.', attachmentIds: [] });
  assert.equal(requests, 2); assert.equal(f.session().status, 'error'); assert.notEqual(f.runs.at(-1)?.status, 'completed');
});

test('corrupted customer email is rejected before lookup and the exact source value can recover', async () => {
  const f = fixture([definition('find_account_by_email', 'read', ['email'])]); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    if (requests === 1) return reply('', [{ id: 'wrong', name: 'find_account_by_email', arguments: { email: 'mila7872@example.test' } }]);
    if (requests === 2 && f.history.some(m => m.toolCallId === 'wrong' && m.error))
      return reply('', [{ id: 'correct', name: 'find_account_by_email', arguments: { email: 'mila.account7872@example.test' } }]);
    return reply('Account found.');
  } }).run({ sessionId: 's', text: 'Find my account: mila.account7872@example.test', attachmentIds: [] });
  assert.deepEqual(f.executed.map(c => c.arguments.email), ['mila.account7872@example.test']);
  assert.equal(f.history.filter(m => m.toolCallId === 'wrong').length, 1);
  assert.equal(f.session().status, 'completed');
});

test('a mutation rejected by action review has no effect and can be corrected from observed options', async () => {
  const f = fixture([definition('list_options', 'read', []), definition('change_subscription', 'write', ['account_id', 'option_id'])]);
  const writes: string[] = []; let agentRequests = 0, reviews = 0;
  f.deps.executeTool = async call => {
    if (call.name === 'list_options') return { text: JSON.stringify({ account_id: 'acct-4', options: [{ option_id: 'cheap-7', price: 14 }, { option_id: 'expensive-8', price: 22 }] }) };
    writes.push(String(call.arguments.option_id)); return { text: '{"changed":true}' };
  };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages.some((m: any) => m.role === 'system' && m.content.includes('ACTION_REVIEW_V1'))) {
      reviews++; const data = JSON.parse(body.messages.at(-1).content);
      const allow = data.action.arguments.option_id === 'cheap-7';
      return reply(JSON.stringify({ allow, reason: allow ? 'Exact requested cheapest available option.' : 'The observed option cheap-7 costs 14; select it to satisfy cheapest.' }));
    }
    agentRequests++;
    if (agentRequests === 1) return reply('', [{ id: 'options', name: 'list_options', arguments: {} }]);
    if (agentRequests === 2) return reply('', [{ id: 'expensive', name: 'change_subscription', arguments: { account_id: 'acct-4', option_id: 'expensive-8' } }]);
    if (agentRequests === 3 && f.history.some(m => m.toolCallId === 'expensive' && m.error))
      return reply('', [{ id: 'cheap', name: 'change_subscription', arguments: { account_id: 'acct-4', option_id: 'cheap-7' } }]);
    return reply('Subscription changed.');
  } }).run({ sessionId: 's', text: 'For account acct-4 choose the cheapest available subscription. You may make the change.', attachmentIds: [] });
  assert.deepEqual(writes, ['cheap-7']); assert.equal(reviews, 2);
  assert.equal(f.history.filter(m => m.role === 'tool' && m.toolCallId === 'expensive').length, 1);
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.006);
});

test('references require an observed exact value, not an assistant claim or failed call echo', () => {
  const msg = (role: ChatMessage['role'], content: string, error = false): ChatMessage => ({ id: role, role, content, error, createdAt: '' });
  const call: ToolCall = { id: 'c', name: 'change_order', arguments: { order_id: '#AB-123', new_item_ids: ['item-8'] } };
  assert.equal(referenceError(call, [msg('tool', '{"order_id":"#AB-123","items":["item-8"]}')]), undefined);
  assert.ok(referenceError(call, [msg('assistant', '#AB-123 item-8'), msg('tool', '#AB-123 item-8', true)]));
  assert.ok(referenceError({ ...call, arguments: { order_id: 'AB-123' } }, [msg('user', '#AB-123')]));
  assert.equal(referenceError({ ...call, arguments: { path: '/tmp/new.txt', content: 'invented free text' } }, []), undefined);
  assert.equal(referenceError({ ...call, name: 'create_record', arguments: { id: 'new-1' } }, []), undefined);
  assert.equal(referenceError({ ...call, arguments: { user_id: 'mila_account_77' } }, [msg('user', 'My ID is mila_account_77.')]), undefined);
  assert.equal(referenceError({ ...call, arguments: { email: 'mila.account@example.test' } }, [msg('user', 'Email: mila.account@example.test. Thank you.')]), undefined);
  assert.ok(referenceError({ ...call, arguments: { email: 'mila.account@example.test' } }, [msg('user', 'Email: mila.account@example.test.invalid')]));
  assert.equal(needsActionReview(call, definition('change_order', 'write', [])), true);
  assert.equal(needsActionReview(call, definition('get_order', 'read', [])), false);
});

test('malformed review cannot start an operation, and a review sees earlier tools in the same batch', async () => {
  const f = fixture([definition('list_options', 'read', []), definition('change_subscription', 'write', ['account_id', 'option_id'])]);
  let requests = 0, began = 0, reviews = 0;
  f.deps.beginOperation = async () => { began++; throw new Error('Must not begin a rejected action'); };
  f.deps.executeTool = async call => { f.executed.push(call); return { text: '{"account_id":"acct-4","option_id":"option-7"}' }; };
  await new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (body.messages.some((m: any) => m.role === 'system' && m.content.includes('ACTION_REVIEW_V1'))) {
      reviews++; const input = JSON.parse(body.messages.at(-1).content);
      assert.equal(input.completedActionsThisStep[0].toolCallId, 'read');
      return reply('not a verdict');
    }
    return requests === 1 ? reply('', [
      { id: 'read', name: 'list_options', arguments: {} },
      { id: 'write', name: 'change_subscription', arguments: { account_id: 'acct-4', option_id: 'option-7' } },
    ]) : reply('The change could not be verified.');
  } }).run({ sessionId: 's', text: 'Inspect and update my subscription.', attachmentIds: [] });
  assert.equal(reviews, 1); assert.equal(began, 0);
  assert.deepEqual(f.executed.map(c => c.name), ['list_options']);
  assert.equal(f.history.filter(m => m.role === 'tool' && m.toolCallId === 'write' && m.error).length, 1);
});

test('a review cannot spend another step once the run limit is reached', async () => {
  const f = fixture([definition('cancel_order', 'write', ['order_id'])]); let requests = 0;
  f.deps.getProject = async () => ({ ...project, runLimits: { maxSteps: 1 } });
  await new AgentRuntime(f.deps, { fetch: async () => { requests++; return reply('', [{ id: 'cancel', name: 'cancel_order', arguments: { order_id: '#A-4' } }]); } })
    .run({ sessionId: 's', text: 'Cancel order #A-4.', attachmentIds: [] });
  assert.equal(requests, 1); assert.equal(f.executed.length, 0);
  assert.equal(f.history.filter(m => m.role === 'tool' && m.toolCallId === 'cancel').length, 1);
  assert.notEqual(f.runs.at(-1)?.status, 'completed');
});

test('cancellation during action review pairs all announced calls without executing them and retains uncertain billing', async () => {
  const f = fixture([definition('cancel_order', 'write', ['order_id'])]);
  let reviewStarted!: () => void;
  const started = new Promise<void>(resolve => { reviewStarted = resolve; });
  let requests = 0;
  const runtime = new AgentRuntime(f.deps, { fetch: async (_url, init) => {
    if (++requests === 1) return reply('', ['#A-4', '#A-5'].map((order_id, i) => ({ id: `cancel-${i}`, name: 'cancel_order', arguments: { order_id } })));
    reviewStarted();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const running = runtime.run({ sessionId: 's', text: 'Cancel orders #A-4 and #A-5.', attachmentIds: [] });
  await started; await runtime.stop('s'); await running;
  assert.equal(requests, 2); assert.equal(f.executed.length, 0);
  assert.deepEqual(f.history.filter(m => m.role === 'tool').map(m => m.toolCallId), ['cancel-0', 'cancel-1']);
  assert.ok(f.history.filter(m => m.role === 'tool').every(m => m.error));
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.001);
  assert.equal(f.runs.at(-1)?.usage.unknownCostCalls, 1);
  assert.equal(f.runs.at(-1)?.usage.costSource, 'unknown');
});

test('malformed arguments reject the entire batch, recover once and never replay an earlier successful effect', async () => {
  const f = fixture([definition('record_note', 'write', ['text'])]); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => {
    requests++;
    if (requests === 1) return reply('', [{ id: 'already-done', name: 'record_note', arguments: { text: 'first' } }]);
    if (requests === 2) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [
      { id: 'invalid', type: 'function', function: { name: 'record_note', arguments: '{"text":' } },
      { id: 'sibling', type: 'function', function: { name: 'record_note', arguments: '{"text":"second"}' } },
    ] } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }));
    if (requests === 3) return reply('', [{ id: 'repaired', name: 'record_note', arguments: { text: 'second' } }]);
    return reply('Done.');
  } }).run({ sessionId: 's', text: 'Record two notes.', attachmentIds: [] });
  assert.equal(requests, 4); assert.equal(f.session().status, 'completed');
  assert.deepEqual(f.executed.map(c => c.arguments.text), ['first', 'second']);
  for (const id of ['invalid', 'sibling']) {
    const results = f.history.filter(m => m.role === 'tool' && m.toolCallId === id);
    assert.equal(results.length, 1); assert.equal(results[0].error, true);
  }
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.004);
});

test('argument repair is bounded and persistent malformed calls remain paired without execution', async () => {
  const f = fixture([definition('record_note', 'write', ['text'])]); let requests = 0;
  await new AgentRuntime(f.deps, { fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
    content: '', tool_calls: [{ id: `bad-${++requests}`, type: 'function', function: { name: 'record_note', arguments: '{' } }],
  } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } })) }).run({ sessionId: 's', text: 'Record a note.', attachmentIds: [] });
  assert.equal(requests, 2); assert.equal(f.executed.length, 0); assert.equal(f.session().status, 'error');
  assert.deepEqual(f.history.filter(m => m.role === 'tool').map(m => m.toolCallId), ['bad-1', 'bad-2']);
  assert.equal(f.runs.at(-1)?.usage.costUsd, 0.002);
});

