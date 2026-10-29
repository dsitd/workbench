import test from 'node:test';
import assert from 'node:assert/strict';
import { connectFiles, rankConnectedFiles, sourceFacts } from '../src/backend/code-graph';
import type { ProjectMapFile } from '../src/shared/types';

test('AST maps extract typed signatures and imports without copying bodies, initializers or literal types', () => {
  const facts = sourceFacts('/project/api.ts', `import { value } from './value.js';\nexport function choose(input: number = 12345): number { return input; }\nconst setting: 'synthetic-secret-literal' = 'synthetic-secret-initializer';\n`, () => []);
  assert.ok(facts.symbols.includes('choose')); assert.deepEqual(facts.imports, ['./value.js']);
  assert.ok(facts.signatures.includes('function choose(input: number): number'));
  assert.doesNotMatch(JSON.stringify(facts.signatures), /12345|synthetic-secret|return input/);
  const arrows = sourceFacts('/project/api.ts', 'export const choose = (input: number = 987654): number => input;\nexport class Service { read(path: string): void {} }', () => []);
  assert.ok(arrows.signatures.includes('choose(input: number): number'));
  assert.ok(arrows.signatures.includes('Service.read(path: string): void'));
  assert.doesNotMatch(JSON.stringify(arrows.signatures), /987654|=> input/);
});
test('dependency ranking brings permitted related modules into a bounded map and never expands authority', () => {
  const files: ProjectMapFile[] = [
    { path: '/project/api.ts', relativePath: 'api.ts', kind: 'ts', symbols: ['choose'], signatures: ['function choose(): number'] },
    { path: '/project/value.ts', relativePath: 'value.ts', kind: 'ts', symbols: ['value'] }, { path: '/project/unrelated.ts', relativePath: 'unrelated.ts', kind: 'ts', symbols: ['other'] },
  ];
  const facts = new Map([['/project/api.ts', sourceFacts('/project/api.ts', `import './value.js';\nimport '../revoked/secret.ts';`, () => [])]]);
  connectFiles(files, facts); assert.deepEqual(files[0].dependencies, ['/project/value.ts']);
  const ranked = rankConnectedFiles(files, new Map([['/project/api.ts', 10]]));
  assert.deepEqual(ranked.map(file => file.path), ['/project/api.ts', '/project/value.ts']);
  assert.deepEqual(rankConnectedFiles(files, new Map()), []);
  assert.deepEqual(rankConnectedFiles(files, new Map([['/project/api.ts', 10]]), 10), []);
  const revoked = files.filter(file => file.path !== '/project/value.ts').map(file => ({ ...file, dependencies: undefined }));
  connectFiles(revoked, facts); assert.equal(revoked[0].dependencies, undefined);
});
