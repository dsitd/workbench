import test from 'node:test';
import assert from 'node:assert/strict';
import { PiTraceCapture } from '../../scripts/harness-pilot/pi-trace';

test('Pi progress above the old 2 MB ceiling does not hide final status or tool counts', () => {
  const capture = new PiTraceCapture();
  const progress = JSON.stringify({ type: 'tool_execution_update', result: 'x'.repeat(200_000) }) + '\n';
  for (let i = 0; i < 15; i++) capture.write(Buffer.from(progress));
  capture.write(Buffer.from(JSON.stringify({ type: 'tool_execution_end', isError: false }) + '\n'));
  const final = Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: 'Готово' } }) + '\n');
  for (const byte of final) capture.write(Buffer.from([byte]));
  capture.end();
  assert.equal(capture.lastAssistant?.stopReason, 'stop');
  assert.equal(capture.toolCalls, 1);
  assert.equal(capture.steps, 1);
  assert.equal(capture.droppedProgress, 15);
  assert.match(capture.text(), /Готово/);
  assert.equal(capture.text().split('\n').filter(Boolean).length, 2);
  assert.equal(capture.truncated, false);
});

test('an archival cap is explicit and never changes live terminal-event accounting', () => {
  const capture = new PiTraceCapture(10);
  capture.write(Buffer.from(JSON.stringify({ type: 'tool_execution_end', isError: true }) + '\n'));
  capture.write(Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })));
  capture.end(); capture.end();
  assert.equal(capture.truncated, true);
  assert.equal(capture.lastAssistant?.stopReason, 'stop');
  assert.equal(capture.steps, 1);
  assert.equal(capture.toolErrors, 1);
});
