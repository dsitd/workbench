import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sandboxAvailable } from '../../src/backend/sandbox';
import { benchmarkSandbox } from '../../scripts/harness-pilot/isolated-process';
import { nodeExecutable, runtimeRoots } from '../../scripts/harness-pilot/platform';

test('native benchmark sandbox reaches only its local gateway, including a long state path', async t => {
  if (!(await sandboxAvailable())) { t.skip('Native sandbox required; sandbox:check is mandatory in CI.'); return; }
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'wb-portable-network-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const state = path.join(base, 'long-state-'.repeat(15));
  await mkdir(state);
  const gateway = createServer((_req, res) => res.end('local-fixture'));
  const forbidden = createServer((_req, res) => res.end('must-not-reach'));
  for (const server of [gateway, forbidden]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  }
  const port = (gateway.address() as { port: number }).port;
  const deniedPort = (forbidden.address() as { port: number }).port;
  const script = `const http = require('node:http');
    const get = port => new Promise((resolve, reject) => {
      const request = http.get('http://127.0.0.1:' + port, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      request.setTimeout(2000, () => request.destroy(new Error('timeout'))); request.on('error', reject);
    });
    (async () => {
      if (await get(${port}) !== 200) process.exit(2);
      try { await get(${deniedPort}); process.exit(3); } catch {}
      console.log('isolated-gateway-ok');
    })().catch(() => process.exit(4));`;
  const launch = await benchmarkSandbox({ roots: runtimeRoots, temporary: state, internet: false, localhostPort: port }, nodeExecutable, ['-e', script]);
  t.after(launch.cleanup);
  const result = await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(launch.executable, launch.args, { cwd: state, env: { PATH: '/usr/bin:/bin', HOME: state, TMPDIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, output: 'launch failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /isolated-gateway-ok/);
});
