import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { sandboxAvailable } from '../../src/backend/commands';
import { trackedGateway, campaignSpent, refactorCampaign, type BudgetCampaign } from './budget';
import { runWorkbench } from './workbench';
import { resolvePilotModel } from './models';
import { fixtureVersion, windowTokens, makeHistory, probes, gradeAnswer, initialFacts, updates } from './memory-fixture';

// Set by the esbuild command (`--define`); absent when run from source.
declare const MEMORY_VARIANT: string | undefined;
declare const MEMORY_TREE: string | undefined;
const variant = typeof MEMORY_VARIANT === 'string' ? MEMORY_VARIANT : 'source';
const tree = typeof MEMORY_TREE === 'string' ? MEMORY_TREE : process.cwd();

import { benchmarkTemp, benchmarkPath, credentialResolver, finish, nodeExecutable, piDependencies, ready, runtimeRoots } from './platform';
import { benchmarkSandbox } from './isolated-process';
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error(`${name} requires a value`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const base = path.resolve(argument('--base') ?? '.workbench/comparison');
const dry = process.argv.includes('--dry-run');
const campaign: BudgetCampaign = process.argv.includes('--refactor-campaign') ? refactorCampaign : 'control';
const node = nodeExecutable;
const dependencies = piDependencies;
const pilot = resolvePilotModel(argument('--model') ?? 'openai/gpt-6.1-sol');
const selectedArms = (argument('--arms') ?? 'workbench,pi').split(',');
// Control defaults are the frozen v1 protocol; the refactor registry uses one modest cap per arm run.
const capUsd = Number(argument('--cap-usd') ?? (campaign === 'control' ? 1.60 : 0.30));
const armUsd = campaign === 'control' && !argument('--cap-usd') ? 0.80 : capUsd;
/** In-app run limit per probe; identical for every arm and unchanged from v1. */
const appRunCostLimitUsd = 0.80;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const write = async (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
const piApi = pilot.api === 'responses' ? 'openai-responses' : 'openai-completions';
const piThinking = pilot.reasoning === 'none' ? 'off' : pilot.reasoning;

async function piTurn(root: string, state: string, port: number, history: ReturnType<typeof makeHistory> | undefined, prompt: string, sessionFile?: string) {
  // The public OpenAI SDK contains source modules named credentials.mjs; these
  // are library code, not credentials. Keep the exception within that dependency.
  const sandbox = await benchmarkSandbox({ roots: [{ path: root, access: 'write' }, { path: dependencies, access: 'read' }, ...runtimeRoots], temporary: state, internet: false, metadataReadRoots: [state, path.join(dependencies, 'node_modules/openai')], localhostPort: port }, node, [path.join(state, 'memory-pi.mjs')]);
  try {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(sandbox.executable, sandbox.args, {
      cwd: root, detached: true, env: { PATH: benchmarkPath, HOME: path.join(state, 'home'), TMPDIR: state, PI_CODING_AGENT_DIR: state, CI: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer) => { if (output.length < 100_000) output += chunk.toString(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 600_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end(JSON.stringify({ state, project: root, history, prompt, sessionFile, model: pilot.id, api: piApi, thinkingLevel: piThinking, dependencies }));
  });
  if (result.code !== 0) throw new Error(`Pi replay failed (${result.code}): ${result.output.slice(-2500)}`);
  return JSON.parse(await fs.readFile(path.join(state, sessionFile ? 'probe-2.json' : 'probe-1.json'), 'utf8'));
  } finally { await sandbox.cleanup(); }
}

/** Summary telemetry from the stored traces only; rejected summary text is never journaled. */
function summaryStats(arm: string, result: any) {
  if (arm === 'workbench') {
    const steps = result.run.stepLog.filter((s: any) => s.kind === 'compaction');
    const summary = result.run.modelSummary;
    return { summaryRequests: steps.length, acceptedSummaryResponses: steps.filter((s: any) => !s.errors.length).length,
      compactionErrors: steps.flatMap((s: any) => s.errors), modelSummaryComplete: summary ? summary.complete ?? null : null, modelSummarySources: summary?.sources?.length ?? 0, engine: result.engine ?? null };
  }
  const ends = result.events.filter((e: any) => e.type === 'compaction_end');
  return { summaryRequests: result.events.filter((e: any) => e.type === 'compaction_start').length, acceptedSummaryResponses: ends.filter((e: any) => e.result).length,
    compactionErrors: ends.filter((e: any) => !e.result).map((e: any) => e.errorMessage ?? (e.aborted ? 'aborted' : 'no result')), modelSummaryComplete: null, modelSummarySources: 0, engine: 'pi-sdk-1.1.0' };
}

async function main() {
  if (!selectedArms.length || selectedArms.some(arm => !['workbench', 'pi'].includes(arm)) || new Set(selectedArms).size !== selectedArms.length) throw new Error('Invalid arms');
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 1.60) throw new Error('Invalid --cap-usd');
  if (campaign === refactorCampaign) {
    // The $3 refactor authorization covers DeepSeek tests only; arms are attributable to one frozen bundle.
    if (pilot.id !== 'deepseek/deepseek-v4.1-flash-1017') throw new Error('Refactor campaign requires deepseek/deepseek-v4.1-flash-1017');
    if (!dry && !['new', 'old'].includes(variant)) throw new Error('Paid refactor runs require a bundled runner (variant new or old)');
    if (variant === 'old' && selectedArms.join() !== 'workbench') throw new Error('The pre-refactor runner measures only the workbench arm; Pi runs once from the new runner');
  }
  const history = makeHistory();
  // Validate the independent checker before any credentials or paid connection.
  assert(gradeAnswer(JSON.stringify(initialFacts), 0).passed);
  assert(gradeAnswer(JSON.stringify({ ...initialFacts, ...updates }), 1).passed);
  for (const key of Object.keys(initialFacts)) {
    assert(!gradeAnswer(JSON.stringify({ ...initialFacts, [key]: 'wrong' }), 0).passed);
    const omitted: any = { ...initialFacts }; delete omitted[key];
    assert(!gradeAnswer(JSON.stringify(omitted), 0).passed);
  }
  assert(!gradeAnswer(JSON.stringify(initialFacts), 1).passed);
  await ready();
  if (!(await sandboxAvailable())) throw new Error('Native sandbox unavailable');
  // Model-visible project/state paths stay under /private/tmp: the gateway rejects payloads naming the private repository.
  const workDir = await fs.mkdtemp(path.join(benchmarkTemp, `workbench-memory-${dry ? 'dry' : 'live'}-`));
  let output = workDir;
  if (campaign === refactorCampaign) {
    const label = selectedArms.map(arm => arm === 'workbench' ? `workbench-${variant}` : 'pi').join('+');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    output = path.join(base, campaign, 'memory', `${dry ? 'dry-' : ''}${label}-${stamp}`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(output, { mode: 0o700 }); // Fails if it exists: never overwrite an earlier run.
  }
  const previousOutput = argument('--continue-from') && path.resolve(argument('--continue-from')!);
  const previous = previousOutput ? JSON.parse(await fs.readFile(path.join(previousOutput, 'report.json'), 'utf8')) : undefined;
  if (previous && (previous.protocol.transcriptSha256 !== hash(JSON.stringify(history)) || previous.protocol.dry !== dry || previous.protocol.model !== pilot.id
    || (previous.protocol.campaign ?? 'control') !== campaign || (previous.protocol.variant ?? 'source') !== variant)) throw new Error('Continuation protocol mismatch');
  const previousWork = previous ? previous.workDir ?? previousOutput : undefined;
  const runner = typeof __filename === 'string' ? __filename : process.argv[1];
  const protocol = { version: fixtureVersion, platform: process.platform, arch: process.arch, dry, campaign, variant, selectedArms, model: pilot.id, api: pilot.api, provider: pilot.provider ?? 'openai', pricingPerMillion: pilot, reasoning: pilot.reasoning, windowTokens,
    replayMessages: history.length, transcriptBytes: Buffer.byteLength(JSON.stringify(history)), transcriptSha256: hash(JSON.stringify(history)),
    probes, piVersion: '1.1.0', piApi, piThinking, maxOutputTokens: 6000, maxCalls: 0, maxCostPerArmUsd: armUsd, totalCapUsd: capUsd, appRunCostLimitUsd,
    piCompaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 6000 },
    productionDefaultsChanged: false, scriptedHistory: true, seededAssistantUsage: 'zero (unmeasured)',
    grader: '24 exact facts per probe, including order-sensitive arrays; no access to oracle; no tools requested',
    restart: 'Workbench services/runtime recreated and Pi Node process restarted between probes',
    runner: { path: runner, sha256: hash(await fs.readFile(runner)), tree }, sourceHashes: {} as Record<string, string>, treeHashes: {} as Record<string, string> };
  for (const name of ['memory-run.ts', 'memory-fixture.ts', 'memory-pi.mjs', 'workbench.ts', 'gateway.ts', 'budget.ts', 'models.ts']) protocol.sourceHashes[name] = hash(await fs.readFile(path.join(tree, 'scripts/harness-pilot', name)));
  for (const name of ['src/agent/model-compaction.ts', 'src/agent/context.ts', 'src/agent/index.ts', 'src/agent/runtime.ts', 'src/agent/legacy-runtime.ts'])
    if (existsSync(path.join(tree, name))) protocol.treeHashes[name] = hash(await fs.readFile(path.join(tree, name)));
  await write(path.join(output, 'protocol.json'), protocol);
  await write(path.join(output, 'seed-transcript.json'), history);
  // The oracle remains in the parent process/repository, never in either sandbox.
  const credential = await credentialResolver(dry);
  if (dry && campaign !== 'control') {
    // Read-only check that this bundle accepts the shared registry; dry runs never register a ledger.
    const { limitUsd, spentUsd, ledgers } = campaignSpent(base, campaign);
    console.log(`BUDGET dry read-only campaign=${campaign} limit=$${limitUsd} spent=$${spentUsd.toFixed(6)} ledgers=${ledgers.length}`);
  }
  const proxy = await trackedGateway(base, output, credential, dry, 0, capUsd, armUsd, pilot, true, campaign);
  const report: any = { protocol, output, workDir, previousOutput, cases: previous?.cases ?? [] };
  console.log(`START ${dry ? 'OFFLINE' : 'LIVE'} variant=${variant} model=${pilot.id} arms=${selectedArms.join(',')} output=${output} work=${workDir}`);
  const armDirs: Record<string, string> = {};
  // Persistent copy of the model-visible project/state trees, including a continued arm's earlier directory.
  const archive = async () => {
    if (output === workDir) return;
    for (const [arm, armWork] of Object.entries(armDirs)) {
      const source = path.join(armWork, arm);
      if (!existsSync(source)) continue;
      try { await fs.cp(source, path.join(output, arm), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }); }
      catch (error: any) { (report.archiveErrors ??= []).push(`${arm}: ${error.message}`); }
    }
    await write(path.join(output, 'report.json'), report);
  };
  try {
    for (const arm of selectedArms) {
      const completed = report.cases.filter((item: any) => item.arm === arm);
      if (completed.length === probes.length) continue;
      const armWork = armDirs[arm] = completed.length ? previousWork! : workDir;
      const state = path.join(armWork, arm, 'state'), root = path.join(armWork, arm, 'project');
      if (completed.length && !existsSync(state)) throw new Error(`Continuation state for ${arm} is missing`);
      await fs.mkdir(root, { recursive: true }); await fs.mkdir(path.join(state, 'home'), { recursive: true });
      if (arm === 'pi' && !completed.length) {
        await fs.writeFile(path.join(state, 'auth.json'), '{}');
        await write(path.join(state, 'models.json'), { providers: { pilot: { baseUrl: `http://127.0.0.1:${proxy.port}/pi/v1`, api: piApi, apiKey: 'unused-local-placeholder',
          models: [{ id: pilot.id, name: pilot.name, reasoning: pilot.reasoning !== 'none', input: ['text'], contextWindow: windowTokens, maxTokens: 6000,
            cost: { input: pilot.input, output: pilot.output, cacheRead: pilot.cacheRead, cacheWrite: pilot.cacheWrite } }] } } });
        await write(path.join(state, 'settings.json'), { retry: { enabled: false }, compaction: protocol.piCompaction, autoUpdate: false });
        await fs.copyFile(path.join(tree, 'scripts/harness-pilot/memory-pi.mjs'), path.join(state, 'memory-pi.mjs'));
      } else if (arm === 'pi') {
        // A continued Pi session needs the new gateway port; everything else stays as stored.
        const models = JSON.parse(await fs.readFile(path.join(state, 'models.json'), 'utf8'));
        models.providers.pilot.baseUrl = `http://127.0.0.1:${proxy.port}/pi/v1`;
        await write(path.join(state, 'models.json'), models);
      }
      proxy.select(arm, fixtureVersion);
      let sessionId: string | undefined, sessionFile: string | undefined;
      if (completed.length) {
        const prior = JSON.parse(await fs.readFile(path.join(previousOutput!, `${arm}-probe-${completed.length}.json`), 'utf8'));
        sessionId = prior.sessionId; sessionFile = prior.sessionFile;
      }
      for (const [index, prompt] of probes.entries()) {
        if (completed.some((item: any) => item.probe === index + 1)) continue;
        console.log(`RUN ${arm} probe=${index + 1}`);
        const started = Date.now(), before = proxy.ledger.calls.length;
        const result = arm === 'workbench'
          ? await runWorkbench(root, state, `http://127.0.0.1:${proxy.port}/workbench/v1`, prompt, '', dry, false, appRunCostLimitUsd, 600_000, pilot, [], false,
            { contextWindow: windowTokens, sessionId, history: index ? undefined : history })
          : await piTurn(root, state, proxy.port, index ? undefined : history, prompt, sessionFile);
        sessionId = result.sessionId; sessionFile = result.sessionFile;
        const bill = proxy.ledger.calls.slice(before), grade = gradeAnswer(result.answer ?? '', index);
        const compactions = arm === 'workbench' ? result.run.stepLog.filter((s: any) => s.kind === 'compaction').length : result.events.filter((e: any) => e.type === 'compaction_end' && e.result).length;
        const sum = (key: string) => bill.reduce((s: number, c: any) => s + (c[key] ?? 0), 0);
        const item = { arm, variant: arm === 'workbench' ? variant : 'pi', probe: index + 1, durationMs: Date.now() - started, grade, answer: result.answer, requests: bill.length,
          costUsd: bill.reduce((s: number, c: any) => s + (c.costUsd ?? c.reservationUsd), 0), compactions,
          modelSummaryStored: arm === 'workbench' ? Boolean(result.run.modelSummary) : result.compactions.length > 0,
          status: result.status ?? result.stopReason, toolCalls: arm === 'workbench' ? result.toolCalls : result.events.filter((e: any) => e.type === 'tool_execution_end').length,
          inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedTokens: sum('cachedTokens'),
          calls: bill.map((c: any) => ({ state: c.state, costUsd: c.costUsd, reservationUsd: c.reservationUsd, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens, reasoningTokens: c.reasoningTokens })),
          ...summaryStats(arm, result) };
        report.cases.push(item); report.billing = proxy.ledger;
        await write(path.join(output, `${arm}-probe-${index + 1}.json`), result);
        await write(path.join(output, 'report.json'), report);
        console.log(`RESULT ${arm}(${item.variant}) probe=${index + 1} ${grade.score}/${grade.total} summaries=${item.acceptedSummaryResponses}/${item.summaryRequests} calls=${bill.length} cost=$${item.costUsd.toFixed(6)}`);
        // An offline failure is infrastructure. Live summary rejection is a measured
        // harness failure and must not suppress the other arm or a later probe.
        if (dry && index === 0 && (!compactions || !item.modelSummaryStored)) throw new Error(`${arm}: no adopted model compaction; invalid memory test`);
        if (!['completed', 'stop'].includes(item.status)) throw new Error(`${arm}: incomplete probe`);
      }
    }
    console.log(`DONE ${output}/report.json cost=$${proxy.ledger.chargedUsd.toFixed(6)}`);
  } finally { proxy.close(); report.billing = proxy.ledger; await archive(); }
}
main().then(() => finish(0)).catch(async error => { console.error(error.message); await finish(1); });
