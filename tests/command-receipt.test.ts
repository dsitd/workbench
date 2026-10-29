import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../src/backend/processes';

test('process receipts distinguish observed exits from timeout, cancellation and signal death', async t => {
  const manager = new ProcessManager(() => {}, value => value);
  t.after(() => manager.close());
  for (const mode of ['exit', 'timeout', 'cancel', 'signal'] as const) {
    const abort = new AbortController();
    const result = manager.start({ projectId: 'p', sessionId: 's', command: 'synthetic fixture', cwd: '/private/tmp', background: false,
      executable: '/bin/sh', args: ['-c', mode === 'exit' ? 'exit 7' : mode === 'signal' ? 'kill -TERM $$' : 'sleep 3'],
      env: { PATH: '/usr/bin:/bin' }, timeoutMs: mode === 'timeout' ? 30 : 5000, signal: abort.signal, cleanup: async () => {} });
    if (mode === 'cancel') abort.abort();
    assert.equal((await result.completion).exitObserved, mode === 'exit', mode);
  }
});
