import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
// A fresh profile; only an explicitly artificial key is saved. No API calls or real credential/source reads.
const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-lifecycle-'));
const dataDir = path.join(runDir, 'state');
const marker = path.join(runDir, 'shutdown-race.json');
const source = path.join(runDir, 'nonexistent-import-source', '.env');
const env = { ...process.env, WORKBENCH_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV_URL;
const executablePath = process.env.WORKBENCH_EXECUTABLE || undefined;
const args = executablePath ? [] : ['.'];
const nativeUIWait = process.argv.includes('--wait-native-quit');
const ownedChildren = new Set();
const checks = [];
let desktop;
let first;
let local;
let probeCalls = 0;
function exitOf(child, timeout = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); child.kill('SIGKILL'); reject(new Error('Owned Electron process did not exit within the lifecycle deadline.')); }, timeout);
    const onExit = (code, signal) => { cleanup(); resolve({ code, signal }); };
    const onError = () => { cleanup(); reject(new Error('Unable to start the isolated Electron fixture process.')); };
    const cleanup = () => { clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError); };
    child.once('exit', onExit); child.once('error', onError);
  });
}
async function secondInstance(extra = []) {
  const child = spawn(executablePath || first.spawnfile, [...args, ...extra], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  ownedChildren.add(child);
  let output = '';
  const collect = chunk => { if (output.length < 8000) output += String(chunk).slice(0, 8000 - output.length); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const result = await exitOf(child);
  return { ...result, output };
}
async function absent(file) {
  try { await fs.lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function readMarker(file = marker, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(50);
  }
  throw new Error('Shutdown race produced no deterministic fixture result.');
}
try {
  desktop = await electron.launch({ args, executablePath, env, timeout: 30_000 });
  first = desktop.process(); ownedChildren.add(first);
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => Boolean(window.workbench));
  const initial = await page.evaluate(() => window.workbench.bootstrap());
  assert.equal(initial.projects.length, 0); assert.equal(initial.sessions.length, 0);
  assert.ok(initial.models.every(model => !model.hasKey));
  assert.ok(await absent(path.join(dataDir, 'credentials.encrypted.json')));
  checks.push('isolated-first-instance-bootstrap');

  const normal = await secondInstance();
  assert.equal(normal.code, 0, 'A normal second instance must exit successfully.');
  assert.equal(normal.signal, null);
  const afterNormal = await page.evaluate(() => window.workbench.bootstrap());
  assert.equal(afterNormal.version, initial.version);
  assert.equal(first.exitCode, null, 'The first instance must remain alive and responsive.');
  checks.push('second-instance-exits-first-ipc-remains-responsive');

  assert.ok(await absent(source));
  const importing = await secondInstance(['--import-openrouter-env', source]);
  assert.equal(importing.code, 1, 'An import into an already running profile must be refused.');
  assert.equal(importing.signal, null);
  assert.ok(importing.output.includes('закройте запущенное приложение перед импортом ключа'), 'The explicit single-instance guard must reject import before source parsing or bootstrap.');
  assert.ok(!importing.output.includes('не удалось запустить приложение'), 'The importer must not reach its missing-source error path.');
  assert.ok(await absent(path.join(dataDir, 'credentials.encrypted.json')));
  assert.ok(await absent(source));
  await page.evaluate(() => window.workbench.bootstrap());
  checks.push('second-instance-import-refused-before-source-bootstrap-no-vault');

  const exited = exitOf(first);
  // Emit activation in the same main-process turn as before-quit. Save evidence
  // synchronously before stopAll's async quit can close the Inspector connection.
  let inspection;
  try {
    inspection = await desktop.evaluate(({ app, BrowserWindow }, file) => {
      const fs = process.getBuiltinModule('fs');
      const originalCount = BrowserWindow.getAllWindows().length;
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      let created = 0, prevented = false;
      app.on('browser-window-created', () => { created++; });
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      app.emit('activate');
      const result = { originalCount, prevented, createdAfterQuit: created, remainingWindows: BrowserWindow.getAllWindows().length };
      fs.writeFileSync(file, JSON.stringify(result), { mode: 0o600 });
      return result;
    }, marker);
  } catch { /* The fixture file remains authoritative if quit closes Inspector first. */ }
  const recorded = await readMarker();
  if (inspection) assert.deepEqual(inspection, recorded);
  assert.equal(recorded.originalCount, 1); assert.equal(recorded.prevented, true);
  assert.equal(recorded.createdAfterQuit, 0); assert.equal(recorded.remainingWindows, 0);
  const finalExit = await exited;
  assert.equal(finalExit.code, 0); assert.equal(finalExit.signal, null);
  checks.push('shutdown-activation-race-creates-no-window-and-exits');

  // A second, independent quit exercises the real Electron termination path
  // with safeStorage initialized by UI save and the models dialog still open.
  local = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); probeCalls++;
      const value = payload.tools?.length ? payload.messages.at(-1).content.match(/workbench-[a-f0-9-]{36}/i)?.[0] : undefined;
      const message = value ? { content: '', tool_calls: [{ id: 'lifecycle-echo', type: 'function', function: { name: 'workbench_echo', arguments: JSON.stringify({ value }) } }] } : { content: 'WORKBENCH_READY' };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message, finish_reason: value ? 'tool_calls' : 'stop' }] }));
    } catch { response.writeHead(500); response.end('Local lifecycle fixture failed.'); }
  });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  const normalQuit = [];
  for (const method of nativeUIWait ? ['native-ui'] : ['app-quit', 'native-terminate']) {
    desktop = await electron.launch({ args, executablePath, env, timeout: 30_000 });
    first = desktop.process(); ownedChildren.add(first);
    const settingsPage = await desktop.firstWindow();
    await settingsPage.getByTestId('models-open').click();
    await settingsPage.getByTestId('model-api-endpoint').fill(`http://127.0.0.1:${local.address().port}/v1`);
    await settingsPage.getByTestId('model-api-key-env').fill('');
    await settingsPage.getByTestId('model-api-key').fill('workbench-artificial-fixture-key-not-valid-for-any-provider');
    await settingsPage.getByTestId('model-save').click();
    await settingsPage.getByText('Ключ сохранён', { exact: true }).waitFor();
    assert.ok(!(await absent(path.join(dataDir, 'credentials.encrypted.json'))));
    assert.ok((await settingsPage.evaluate(() => window.workbench.bootstrap())).models.some(model => model.hasKey));
    checks.push('artificial-key-saved-through-models-ui');
    await settingsPage.getByTestId('model-test-connection').click();
    await settingsPage.getByTestId('model-connection-result').getByText('Подключение работает', { exact: true }).waitFor();
    assert.equal(probeCalls, normalQuit.length * 2 + 2);
    checks.push('two-request-model-probe-completes-on-local-fixture');
    const normalMarker = path.join(runDir, `${method}.json`);
    const normalExit = exitOf(first, nativeUIWait ? 90_000 : 15_000);
    try {
      await desktop.evaluate(({ app, BrowserWindow, Menu }, { file, method }) => {
        const fs = process.getBuiltinModule('fs');
        const evidence = { events: [], remainingWindows: BrowserWindow.getAllWindows().length };
        const record = (name, event) => {
          evidence.events.push({ name, prevented: Boolean(event?.defaultPrevented) });
          evidence.remainingWindows = BrowserWindow.getAllWindows().length;
          fs.writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 });
        };
        for (const name of ['before-quit', 'window-all-closed', 'will-quit', 'quit']) app.on(name, event => record(name, event));
        for (const window of BrowserWindow.getAllWindows()) { window.on('close', event => record('window-close', event)); window.on('closed', () => record('window-closed')); }
        record(`${method}-requested`);
        if (method === 'native-terminate') Menu.sendActionToFirstResponder('terminate:'); else if (method === 'app-quit') app.quit();
      }, { file: normalMarker, method });
    } catch { /* Actual termination can close Inspector before the evaluate response. */ }
    if (nativeUIWait) console.log(JSON.stringify({ READY: true, fixturePid: first.pid, executablePath, stageFile: normalMarker }));
    let quit;
    try { quit = await normalExit; }
    catch (error) { console.log(JSON.stringify({ normalQuit: await readMarker(normalMarker) })); throw error; }
    const normalRecorded = await readMarker(normalMarker);
    assert.equal(quit.code, 0); assert.equal(quit.signal, null);
    assert.ok(normalRecorded.events.some(event => event.name === 'will-quit'));
    assert.ok(normalRecorded.events.some(event => event.name === 'quit'));
    checks.push(`${method}-after-encrypted-key-save-probe-and-open-models-dialog`);
    normalQuit.push({ method, exitCode: quit.code, signal: quit.signal, ...normalRecorded });
  }
  const report = { passed: checks, shutdown: recorded, normalQuit };
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (desktop && first?.exitCode === null && first?.signalCode === null) await desktop.close().catch(() => undefined);
  for (const child of ownedChildren) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (local) { local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); }
  await fs.rm(runDir, { recursive: true, force: true });
}
