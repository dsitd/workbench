import test from 'node:test';
import assert from 'node:assert/strict';
import { openRouterImportSource, parseOpenRouterCredential, validateOpenRouterImportTarget } from '../src/main/openrouter-import';
import { modelPresets } from '../src/shared/model-presets';

// Every value in this suite is artificial; no files, vault or real credentials are read.
const fakeKey = `sk-or-v1-fixture-${'a1'.repeat(32)}`;
const otherFakeKey = `sk-or-v1-fixture-${'b2'.repeat(32)}`;
const flag = '--import-openrouter-env';

test('OpenRouter import accepts only the exact Sonnet profile and official destination', () => {
  const model = { id: 'openrouter-claude-sonnet-55', ...modelPresets[0].configuration };
  validateOpenRouterImportTarget(model);
  validateOpenRouterImportTarget({ ...model, baseUrl: model.baseUrl + '/' });
  for (const changed of [undefined, { ...model, id: 'different-profile' }, { ...model, kind: 'anthropic' as const }, { ...model, model: 'anthropic/claude-opus-5.5' }, { ...model, baseUrl: 'https://fixture.invalid/api/v1' }, { ...model, baseUrl: model.baseUrl + '?key=fixture' }])
    assert.throws(() => validateOpenRouterImportTarget(changed), /штатный профиль/);
});

function rejectsWithoutEcho(operation: () => unknown, values: string[]) {
  assert.throws(operation, error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0 && error.message.length < 200);
    for (const value of values) assert.ok(!error.message.includes(value), 'Error must not contain input values');
    return true;
  });
}

test('OpenRouter dotenv parsing supports export, quotes, whitespace, comments, CRLF and BOM', () => {
  const inputs = [
    `OPENROUTER_API_KEY=${fakeKey}`,
    `export OPENROUTER_API_KEY=${fakeKey}`,
    ` \t export\tOPENROUTER_API_KEY \t= \t${fakeKey} \t`,
    `OPENROUTER_API_KEY="${fakeKey}"`,
    `OPENROUTER_API_KEY='${fakeKey}'`,
    `OPENROUTER_API_KEY=${fakeKey} # artificial comment`,
    `OPENROUTER_API_KEY=${fakeKey}# artificial comment without preceding space`,
    `OPENROUTER_API_KEY="${fakeKey}"# artificial comment`,
    `OPENROUTER_API_KEY='${fakeKey}' \t# artificial comment`,
    `\uFEFFexport OPENROUTER_API_KEY="${fakeKey}"\r\n`,
    `# OPENROUTER_API_KEY=${otherFakeKey}\nOTHER_SETTING=fixture\nOPENROUTER_API_KEY=${fakeKey}\n`,
  ];
  for (const input of inputs) assert.equal(parseOpenRouterCredential(input), fakeKey);
});

test('OpenRouter dotenv parser selects the exact variable and requires one assignment', () => {
  const invalid = [
    '', '# OPENROUTER_API_KEY=artificial-comment',
    `OTHER_OPENROUTER_API_KEY=${fakeKey}`, `OPENROUTER_API_KEY_SUFFIX=${fakeKey}`,
    `OPENROUTER_API_KEY=${fakeKey}\nOPENROUTER_API_KEY=${otherFakeKey}`,
    `export OPENROUTER_API_KEY='${fakeKey}'\r\n OPENROUTER_API_KEY="${otherFakeKey}"`,
    `OPENROUTER_API_KEY=${fakeKey}\nOPENROUTER_API_KEY=`,
  ];
  for (const input of invalid) rejectsWithoutEcho(() => parseOpenRouterCredential(input), [fakeKey, otherFakeKey]);
});

test('OpenRouter dotenv parser rejects empty and placeholder values', () => {
  const invalid = ['', ' ', '""', "''", 'your-api-key', 'YOUR_OPENROUTER_API_KEY', 'replace-me', 'REPLACE_WITH_KEY', 'placeholder', 'changeme', 'example', '...'];
  for (const value of invalid) rejectsWithoutEcho(() => parseOpenRouterCredential(`OPENROUTER_API_KEY=${value}`), [fakeKey]);
});

test('OpenRouter dotenv parser rejects malformed quotes, multiline values, interpolation and controls without echo', () => {
  const invalid = [
    `"${fakeKey}`, `'${fakeKey}`, `"${fakeKey}'`,
    `"${fakeKey}" ${otherFakeKey}`, `'${fakeKey}' suffix`,
    `"${fakeKey}\n${otherFakeKey}"`, `'${fakeKey}\r\n${otherFakeKey}'`,
    `${fakeKey}\\\n${otherFakeKey}`, `"${fakeKey}\\n${otherFakeKey}"`,
    `${fakeKey} ${otherFakeKey}`, `${fakeKey}\t${otherFakeKey}`,
    `${fakeKey}\0${otherFakeKey}`, `${fakeKey}\r${otherFakeKey}`,
    '${OPENROUTER_API_KEY}',
  ];
  for (const value of invalid) rejectsWithoutEcho(() => parseOpenRouterCredential(`OPENROUTER_API_KEY=${value}`), [fakeKey, otherFakeKey]);
});

test('OpenRouter dotenv credential size limit accepts the boundary and rejects oversized input safely', () => {
  const boundary = 'f'.repeat(8192);
  assert.equal(parseOpenRouterCredential(`OPENROUTER_API_KEY=${boundary}`), boundary);
  rejectsWithoutEcho(() => parseOpenRouterCredential(`OPENROUTER_API_KEY=${boundary}f`), [boundary]);
});

test('OpenRouter import source is absent on ordinary startup and accepts one explicit absolute dotenv path', () => {
  assert.equal(openRouterImportSource([]), undefined);
  assert.equal(openRouterImportSource(['/Applications/Workbench.app', '--other-option', '/tmp/.env.fixture']), undefined);
  assert.equal(openRouterImportSource(['/Applications/Workbench.app', flag, '/tmp/.env']), '/tmp/.env');
  assert.equal(openRouterImportSource(['node', 'fixture.js', flag, '/tmp/project with spaces/.env.local']), '/tmp/project with spaces/.env.local');
});

test('OpenRouter import source rejects missing, repeated, relative and non-dotenv paths with static errors', () => {
  const invalid = [
    [flag], [flag, ''], [flag, flag],
    [flag, '/tmp/.env.fixture', flag, '/tmp/second/.env'],
    [flag, '/tmp/.env.fixture', flag],
    [flag, '.env'], [flag, './.env'], [flag, 'project/.env'], [flag, '~/.env'],
    [flag, '/tmp/configuration.txt'], [flag, '/tmp/env'],
  ];
  const expected = new Set<string>();
  for (const argv of invalid) {
    assert.throws(() => openRouterImportSource(argv), error => {
      assert.ok(error instanceof Error);
      expected.add(error.message);
      for (const value of argv.filter(value => value !== flag && value.includes('/'))) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.equal(expected.size, 1, 'Argument validation should use one static error');
});
