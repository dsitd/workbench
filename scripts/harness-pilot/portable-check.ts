import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sandboxAvailable } from '../../src/backend/sandbox';
import { runWorkbench } from './workbench';
import { benchmarkTemp, pythonExecutable, ready, shellQuote } from './platform';

/** Real runtime, edits and OS commands; every model response is a local fixture. */
async function main() {
  await ready();
  if (!(await sandboxAvailable())) throw new Error('Native sandbox unavailable. macOS requires sandbox-exec; Linux requires Bubblewrap and permitted user namespaces.');
  const root = await mkdtemp(path.join(benchmarkTemp, 'workbench-portable-check-'));
  const project = path.join(root, 'project'), state = path.join(root, 'state');
  await mkdir(project);
  const file = path.join(project, 'answer.py');
  await writeFile(file, 'def answer():\n    return 0\n');
  const command = `${shellQuote(pythonExecutable)} -B -c 'from answer import answer; assert answer() == 42'`;
  const steps = [
    { name: 'read_file', arguments: { path: file } },
    { name: 'edit_file', arguments: { path: file, oldText: 'return 0', newText: 'return 42' } },
    { name: 'run_command', arguments: { command } },
  ];
  let requests = 0;
  const failures: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(!body.messages.some((message: any) => message.role === 'tool' && /Error:|Command failed/.test(message.content)));
      const step = steps[requests++];
      const message = step ? { role: 'assistant', content: '', tool_calls: [{ id: `fixture-${requests}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
        : { role: 'assistant', content: 'Implemented answer() = 42 and verified the result.' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } }));
    } catch { failures.push('Local protocol assertion failed'); res.writeHead(500).end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await runWorkbench(project, state, `http://127.0.0.1:${port}/v1`, 'Read answer.py, implement answer() = 42, and run the verification command.', command, false,
      false, 0.30, 60_000);
    assert.deepEqual(failures, []);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.toolErrors, 0);
    assert.equal(result.toolCalls, 4); // Three model tools plus the runtime's automatic verification.
    assert.equal(result.verification, 'passed');
    assert.equal(requests, 4);
    assert.match(await readFile(file, 'utf8'), /return 42/);
    const report = { platform: process.platform, arch: process.arch, costUsd: 0, requests, ...result };
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: 'passed', platform: process.platform, report: path.join(root, 'report.json'), requests, toolCalls: result.toolCalls, costUsd: 0 }));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
