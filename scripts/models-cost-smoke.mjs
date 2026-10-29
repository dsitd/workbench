import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runDir = path.resolve('.workbench/acceptance', randomUUID());
const projectRoot = path.join(runDir, 'project');
await fs.mkdir(projectRoot, { recursive: true });
const file = path.join(projectRoot, 'api.ts');
await fs.writeFile(file, 'export const fixture = 7;\n');
const checks = [];
let desktop;
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(runDir, 'state') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV_URL;
const wait = async (predicate, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Model and cost acceptance condition timed out.');
};
const choose = async (page, testId, label) => {
  await page.getByTestId(testId).click();
  await page.getByRole('listbox').getByRole('option', { name: label, exact: true }).click();
};
const close = async (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, 'Fixture cost must match reported API cost.');

try {
  desktop = await electron.launch({ args: process.env.WORKBENCH_EXECUTABLE ? [] : ['.'], executablePath: process.env.WORKBENCH_EXECUTABLE || undefined, env, timeout: 30_000 });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(15_000);
  await page.getByTestId('project-create').first().waitFor();
  // Isolated fake transport: only deliberately artificial fixture credentials are used.
  await desktop.evaluate((_electron, file) => {
    globalThis.__modelCostFixture = { calls: [], attempts: [], failures: [], titleCalls: 0, holdFirstFinal: false };
    globalThis.fetch = async (url, init) => {
      const fixture = globalThis.__modelCostFixture;
      const checked = (ok, message) => { if (!ok) { fixture.failures.push(message); throw Error(message); } };
      checked(init.headers.Authorization === 'Bearer deliberately-artificial-model-cost-fixture', 'The existing fixture credential must be reused internally.');
      const body = JSON.parse(init.body);
      fixture.attempts.push({ url: String(url), model: body.model, effort: body.reasoning?.effort ?? 'auto', inputTypes: (body.input ?? []).map(item => item.type ?? item.role), toolNames: (body.tools ?? []).map(tool => tool.name ?? tool.function?.name) });
      const text = item => typeof item?.content === 'string' ? item.content : (item?.content ?? []).map(part => part.text ?? '').join('');
      const transportItems = body.input ?? body.messages ?? [];
      const fallbackIndex = transportItems.findLastIndex(item => item.role === 'user' && /^FALLBACK_(CHAT|RESPONSES)\b/.test(text(item)));
      if (fallbackIndex >= 0) {
        const responses = text(transportItems[fallbackIndex]).startsWith('FALLBACK_RESPONSES');
        if (responses) {
          checked(String(url) === 'https://openrouter.ai/api/v1/responses' && body.model === 'openai/gpt-6-luna', 'Foreign Chat history must reach the selected Luna Responses model.');
          checked(body.prompt_cache_options?.mode === 'explicit' && body.prompt_cache_options.ttl === '30m', 'OpenRouter requires its documented explicit caching mode.');
          checked(transportItems.some(item => item.role === 'assistant' && typeof item.content === 'string' && item.content.includes('Совместимый Chat завершён')), 'Foreign assistant fallback must use a valid EasyInputMessage string.');
        } else {
          checked(String(url) === 'https://fixture-gateway.invalid/v1/chat/completions', 'An unknown gateway must remain on its configured Chat transport.');
          checked(!JSON.stringify(body).includes('cache_control') && !JSON.stringify(body).includes('prompt_cache_breakpoint') && !body.prompt_cache_options && !body.session_id && !body.prompt_cache_key, 'Unknown gateways must receive no undocumented cache controls.');
        }
        const result = transportItems.slice(fallbackIndex + 1).find(item => responses ? item.type === 'function_call_output' : item.role === 'tool');
        const id = responses ? 'fallback-responses-read' : 'fallback-chat-read';
        if (result) checked((result.call_id ?? result.tool_call_id) === id, 'Cross-protocol tool result must keep its exact call ID.');
        const answer = responses ? 'Responses после Chat завершён.' : 'Совместимый Chat завершён.';
        fixture.calls.push({ kind: 'cross-protocol', tools: !result, model: body.model });
        const usage = { prompt_tokens: 1000, completion_tokens: 12, cost: 0.0001 };
        if (!responses) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...(result ? { content: answer } : { content: 'Читаю файл.', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] }) }, finish_reason: result ? 'stop' : 'tool_calls' }], usage }), { headers: { 'content-type': 'application/json' } });
        const output = result ? [{ type: 'message', id: `msg-${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [] }] }] : [{ type: 'function_call', id: `fc-${id}`, status: 'completed', call_id: id, name: 'read_file', arguments: JSON.stringify({ path: file }) }];
        return new Response(JSON.stringify({ id: `resp-${id}-${Boolean(result)}`, object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 1000, output_tokens: 12, cost: 0.0001 } }), { headers: { 'content-type': 'application/json' } });
      }
      if (body.model === 'google/gemini-2.5-flash-lite') {
        checked(String(url) === 'https://openrouter.ai/api/v1/chat/completions', 'Title helper must use Chat API.');
        checked(body.max_tokens === 128 && !body.tools?.length && body.reasoning?.enabled === false, 'Title request must stay bounded and disable reasoning.');
        fixture.titleCalls++;
        fixture.calls.push({ kind: 'title', model: body.model, cost: 0.000015 });
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Расходы запросов Luna' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 }, completion_tokens: 12, cost: 0.000015 } }), { headers: { 'content-type': 'application/json' } });
      }
      checked(String(url) === 'https://openrouter.ai/api/v1/responses' && body.model === 'openai/gpt-6-luna', 'Luna must use its exact OpenRouter Responses destination and model identifier.');
      checked(body.reasoning?.effort === 'medium' && body.include?.includes('reasoning.encrypted_content'), 'Luna medium reasoning and encrypted replay must be mapped.');
      const userIndex = body.input.findLastIndex(item => item.role === 'user' && !text(item).startsWith('Workbench local reference snapshot (') && /COST_FIRST|COST_SECOND|Call workbench_echo once/.test(text(item)));
      const userText = text(body.input[userIndex] ?? {});
      const results = body.input.slice(userIndex + 1).filter(item => item.type === 'function_call_output');
      const probe = userText.includes('Call workbench_echo once');
      if (probe) checked(!body.prompt_cache_options && !body.session_id && !JSON.stringify(body).includes('prompt_cache_breakpoint'), 'A bounded one-off connection probe must not pay for cache writes.');
      else {
        checked(body.prompt_cache_options?.mode === 'explicit' && body.prompt_cache_options.ttl === '30m', 'OpenRouter cache mode must follow its explicit-only schema.');
        checked(typeof body.session_id === 'string' && body.session_id.length <= 256, 'Repeated agent calls must carry a stable OpenRouter session ID.');
        checked(!body.input.some(item => item.role === 'assistant' && item.type !== 'message' && Array.isArray(item.content) && item.content.some(part => part.type === 'output_text')), 'Assistant history must use a valid Responses EasyInputMessage string or original provider items.');
      }
      const first = userText.includes('COST_FIRST');
      const id = probe ? 'fixture-probe' : first ? 'fixture-read-first' : 'fixture-read-second';
      let output;
      if (!results.length) {
        if (probe) {
          const value = userText.match(/value (workbench-[\w-]+)/)?.[1];
          checked(Boolean(value), 'Connection probe must supply its nonce.');
          output = [{ type: 'function_call', id: `fc-${id}`, status: 'completed', call_id: id, name: 'workbench_echo', arguments: JSON.stringify({ value }) }];
        } else {
          checked(first || userText.includes('COST_SECOND'), 'Unexpected fixture user request.');
          checked(body.tools.some(tool => tool.name === 'read_file'), 'Read tool schema must be supplied.');
          output = [{ type: 'function_call', id: `fc-${id}`, status: 'completed', call_id: id, name: 'read_file', arguments: JSON.stringify({ path: file }) }];
        }
      } else {
        checked(results.length === 1 && results[0].call_id === id, 'Tool result must match its Responses call ID exactly once.');
        checked(body.input.some(item => item.type === 'function_call' && item.call_id === id), 'Completed tool call must be replayed with its result.');
        if (!probe) checked((typeof results[0].output === 'string' ? results[0].output : (results[0].output ?? []).map(part => part.text ?? '').join('')).includes('export const fixture = 7'), 'Read file output must arrive in the second API call.');
        output = [{ type: 'message', id: `msg-${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: probe ? 'WORKBENCH_READY' : first ? 'Первый запрос: файл прочитан.' : 'Второй запрос: файл прочитан.', annotations: [] }] }];
      }
      if (!probe && first && results.length && fixture.holdFirstFinal) await new Promise(resolve => { fixture.releaseFirstFinal = resolve; });
      const cost = probe ? 0.0001 : first ? results.length ? 0.013 : 0.012 : results.length ? 0.024 : 0.023;
      fixture.calls.push({ kind: probe ? 'probe' : first ? 'first' : 'second', tools: !results.length, cost, model: body.model });
      // Deliberately differs from tariff arithmetic: the UI must trust usage.cost.
      const response = { id: `resp-fixture-${fixture.calls.length}`, object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500, cache_write_tokens: 100 }, output_tokens: 20, total_tokens: 2020, cost } };
      const events = output[0].type === 'message' ? [{ type: 'response.output_text.delta', delta: output[0].content[0].text }, { type: 'response.completed', response }] : [{ type: 'response.completed', response }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
  }, file);

  const source = await page.evaluate(async () => {
    const state = await window.workbench.bootstrap();
    const model = state.models.find(item => item.id === 'openrouter-claude-sonnet-55');
    return window.workbench.saveModel({ ...model, name: 'Sonnet fixture' }, 'deliberately-artificial-model-cost-fixture');
  });
  assert.equal(source.hasKey, true);
  await page.reload(); await page.getByTestId('models-open').waitFor();
  await page.getByTestId('models-open').click();
  await page.getByRole('button', { name: 'Добавить GPT-6 Luna', exact: true }).click();
  assert.equal(await page.getByTestId('model-api-protocol').inputValue(), 'openai-responses');
  assert.equal(await page.getByTestId('model-identifier').inputValue(), 'openai/gpt-6-luna');
  assert.equal(await page.getByTestId('model-credential-source').getAttribute('data-value'), source.id);
  assert.equal(await page.getByTestId('model-api-key').isDisabled(), true);
  assert.equal(await page.getByTestId('model-api-key').inputValue(), '');
  await choose(page, 'model-credential-source', 'Свой ключ или переменная окружения');
  assert.equal(await page.getByTestId('model-api-key').isDisabled(), false);
  await choose(page, 'model-credential-source', 'Sonnet fixture');
  assert.equal(await page.getByTestId('model-api-key').isDisabled(), true);
  await page.getByTestId('model-save').click();
  await page.getByText('Настройки модели сохранены', { exact: true }).waitFor();
  const luna = (await page.evaluate(() => window.workbench.bootstrap())).models.find(item => item.model === 'openai/gpt-6-luna');
  assert.deepEqual({ kind: luna.kind, model: luna.model, contextWindow: luna.contextWindow, input: luna.inputPricePerMillion, output: luna.outputPricePerMillion, credentialModelId: luna.credentialModelId, hasKey: luna.hasKey }, { kind: 'openai-responses', model: 'openai/gpt-6-luna', contextWindow: 1_050_000, input: 0.1, output: 0.5, credentialModelId: source.id, hasKey: true });
  checks.push('Luna-preset-exact-Responses-model-context-prices', 'OpenRouter-credential-source-picker-no-second-key');
  await page.getByTestId('model-test-connection').click();
  await page.getByTestId('model-connection-result').filter({ hasText: 'Подключение работает' }).waitFor();
  checks.push('Responses-connection-probe-tool-nonce-and-result-roundtrip');
  await page.getByRole('button', { name: 'Закрыть окно', exact: true }).click();

  const project = await page.evaluate(root => window.workbench.createProject({ name: 'Luna и расходы', folders: [{ path: root, access: 'read' }], internet: false, commandPolicy: 'ask', instructions: '' }), projectRoot);
  await page.getByRole('button', { name: 'Luna и расходы', exact: true }).click();
  await page.getByTestId('chat-input').waitFor();
  const session = (await page.evaluate(() => window.workbench.bootstrap())).sessions.find(item => item.projectId === project.id);
  await page.evaluate(({ id, modelId }) => window.workbench.updateSession(id, { modelId }), { id: session.id, modelId: luna.id });
  await page.reload(); await page.getByTestId('chat-input').waitFor();
  // A new chat explicitly defaults to Auto; choose Medium to test the effort mapping.
  await choose(page, 'agent-reasoning', 'medium');
  await wait(() => page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.reasoningEffort === 'medium', session.id));
  await page.getByTestId('model-choice').click();
  assert.equal(await page.getByRole('option', { name: 'GPT-6 Luna', exact: true }).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: path.join(runDir, 'Luna-menu.png') });
  await page.getByTestId('model-choice').press('Escape');
  await desktop.evaluate(() => { globalThis.__modelCostFixture.holdFirstFinal = true; });
  await page.getByTestId('chat-input').fill('COST_FIRST Прочитай api.ts и кратко ответь.');
  await page.getByTestId('chat-send').click();
  await wait(() => desktop.evaluate(() => Boolean(globalThis.__modelCostFixture.releaseFirstFinal)));
  const activity = page.getByTestId('activity-disclosure').first();
  await activity.waitFor();
  assert.equal(await page.getByTestId('activity-disclosure').count(), 1);
  assert.equal(await activity.getAttribute('open'), null, 'Activity stays collapsed by default.');
  await page.getByTestId('activity-toggle').first().press('Enter');
  assert.equal(await activity.getAttribute('open'), '');
  await page.getByTestId('activity-result').filter({ hasText: 'export const fixture = 7' }).waitFor();
  assert.match(await page.getByTestId('activity-tool').first().textContent(), /read_file/);
  await activity.evaluate(element => { element.dataset.acceptanceStable = 'kept-open'; });
  await page.screenshot({ path: path.join(runDir, 'activity-running-expanded.png') });
  await desktop.evaluate(() => { const fixture = globalThis.__modelCostFixture; fixture.holdFirstFinal = false; fixture.releaseFirstFinal(); delete fixture.releaseFirstFinal; });
  await wait(() => page.evaluate(async id => { const runs = await window.workbench.listRuns(undefined, id); return runs.some(run => run.kind === 'title' && run.status === 'completed') && runs.some(run => run.kind !== 'title' && run.status === 'completed'); }, session.id));
  assert.equal(await activity.getAttribute('open'), '', 'Expanded activity remains open when the streamed response completes.');
  assert.equal(await activity.getAttribute('data-acceptance-stable'), 'kept-open', 'Activity DOM identity stays stable during the next model step.');
  const finalAnswer = page.getByTestId('assistant-answer').filter({ hasText: 'Первый запрос: файл прочитан.' });
  await finalAnswer.waitFor();
  assert.equal(await finalAnswer.evaluate(element => element.closest('[data-testid="activity-disclosure"]') === null), true, 'Final answer remains outside collapsed activity.');
  await page.getByTestId('activity-toggle').first().press('Space');
  assert.equal(await activity.getAttribute('open'), null);
  assert.equal(await finalAnswer.isVisible(), true);
  checks.push('one-activity-disclosure-default-collapsed-keyboard-toggle', 'tool-result-inside-activity-final-answer-outside', 'expanded-activity-stable-during-next-model-step');
  await page.getByTestId('chat-input').fill('COST_SECOND Ещё раз прочитай api.ts и ответь.');
  await page.getByTestId('chat-send').click();
  await wait(() => page.evaluate(async id => (await window.workbench.listRuns(undefined, id)).filter(run => run.kind !== 'title' && run.status === 'completed').length === 2, session.id));
  await wait(() => page.getByTestId('request-cost').count().then(count => count === 2));
  assert.equal(await page.getByTestId('activity-disclosure').count(), 2, 'Each user request gets one activity disclosure.');
  assert.equal(await page.getByTestId('activity-disclosure').last().getAttribute('open'), null);
  assert.deepEqual(await page.getByTestId('request-cost').allTextContents(), ['Запрос·$0.0250', 'Запрос·$0.0470']);
  assert.equal(await page.getByTestId('chat-total-cost').textContent(), 'Чат · $0.0720');
  assert.match(await page.getByTestId('request-cost').first().getAttribute('title'), /по данным API.*Включая автоматическое название/);
  assert.match(await page.getByTestId('chat-total-cost').getAttribute('title'), /по данным API/);
  const records = await page.evaluate(id => window.workbench.listRuns(undefined, id), session.id);
  const agents = records.filter(run => run.kind !== 'title').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.deepEqual(agents.map(run => ({ status: run.status, steps: run.steps, source: run.usage.costSource })), [{ status: 'completed', steps: 2, source: 'api' }, { status: 'completed', steps: 2, source: 'api' }]);
  await close(agents[0].usage.costUsd, 0.025); await close(agents[1].usage.costUsd, 0.047);
  assert.deepEqual(agents.map(run => ({ input: run.usage.inputTokens, read: run.usage.cacheReadTokens, write: run.usage.cacheWriteTokens })), [{ input: 4000, read: 3000, write: 200 }, { input: 4000, read: 3000, write: 200 }]);
  assert.match(await page.getByTestId('request-cost').last().getAttribute('title'), /чтение из кэша: 3.?000.*запись в кэш: 200/);
  assert.match(await page.getByTestId('request-cost').first().getAttribute('title'), /Вход: 4.?100 токенов; чтение из кэша: 3.?050; запись в кэш: 200/);
  assert.match(await page.getByTestId('chat-total-cost').getAttribute('title'), /Вход: 8.?100 токенов; чтение из кэша: 6.?050; запись в кэш: 400/);
  await close(records.reduce((sum, run) => sum + run.usage.costUsd, 0), 0.072015);
  assert.equal(records.filter(run => run.kind === 'title').length, 1);
  checks.push('Responses-two-user-requests-tool-read-file-and-final', 'request-cost-separate-API-values', 'chat-total-includes-agent-calls-and-light-title', 'OpenRouter-explicit-only-cache-contract-and-one-off-probe');

  await page.reload(); await page.getByTestId('chat-total-cost').filter({ hasText: '$0.0720' }).waitFor();
  assert.deepEqual(await page.getByTestId('request-cost').allTextContents(), ['Запрос·$0.0250', 'Запрос·$0.0470']);
  const persisted = await page.evaluate(id => window.workbench.listRuns(undefined, id), session.id);
  assert.deepEqual(persisted, records);
  const persistedLuna = (await page.evaluate(() => window.workbench.bootstrap())).models.find(item => item.id === luna.id);
  assert.equal(persistedLuna.credentialModelId, source.id); assert.equal(persistedLuna.hasKey, true);
  checks.push('reload-keeps-cost-fields-and-credential-reference-no-snapshot-double-count');
  await page.getByTestId('request-cost').last().click();
  await page.getByTestId('tab-runs').waitFor();
  await page.getByText('Данные API', { exact: true }).waitFor();
  const runFacts = page.locator('.run-detail-facts');
  assert.match(await runFacts.getByTestId('run-cache-read').textContent(), /3.?000/);
  assert.match(await runFacts.getByTestId('run-cache-write').textContent(), /200/);
  assert.match(await runFacts.getByTestId('run-cache-note').textContent(), /Стоимость API уже учитывает кэш/);
  checks.push('request-cost-opens-API-source-journal', 'cached-input-subsets-breakdown-no-double-discount');
  await page.getByRole('button', { name: 'Скрыть файлы', exact: true }).click();
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(runDir, 'request-and-chat-costs.png') });
  await page.getByTestId('activity-toggle').last().press('Enter');
  await page.getByTestId('activity-result').last().filter({ hasText: 'export const fixture = 7' }).waitFor();
  const completedActivity = page.getByTestId('activity-disclosure').last();
  assert.deepEqual(await completedActivity.locator('[data-step-index]').evaluateAll(elements => elements.map(element => element.getAttribute('data-step-index'))), ['1', '2']);
  assert.equal(await completedActivity.getByTestId('activity-step-metadata').count(), 2);
  assert.match(await completedActivity.getByTestId('activity-final-step').textContent(), /Шаг 2.*Итоговый ответ/);
  assert.doesNotMatch(await completedActivity.textContent(), /Второй запрос: файл прочитан\./, 'Final answer text stays outside step metadata.');
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(runDir, 'activity-expanded.png') });
  checks.push('all-journal-steps-in-activity-including-final-step-metadata');
  await page.getByTestId('activity-toggle').last().press('Space');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 700));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.getByTestId('chat-total-cost').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; }), true);
  await page.screenshot({ path: path.join(runDir, 'request-and-chat-costs-small.png') });
  checks.push('cost-controls-small-window-without-overflow');
  const fallback = await page.evaluate(async ({ source, projectId }) => {
    const model = await window.workbench.saveModel({ ...source, id: 'fixture-unknown-chat', name: 'Unknown Chat fixture', kind: 'openai-compatible', baseUrl: 'https://fixture-gateway.invalid/v1', model: 'fixture-compatible', credentialModelId: undefined }, 'deliberately-artificial-model-cost-fixture');
    const session = await window.workbench.createSession(projectId, model.id);
    await window.workbench.updateSession(session.id, { modelId: model.id, title: 'Cross-protocol fixture', titleSource: 'manual', reasoningEffort: 'medium' });
    return session;
  }, { source, projectId: project.id });
  await page.reload();
  await page.getByRole('button', { name: 'Cross-protocol fixture', exact: true }).click();
  await page.getByTestId('chat-input').fill('FALLBACK_CHAT Прочитай api.ts и ответь.');
  await page.getByTestId('chat-send').click();
  await wait(() => page.evaluate(async id => (await window.workbench.listRuns(undefined, id)).some(run => run.status === 'completed'), fallback.id));
  await page.evaluate(({ id, modelId }) => window.workbench.updateSession(id, { modelId }), { id: fallback.id, modelId: luna.id });
  await page.reload(); await page.getByTestId('chat-input').waitFor();
  await page.getByTestId('chat-input').fill('FALLBACK_RESPONSES Прочитай api.ts после смены протокола.');
  await page.getByTestId('chat-send').click();
  await wait(() => page.evaluate(async id => (await window.workbench.listRuns(undefined, id)).filter(run => run.status === 'completed').length === 2, fallback.id));
  const fallbackRuns = await page.evaluate(id => window.workbench.listRuns(undefined, id), fallback.id);
  assert.deepEqual(fallbackRuns.map(run => run.steps), [2, 2]);
  checks.push('unknown-gateway-no-cache-fields', 'Chat-to-Responses-foreign-assistant-fallback-and-paired-result');
  const fixture = await desktop.evaluate(() => globalThis.__modelCostFixture);
  assert.deepEqual(fixture.failures, []); assert.equal(fixture.titleCalls, 1);
  assert.equal(fixture.calls.filter(call => call.kind === 'probe').length, 2);
  assert.equal(fixture.calls.filter(call => call.kind === 'first').length, 2);
  assert.equal(fixture.calls.filter(call => call.kind === 'second').length, 2);
  assert.equal(fixture.calls.filter(call => call.kind === 'cross-protocol').length, 4);
  const report = { checks, paidRequests: 0, fixtureProviderResponses: fixture.calls.length, runDir, costs: { firstAgent: agents[0].usage.costUsd, secondAgent: agents[1].usage.costUsd, title: records.find(run => run.kind === 'title').usage.costUsd, chat: 0.072015 } };
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (desktop) {
    const page = await desktop.firstWindow().catch(() => undefined); await page?.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
    const diagnostic = await desktop.evaluate(() => { const fixture = globalThis.__modelCostFixture; return fixture ? { attempts: fixture.attempts, calls: fixture.calls, failures: fixture.failures } : {}; }).catch(() => ({}));
    await fs.writeFile(path.join(runDir, 'fixture-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
  }
  console.error(JSON.stringify({ runDir, paidRequests: 0 }));
  throw error;
} finally {
  await desktop?.evaluate(() => { const fixture = globalThis.__modelCostFixture; fixture?.releaseFirstFinal?.(); }).catch(() => {});
  await desktop?.close();
}
