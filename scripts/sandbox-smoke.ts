import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceServices } from '../src/backend';
import type { Project, ToolResult } from '../src/shared/types';

async function main(): Promise<void> {
// Run from an ordinary macOS terminal: npx tsx scripts/sandbox-smoke.ts
// A surrounding process sandbox may prohibit sandbox_apply; this check reports
// that limitation and exits nonzero rather than running unsandboxed commands.
const fixture = path.resolve('.workbench', 'sandbox-acceptance', randomUUID());
const projectRoot = path.join(fixture, 'project');
const readonlyRoot = path.join(projectRoot, 'reference');
const outside = path.join(fixture, 'outside');
const dataDir = path.join(projectRoot, '.workbench', 'state');
const reportPath = path.join(fixture, 'report.json');
const checks: { name: string; passed: boolean }[] = [];
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
const report: { fixture: string; sandboxAvailable: boolean; result: string; checks: typeof checks; failure?: string } = {
  fixture, sandboxAvailable: false, result: 'running', checks,
};

await Promise.all([mkdir(readonlyRoot, { recursive: true }), mkdir(outside, { recursive: true })]);
const services = new WorkspaceServices(dataDir, { approve: async () => false, emit: () => undefined });
const record = async (name: string, operation: () => Promise<void>) => {
  try { await operation(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false }); throw new Error(`Acceptance check failed: ${name}\n${(error as Error).message}`); }
};

try {
  const boot = await services.bootstrap();
  report.sandboxAvailable = boot.sandboxAvailable;
  if (!boot.sandboxAvailable) { report.result = 'unavailable'; throw new Error('macOS sandbox_apply is unavailable in this process. Run this script from an ordinary macOS terminal.'); }
  const project = await services.createProject({ name: 'Sandbox acceptance fixture', folders: [{ path: projectRoot, access: 'write' }, { path: readonlyRoot, access: 'read' }], commandPolicy: 'sandbox', internet: false });
  const session = await services.createSession(project.id, 'demo');
  const run = async (command: string, scopedProject: Project = project, scopedSession = session.id, timeoutMs = 10_000): Promise<ToolResult> =>
    services.executeTool({ id: randomUUID(), name: 'run_command', arguments: { command, timeoutMs } }, { project: scopedProject, sessionId: scopedSession, signal: new AbortController().signal });
  const success = async (command: string) => { const result = await run(command); if (result.error) throw new Error(result.text.slice(0, 6000)); return result; };
  const denied = async (command: string) => { const result = await run(command); assert.equal(result.error, true); };

  const edited = path.join(projectRoot, 'edited.txt');
  const deleted = path.join(projectRoot, 'deleted.txt');
  const created = path.join(projectRoot, 'created.txt');
  const reference = path.join(readonlyRoot, 'reference.txt');
  const external = path.join(outside, 'external.txt');
  await Promise.all([writeFile(edited, 'original fixture'), writeFile(deleted, 'deleted fixture'), writeFile(reference, 'readonly fixture'), writeFile(external, 'outside fixture')]);

  await record('scoped edit and guarded snapshot undo', async () => {
    await success(`printf '%s' 'edited fixture' > ${quote(edited)}`);
    assert.equal(await readFile(edited, 'utf8'), 'edited fixture');
    const change = (await services.getChanges(project.id)).find(item => item.path === edited)!;
    assert.equal(change.before, 'original fixture');
    await services.revertChange(project.id, change.id);
    assert.equal(await readFile(edited, 'utf8'), 'original fixture');
  });

  await record('zsh here-document uses permitted scratch storage', async () => {
    const result = await success("/bin/cat <<'WORKBENCH_EOF'\npublic here-document fixture\nWORKBENCH_EOF");
    assert.match(result.text, /public here-document fixture/);
  });

  await record('command create/delete tracking and undo', async () => {
    await success(`printf '%s' 'created fixture' > ${quote(created)}\nrm ${quote(deleted)}`);
    const changes = await services.getChanges(project.id);
    const creation = changes.find(item => item.path === created)!;
    const deletion = changes.find(item => item.path === deleted)!;
    assert.equal(creation.before, null);
    assert.equal(deletion.after, null);
    await services.revertChange(project.id, creation.id);
    await services.revertChange(project.id, deletion.id);
    await assert.rejects(readFile(created), { code: 'ENOENT' });
    assert.equal(await readFile(deleted, 'utf8'), 'deleted fixture');
  });

  await record('outside project read/write denial', async () => {
    await denied(`cat ${quote(external)}`);
    await denied(`printf '%s' 'forbidden fixture' > ${quote(external)}`);
    assert.equal(await readFile(external, 'utf8'), 'outside fixture');
  });

  await record('readonly subfolder read allowance and write denial', async () => {
    assert.ok((await success(`cat ${quote(reference)}`)).text.includes('readonly fixture'));
    await denied(`printf '%s' 'forbidden fixture' > ${quote(reference)}`);
    assert.equal(await readFile(reference, 'utf8'), 'readonly fixture');
  });

  await record('private application state read/write and ancestor rename denial', async () => {
    await denied(`cat ${quote(path.join(dataDir, 'workspace.json'))}`);
    await denied(`touch ${quote(path.join(dataDir, 'workspace.json'))}`);
    await denied(`mv ${quote(path.dirname(dataDir))} ${quote(path.join(projectRoot, 'moved-state'))}`);
    assert.equal((await services.getProject(project.id)).id, project.id);
  });

  await record('credential-file path denial using a non-secret fixture', async () => {
    await writeFile(path.join(projectRoot, '.env'), 'SAFE_FIXTURE=placeholder');
    await denied(`cat ${quote(path.join(projectRoot, '.env'))}`);
    await denied(`cat ${quote(path.join(projectRoot, '.ENV'))}`);
  });

  await record('curated child environment does not inherit a non-secret sentinel', async () => {
    const variable = `WORKBENCH_SANDBOX_FIXTURE_${randomUUID().replace(/-/g, '').toUpperCase()}`;
    process.env[variable] = 'non-secret-fixture';
    try { await success(`test -z "\${${variable}:-}"`); }
    finally { delete process.env[variable]; }
  });

  await record('network disabled at the OS command sandbox', async () => {
    await denied('/usr/bin/curl --silent --show-error --connect-timeout 2 --max-time 3 https://example.com >/dev/null');
  });

  await record('enabled skill resources readable and their writes denied inside private appdata', async () => {
    const skill = await services.createSkill({ name: 'Sandbox fixture helper', description: 'Acceptance fixture', content: 'Public non-secret fixture instruction.' });
    const document = path.join(skill.path, 'SKILL.md');
    await success(`cat ${quote(document)}`);
    await denied(`printf '%s' 'forbidden fixture' > ${quote(document)}`);
    assert.ok((await services.readSkill(skill.id)).includes('Public non-secret fixture instruction.'));
    await services.removeSkill(skill.id);
  });

  await record('writable child overrides its readonly parent', async () => {
    const scoped = await services.createProject({ name: 'Nested access fixture', folders: [{ path: projectRoot, access: 'read' }, { path: readonlyRoot, access: 'write' }], commandPolicy: 'sandbox', internet: false });
    const scopedSession = await services.createSession(scoped.id, 'demo');
    const target = path.join(readonlyRoot, 'nested-write.txt');
    const result = await run(`printf '%s' 'nested fixture' > ${quote(target)}`, scoped, scopedSession.id);
    assert.notEqual(result.error, true);
    assert.equal(await readFile(target, 'utf8'), 'nested fixture');
    const change = (await services.getChanges(scoped.id)).find(item => item.path === target)!;
    await services.revertChange(scoped.id, change.id);
  });

  await record('nonzero exit has a durable failed receipt; timeout remains uncertain', async () => {
    const context = { project, sessionId: session.id, signal: new AbortController().signal };
    const call = { id: randomUUID(), name: 'run_command', arguments: { command: 'exit 7' } };
    const started = await services.operations.begin(call, context);
    const failed = await services.executeTool(call, context);
    assert.equal(failed.error, true);
    assert.deepEqual(failed.commandExit, { code: 7 });
    assert.equal((await services.operations.finish(started.operation.id, failed)).status, 'failed');
    assert.deepEqual((await services.operations.begin(call, context)).cachedResult, failed);
    const timed = await run('/bin/sleep 10', project, session.id, 1000);
    assert.equal(timed.error, true);
    assert.equal(timed.commandExit, undefined);
    assert.match(timed.text, /Timed out/);
  });
  report.result = 'passed';
} catch (error) {
  if (report.result !== 'unavailable') report.result = 'failed';
  report.failure = (error as Error).message;
  process.exitCode = 1;
} finally {
  await rm(path.join(projectRoot, 'moved-state'), { recursive: true, force: true }).catch(() => undefined);
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, result: report.result, sandboxAvailable: report.sandboxAvailable, checks }, null, 2));
}
}

void main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
