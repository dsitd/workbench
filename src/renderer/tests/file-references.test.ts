import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileReference } from '../file-references';

test('file references quote paths with spaces and keep the exact inclusive range inside quotes', () => {
  assert.equal(fileReference({ id: 'pin', path: '/fixture/my project/src/app.ts', startLine: 1, endLine: 10 }), '@file:"/fixture/my project/src/app.ts#L1-L10"');
  assert.equal(fileReference({ id: 'pin', path: '/fixture/app.ts', startLine: 5, endLine: 5 }), '@file:"/fixture/app.ts#L5"');
  assert.equal(fileReference({ id: 'pin', path: '/fixture/app.ts' }), '@file:"/fixture/app.ts"');
});

test('file references preserve quote characters rather than changing the selected path', () => {
  assert.equal(fileReference({ id: 'pin', path: '/fixture/a"b.ts' }), '@file(\'/fixture/a"b.ts\')');
  assert.equal(fileReference({ id: 'pin', path: '/fixture/a"b\'c.ts' }), undefined);
});
