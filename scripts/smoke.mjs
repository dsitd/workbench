import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const runDir = path.resolve('.workbench', 'acceptance', randomUUID());
const chooseComposerOption = async (page, testId, label) => {
  await page.getByTestId(testId).click();
  await page.getByRole('listbox').getByRole('option', { name: label, exact: true }).click();
};
const projectRoot = path.join(runDir, 'project');
const readOnlyRoot = path.join(runDir, 'reference');
await fs.mkdir(projectRoot, { recursive: true });
await fs.mkdir(readOnlyRoot, { recursive: true });
await fs.writeFile(path.join(projectRoot, 'hello.ts'), 'export const greeting = "Hello";\n');
await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), '# Project rules\nPreserve the exported greeting name.\n');
await fs.writeFile(path.join(readOnlyRoot, 'reference.txt'), 'Read-only fixture.\n');
const imagePath = path.join(runDir, 'sample.png');
await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=', 'base64'));

let requests = 0;
let probeRequests = 0;
let probe;
const probeReasoning = [{ type: 'reasoning.encrypted', id: 'probe-thinking', data: 'fixture-probe-data', format: 'anthropic-claude-v1', index: 0 }];
const readReasoning = [{ type: 'reasoning.encrypted', id: 'read-thinking', data: 'fixture-read-data', format: 'anthropic-claude-v1', index: 0 }];
const editReasoning = [{ type: 'reasoning.encrypted', id: 'edit-thinking', data: 'fixture-edit-data', format: 'anthropic-claude-v1', index: 0 }];
const mockErrors = [];
let commandTask = false;
let mcpTask = false;
let modeTask;
let mcpCalls = 0;
const mcpMethods = [];
const server = http.createServer(async (request, response) => {
  try {
  if (request.url === '/mcp' && request.method !== 'POST') {
    response.writeHead(405); response.end(); return;
  }
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  if (request.url === '/mcp') {
    mcpMethods.push(payload.method);
    if (payload.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (payload.method === 'initialize') result = { protocolVersion: payload.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Workbench MCP fixture', version: '1' } };
    else if (payload.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Local acceptance echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    else if (payload.method === 'tools/call') {
      assert.equal(payload.params.name, 'echo');
      assert.deepEqual(payload.params.arguments, { text: 'MCP_WORKBENCH_OK' });
      mcpCalls++;
      result = { content: [{ type: 'text', text: payload.params.arguments.text }] };
    } else throw new Error(`Unexpected local MCP method: ${payload.method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })); return;
  }
  const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('');
  const messages = payload.messages.filter(message => !(message.role === 'user' && text(message).startsWith('Workbench local reference snapshot (')));
  const latest = messages.at(-1);
  const lastAssistant = [...messages].reverse().find(item => item.tool_calls?.length);
  const echoTool = payload.tools?.find(tool => tool.function?.name === 'workbench_echo');
  const echoReply = latest?.role === 'tool' && lastAssistant?.tool_calls.some(call => call.function?.name === 'workbench_echo');
  let result;
  if (echoTool || echoReply) {
    probeRequests++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(payload.model, 'fixture-model');
    assert.ok(payload.max_tokens > 0 && payload.max_tokens <= 512, 'Connection probe must bound its output independently of model settings.');
    assert.equal(body.includes(projectRoot), false, 'Connection probe must not contain project paths.');
    assert.equal(body.includes(readOnlyRoot), false);
    assert.equal(body.includes('hello.ts'), false, 'Connection probe must not contain project history.');
    assert.equal(body.includes('Preserve the exported greeting name.'), false, 'Connection probe must not contain project rules.');
    if (echoTool) {
      assert.equal(probe, undefined, 'Only one connection check is expected.');
      assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
      assert.equal(payload.tools.length, 1);
      const nonce = messages[1].content.match(/workbench-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)?.[0];
      assert.ok(nonce, 'Probe must carry its unique nonce in the user message.');
      probe = { nonce, toolCallId: `probe-${randomUUID()}`, complete: false };
      result = { content: '', reasoning_details: probeReasoning, tool_calls: [{ id: probe.toolCallId, type: 'function', function: { name: 'workbench_echo', arguments: JSON.stringify({ value: nonce }) } }] };
    } else {
      assert.ok(probe && !probe.complete, 'Tool reply must follow the probe tool call.');
      assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
      assert.equal(payload.tools?.length ?? 0, 0);
      assert.equal(messages[2].tool_calls.length, 1);
      assert.equal(messages[2].tool_calls[0].id, probe.toolCallId);
      assert.equal(messages[2].tool_calls[0].function.name, 'workbench_echo');
      assert.deepEqual(messages[2].reasoning_details, probeReasoning);
      assert.equal(JSON.parse(messages[2].tool_calls[0].function.arguments).value, probe.nonce);
      assert.equal(latest.tool_call_id, probe.toolCallId, 'Tool result must preserve the provider call ID.');
      assert.equal(JSON.parse(latest.content).value, probe.nonce);
      probe.complete = true;
      result = { content: 'WORKBENCH_READY' };
    }
  } else {
  requests++;
  if (modeTask === 'plan') {
    const names = payload.tools.map(item => item.function.name);
    assert.ok(names.includes('read_file'));
    assert.equal(names.some(name => ['write_file', 'edit_file', 'run_command'].includes(name) || name.startsWith('mcp_')), false, 'Plan must expose only local read and internet research tools.');
    result = { content: 'План: прочитать hello.ts, согласовать изменение и переключить режим для выполнения.' };
  }
  else if (modeTask === 'ask') {
    if (latest?.role === 'user') result = { content: 'Запрашиваю чтение файла.', tool_calls: [{ id: 'ask-read-call', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(projectRoot, 'hello.ts') }) } }] };
    else {
      assert.equal(latest.tool_call_id, 'ask-read-call');
      assert.match(latest.content, /отклон|declin|не разреш|не выполн/i);
      result = { content: 'Чтение отклонено; действие не выполнено.' };
    }
  }
  else if (mcpTask) {
    const tool = payload.tools.find(item => item.function.name.startsWith('mcp_'));
    assert.ok(tool, 'The current project must receive its enabled MCP tool.');
    if (latest?.role === 'user') result = { content: 'Вызываю выбранный MCP-инструмент.', reasoning_details: readReasoning, tool_calls: [{ id: 'mcp-fixture-call', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ text: 'MCP_WORKBENCH_OK' }) } }] };
    else {
      assert.equal(latest.role, 'tool'); assert.equal(latest.tool_call_id, 'mcp-fixture-call');
      assert.equal(latest.content, 'MCP_WORKBENCH_OK');
      assert.deepEqual(lastAssistant.reasoning_details, readReasoning);
      result = { content: 'MCP_WORKBENCH_OK: инструмент выполнился после разрешения.' };
    }
  }
  else if (commandTask) result = latest?.role === 'user' ? {
    content: 'Проверяю команду с разрешением.',
    tool_calls: [{ id: `command-${requests}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `printf '%s' 'approval fixture' > '${path.join(projectRoot, 'approved.txt')}'` }) } }],
  } : { content: 'Команда выполнена после разрешения.' };
  else if (latest?.role === 'user') result = {
    content: 'Проверяю исходный файл.',
    reasoning_details: readReasoning,
    tool_calls: [{ id: `read-${requests}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(projectRoot, 'hello.ts') }) } }],
  };
  else {
    if (lastAssistant?.tool_calls[0]?.function.name === 'read_file') {
      assert.deepEqual(lastAssistant.reasoning_details, readReasoning);
      result = {
        content: 'Вношу проверяемую правку.', reasoning_details: editReasoning,
        tool_calls: [{ id: `edit-${requests}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: path.join(projectRoot, 'hello.ts'), oldText: '"Hello"', newText: '"Привет"' }) } }],
      };
    } else {
      assert.deepEqual(lastAssistant.reasoning_details, editReasoning);
      result = { content: 'Готово: значение greeting изменено на «Привет». Правка сохранена и доступна в панели изменений.' };
    }
  }
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', ...result }, finish_reason: result.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
  } catch (error) {
    mockErrors.push(error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Local acceptance contract failed.' }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(runDir, 'state') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV_URL;
let desktop;
const launchOptions = { args: process.env.WORKBENCH_EXECUTABLE ? [] : ['.'], executablePath: process.env.WORKBENCH_EXECUTABLE || undefined, env, timeout: 30_000 };
const checks = [];
async function waitFor(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Acceptance condition timed out.');
}
try {
  desktop = await electron.launch(launchOptions);
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => Boolean(window.workbench));
  await page.getByTestId('project-create').first().waitFor();
  checks.push('desktop-start');
  const fresh = await page.evaluate(() => window.workbench.bootstrap());
  const seededSonnet = fresh.models.find(model => model.id === 'openrouter-claude-sonnet-55');
  assert.ok(seededSonnet, 'Fresh installs must expose the requested Claude provider.');
  assert.equal(seededSonnet.kind, 'openai-compatible');
  assert.equal(seededSonnet.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(seededSonnet.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(seededSonnet.contextWindow, 1_000_000);
  assert.equal(seededSonnet.maxOutputTokens, 8192);
  assert.equal(seededSonnet.vision, true);
  checks.push('fresh-install-openrouter-claude-sonnet-preset');
  await desktop.evaluate(({ dialog }, folders) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: folders });
  }, [projectRoot, readOnlyRoot]);
  await page.getByTestId('project-create').first().click();
  await page.getByRole('button', { name: 'Выбрать папки на Mac' }).click();
  await page.getByTestId('project-name').fill('Проверка системы');
  await page.getByLabel(`Права для ${readOnlyRoot}`).selectOption('read');
  await page.screenshot({ path: path.join(runDir, 'project.png') });
  await page.getByTestId('project-save').click();
  await page.getByTestId('chat-input').waitFor();
  const initial = await page.evaluate(() => window.workbench.bootstrap());
  const project = initial.projects[0]; const session = initial.sessions[0];
  assert.equal(project.folders.length, 2);
  assert.equal(project.folders[1].access, 'read');
  await page.screenshot({ path: path.join(runDir, 'home.png') });
  checks.push('project-created-through-ui');

  await page.getByTestId('models-open').click();
  assert.equal(await page.getByTestId('model-api-endpoint').inputValue(), seededSonnet.baseUrl);
  assert.equal(await page.getByTestId('model-identifier').inputValue(), seededSonnet.model);
  await page.getByTestId('model-preset-openrouter-claude-opus-55').click();
  assert.equal(await page.getByTestId('model-display-name').inputValue(), 'Claude Opus 5.5');
  assert.equal(await page.getByTestId('model-api-protocol').inputValue(), 'openai-compatible');
  assert.equal(await page.getByTestId('model-api-endpoint').inputValue(), 'https://openrouter.ai/api/v1');
  assert.equal(await page.getByTestId('model-identifier').inputValue(), 'anthropic/claude-opus-5.5');
  assert.equal(await page.getByTestId('model-api-key-env').inputValue(), 'OPENROUTER_API_KEY');
  assert.equal(await page.getByLabel('Контекст модели, токенов', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('Максимальный ответ, токенов', { exact: true }).inputValue(), '8192');
  assert.equal(await page.getByLabel('Модель поддерживает изображения', { exact: true }).isChecked(), true);
  assert.equal(await page.getByTestId('model-test-connection').isDisabled(), true, 'A provider draft must be saved before testing it.');
  assert.equal((await page.evaluate(() => window.workbench.bootstrap())).models.some(item => item.model === 'anthropic/claude-opus-5.5'), false, 'Choosing a preset must not persist or call its provider.');
  checks.push('openrouter-opus-preset-draft-through-ui');
  await page.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await page.getByLabel('Название в приложении', { exact: true }).fill('Локальный тест API');
  await page.getByLabel('Адрес API', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel('Идентификатор модели', { exact: true }).fill('fixture-model');
  await page.getByLabel('Имя переменной окружения', { exact: true }).fill('');
  await page.getByLabel('Контекст модели, токенов', { exact: true }).fill('32000');
  await page.getByLabel('Максимальный ответ, токенов', { exact: true }).fill('2000');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByText('Настройки модели сохранены', { exact: true }).waitFor();
  await page.getByTestId('model-test-connection').click();
  await page.getByTestId('model-connection-result').filter({ hasText: 'Подключение работает' }).waitFor();
  await waitFor(() => page.evaluate(() => {
    const result = document.querySelector('[data-testid="model-connection-result"]')?.getBoundingClientRect();
    const detail = document.querySelector('.dialog-detail')?.getBoundingClientRect();
    return Boolean(result && detail && result.top >= detail.top - 1 && result.bottom <= detail.bottom + 1);
  }), 2000);
  assert.equal(mockErrors.length, 0, mockErrors[0]?.message);
  assert.equal(probeRequests, 2);
  assert.equal(probe?.complete, true);
  assert.equal(requests, 0, 'Connection checks must stay separate from project tasks.');
  const afterProbe = await page.evaluate(id => window.workbench.getMessages(id), session.id);
  assert.equal(afterProbe.length, 0, 'Connection checks must not append to project chat history.');
  await page.screenshot({ path: path.join(runDir, 'models.png') });
  checks.push('model-connection-tool-roundtrip-through-ui');
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  const model = (await page.evaluate(() => window.workbench.bootstrap())).models.find(item => item.model === 'fixture-model');
  assert.ok(model);
  await chooseComposerOption(page, 'model-choice', model.name);
  await waitFor(() => page.evaluate(async ({ id, modelId }) => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.modelId === modelId, { id: session.id, modelId: model.id }));
  await page.getByTestId('chat-input').fill('Исправь приветствие в hello.ts на Привет.');
  await page.getByTestId('chat-send').click();
  await waitFor(() => page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.match(await fs.readFile(path.join(projectRoot, 'hello.ts'), 'utf8'), /Привет/);
  assert.equal(requests, 3);
  const messages = await page.evaluate(id => window.workbench.getMessages(id), session.id);
  assert.equal(messages.filter(message => message.role === 'tool').length, 2);
  assert.deepEqual(messages.find(message => message.toolCalls?.[0]?.name === 'read_file')?.reasoningDetails, readReasoning);
  assert.deepEqual(messages.find(message => message.toolCalls?.[0]?.name === 'edit_file')?.reasoningDetails, editReasoning);
  checks.push('own-agent-http-read-edit-complete');

  await page.getByTestId('tab-changes').click();
  await page.getByText('Отменить эту правку', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(runDir, 'workspace.png') });
  await page.getByRole('button', { name: 'Отменить эту правку' }).click();
  await page.getByRole('button', { name: 'Вернуть', exact: true }).click();
  await waitFor(() => page.evaluate(async ({ projectId, file }) => (await window.workbench.readFile(projectId, file)).content.includes('Hello'), { projectId: project.id, file: path.join(projectRoot, 'hello.ts') }));
  checks.push('diff-and-undo-through-ui');

  commandTask = true;
  await page.getByTestId('chat-input').fill('Выполни контрольную команду в папке проекта.');
  await page.getByTestId('chat-send').click();
  await page.getByRole('heading', { name: 'Разрешение на действие' }).waitFor();
  await assert.rejects(fs.readFile(path.join(projectRoot, 'approved.txt')), { code: 'ENOENT' });
  await page.reload();
  await page.getByRole('heading', { name: 'Разрешение на действие' }).waitFor();
  await page.screenshot({ path: path.join(runDir, 'approval.png') });
  await page.getByRole('button', { name: 'Разрешить', exact: true }).click();
  await waitFor(async () => requests === 5 && await page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.equal(await fs.readFile(path.join(projectRoot, 'approved.txt'), 'utf8'), 'approval fixture');
  checks.push('command-approval-survives-reload-and-executes');

  await page.getByTestId('skills-open').click();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('project-review');
  await page.getByLabel('Описание и когда применять', { exact: true }).fill('Review TypeScript greeting changes');
  await page.getByLabel('Редактор SKILL.md', { exact: true }).fill('# Review\nRead the diff and check exported names.\n');
  await page.getByRole('button', { name: 'Сохранить skill', exact: true }).click();
  await page.getByText('Skill сохранён', { exact: true }).waitFor();
  await page.getByText('project-review', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(runDir, 'skills.png') });
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  const skill = (await page.evaluate(() => window.workbench.bootstrap())).skills.find(item => item.name === 'project-review');
  assert.match(await page.evaluate(id => window.workbench.readSkill(id), skill.id), /Review/);
  checks.push('skills-created-and-listed-through-ui');

  await page.getByRole('button', { name: 'Интернет включён', exact: true }).click();
  await page.getByTestId('rules-open').click();
  await page.getByLabel('Документ правил').selectOption(path.join(projectRoot, 'AGENTS.md'));
  const updatedRules = '# Project rules\nPreserve the exported greeting name.\nUse explicit TypeScript exports.\n';
  await page.getByLabel('Содержимое AGENTS.md', { exact: true }).fill(updatedRules);
  await page.getByRole('button', { name: 'Сохранить правила', exact: true }).click();
  await page.getByText('Правила сохранены в AGENTS.md', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'), updatedRules);
  await page.screenshot({ path: path.join(runDir, 'rules.png') });
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  checks.push('project-rules-edited-through-ui');

  await page.getByTestId('mcp-open').click();
  await page.getByTestId('mcp-new').click();
  await page.getByTestId('mcp-name').fill('Локальный MCP тест');
  await page.getByTestId('mcp-transport').selectOption('http');
  await page.getByTestId('mcp-url').fill(`http://127.0.0.1:${port}/mcp`);
  await page.getByTestId('mcp-enabled').check();
  await page.getByTestId(`mcp-project-${project.id}`).check();
  await page.getByTestId('mcp-save').click();
  await page.getByText('Настройки сохранены. Подключение запускается отдельной кнопкой.', { exact: true }).waitFor();
  assert.equal(mcpMethods.length, 0, 'Saving MCP settings must not contact the server.');
  await page.getByTestId('mcp-test-project').selectOption(project.id);
  await page.getByTestId('mcp-test').click();
  await page.getByTestId('mcp-test-result').filter({ hasText: 'Подключение проверено' }).waitFor();
  assert.equal(await page.getByTestId('mcp-tool-echo').isChecked(), false, 'New tools require explicit enablement.');
  assert.equal(mcpCalls, 0, 'Discovery must not execute a server tool.');
  await page.screenshot({ path: path.join(runDir, 'mcp.png') });
  await page.getByTestId('mcp-tool-echo').check();
  await page.getByTestId('mcp-save').click();
  await page.getByText('Настройки сохранены. Подключение запускается отдельной кнопкой.', { exact: true }).waitFor();
  const configuredMcp = (await page.evaluate(() => window.workbench.bootstrap())).mcpServers[0];
  assert.deepEqual(configuredMcp.enabledTools, ['echo']);
  assert.deepEqual(configuredMcp.projectIds, [project.id]);
  assert.equal(configuredMcp.hasToken, false);
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  checks.push('mcp-settings-discovery-and-manual-tool-enable-through-ui');

  mcpTask = true;
  await page.getByTestId('chat-input').fill('Вызови выбранный MCP echo с текстом MCP_WORKBENCH_OK.');
  await page.getByTestId('chat-send').click();
  await page.getByRole('heading', { name: 'Разрешение на действие' }).waitFor();
  assert.equal(mcpCalls, 0, 'Even read-only-hinted MCP calls must await approval.');
  await page.getByText(/Arguments:.*MCP_WORKBENCH_OK/).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Разрешение на действие' }).waitFor();
  await page.getByRole('button', { name: 'Разрешить', exact: true }).click();
  await waitFor(async () => requests === 7 && await page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.equal(mcpCalls, 1);
  const mcpMessages = await page.evaluate(id => window.workbench.getMessages(id), session.id);
  assert.equal(mcpMessages.find(message => message.toolCallId === 'mcp-fixture-call')?.content, 'MCP_WORKBENCH_OK');
  checks.push('mcp-approved-agent-tool-roundtrip-survives-renderer-reload');

  await chooseComposerOption(page, 'agent-mode', 'План');
  await waitFor(() => page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.mode === 'plan', session.id));
  modeTask = 'plan';
  await page.getByTestId('chat-input').fill('Подготовь план изменения приветствия.');
  await page.getByTestId('chat-send').click();
  await waitFor(async () => requests === 8 && await page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.match(await fs.readFile(path.join(projectRoot, 'hello.ts'), 'utf8'), /Hello/);
  assert.equal(mcpCalls, 1);
  checks.push('plan-mode-exposes-readonly-tools-without-side-effects');

  await chooseComposerOption(page, 'agent-mode', 'Каждое действие');
  await waitFor(() => page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.mode === 'ask', session.id));
  modeTask = 'ask';
  await page.getByTestId('chat-input').fill('Прочитай hello.ts только после моего разрешения.');
  await page.getByTestId('chat-send').click();
  await page.getByRole('heading', { name: 'Разрешение на действие' }).waitFor();
  assert.equal(await page.getByTestId('agent-mode').isDisabled(), true);
  await assert.rejects(page.evaluate(id => window.workbench.updateSession(id, { mode: 'bypass' }), session.id), /останов|режим/i);
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await waitFor(async () => requests === 10 && await page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.equal((await page.evaluate(id => window.workbench.getMessages(id), session.id)).find(item => item.toolCallId === 'ask-read-call')?.error, true);
  checks.push('ask-mode-read-approval-decline-and-active-mode-lock');

  await chooseComposerOption(page, 'agent-mode', 'Без подтверждений');
  await waitFor(() => page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.mode === 'bypass', session.id));
  modeTask = 'bypass';
  await page.getByTestId('chat-input').fill('Выполни echo MCP_WORKBENCH_OK без запросов подтверждения.');
  await page.getByTestId('chat-send').click();
  await waitFor(async () => requests === 12 && await page.evaluate(async id => (await window.workbench.bootstrap()).sessions.find(item => item.id === id)?.status === 'completed', session.id));
  assert.equal(mcpCalls, 2);
  assert.equal((await page.evaluate(() => window.workbench.bootstrap())).approvals.length, 0);
  await page.screenshot({ path: path.join(runDir, 'modes.png') });
  checks.push('bypass-mode-executes-enabled-mcp-without-prompts');

  const imported = await page.evaluate(paths => window.workbench.importImages(paths), Array(12).fill(imagePath));
  assert.equal(imported.length, 12);
  assert.match(await page.evaluate(id => window.workbench.resolveAttachment(id), imported[0].id), /^data:image\/png;base64,/);
  checks.push('unlimited-count-image-import');
  await desktop.evaluate(({ dialog }, images) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: images });
  }, Array(12).fill(imagePath));
  await page.getByRole('button', { name: 'Добавить изображения', exact: true }).click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.draft-attachments img')];
    return images.length === 12 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  await page.getByRole('button', { name: 'Открыть sample.png', exact: true }).first().click();
  await page.locator('.image-lightbox img').waitFor();
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  checks.push('image-previews-and-lightbox-through-ui');
  let denied = false;
  try { await page.evaluate(({ id, file }) => window.workbench.writeFile(id, file, 'Forbidden'), { id: project.id, file: path.join(readOnlyRoot, 'reference.txt') }); }
  catch { denied = true; }
  assert.equal(denied, true);
  assert.equal(await fs.readFile(path.join(readOnlyRoot, 'reference.txt'), 'utf8'), 'Read-only fixture.\n');
  checks.push('readonly-root-enforced');
  const context = await page.evaluate(id => window.workbench.getContext(id), session.id);
  assert.ok(context.estimatedTokens <= context.budget);
  checks.push('context-budget-report');
  const persistedMessages = await page.evaluate(id => window.workbench.getMessages(id), session.id);
  await page.reload();
  await page.getByTestId('chat-input').waitFor();
  assert.equal((await page.evaluate(id => window.workbench.getMessages(id), session.id)).length, persistedMessages.length);
  checks.push('renderer-reload-persistence');
  await desktop.close();
  desktop = await electron.launch(launchOptions);
  const restarted = await desktop.firstWindow();
  restarted.setDefaultTimeout(15_000);
  await restarted.getByTestId('chat-input').waitFor();
  const restored = await restarted.evaluate(() => window.workbench.bootstrap());
  assert.equal(restored.projects[0].id, project.id);
  assert.equal(restored.sessions[0].status, 'completed');
  assert.equal(restored.sessions[0].mode, 'bypass');
  assert.equal(await restarted.getByTestId('agent-mode').getAttribute('data-value'), 'bypass');
  const restoredMessages = await restarted.evaluate(id => window.workbench.getMessages(id), session.id);
  assert.deepEqual(restoredMessages, JSON.parse(JSON.stringify(persistedMessages)), 'Restart must preserve message content, reasoning blocks and tool results in the JSON storage contract.');
  assert.equal(restored.skills.length, 1);
  assert.deepEqual(restored.models.find(item => item.id === model.id), model, 'Restart must preserve the saved local model without replacing it with a provider preset.');
  assert.deepEqual(restored.models.find(item => item.id === seededSonnet.id), seededSonnet);
  assert.deepEqual(restored.mcpServers[0], JSON.parse(JSON.stringify(configuredMcp)));
  assert.equal((await restarted.evaluate(({ serverId, projectId }) => window.workbench.getMcpStatus(serverId, projectId), { serverId: configuredMcp.id, projectId: project.id })).connected, false, 'Restart restores configuration without automatically launching MCP connections.');
  assert.equal(mcpCalls, 2);
  checks.push('application-restart-persistence');
  checks.push('mcp-restart-configuration-without-auto-connect');
  checks.push('agent-mode-restart-persistence');
  assert.equal(mockErrors.length, 0, mockErrors[0]?.message);
  assert.equal(probeRequests, 2);
  const report = { passed: checks, runDir, requests, probeRequests, mcpCalls, mcpMethods };
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (desktop) await desktop.close();
  await new Promise(resolve => server.close(resolve));
}
