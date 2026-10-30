import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sandboxAvailable } from '../../src/backend/commands';
import { trackedGateway, refactorCampaign } from './budget';
import { runWorkbench } from './workbench';
import { resolvePilotModel, type PilotModel } from './models';
import { sweCommand, sweGrade, swePython, sweReadRoots, swePrepareDevelopment } from './swe';
import { PiTraceCapture } from './pi-trace';

import { benchmarkTemp, benchmarkPath, credentialResolver, finish, nodeExecutable, option, piDependencies, pythonExecutable, ready, runtimeRoots, shellQuote } from './platform';
import { benchmarkSandbox } from './isolated-process';

const base = path.resolve(option('--base') ?? '.workbench/comparison');
const node = nodeExecutable;
const python = pythonExecutable;
const dry = process.argv.includes('--dry-run');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const testCommand = `${shellQuote(python)} -B -m unittest discover -p '*_test.py'`;

async function execute(executable: string, args: string[], cwd: string, env: Record<string, string>, timeout = 600_000, piTrace?: PiTraceCapture) {
  return await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const capture = (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString(); };
    child.stdout.on('data', (chunk: Buffer) => { capture(chunk); piTrace?.write(chunk); }); child.stderr.on('data', capture);
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, timeout);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, output: 'Process launch failed' }); });
    child.on('close', code => { clearTimeout(timer); piTrace?.end(); resolve({ code, output }); });
  });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = path.posix.join(prefix, entry.name);
      if (entry.name === '__pycache__') continue;
      if (entry.isSymbolicLink()) { out[rel] = 'SYMLINK'; continue; }
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out[rel] = sha(await fs.readFile(path.join(dir, entry.name), 'utf8'));
    }
  }
  await walk(root); return out;
}

async function grade(source: string, project: string, target: string | string[], location: string, before: Record<string,string>, hiddenTest?: string) {
  const after = await snapshot(project);
  const unexpected = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file] && !(Array.isArray(target) ? target : [target]).includes(file));
  await fs.cp(source, location, { recursive: true });
  if (hiddenTest) await fs.copyFile(hiddenTest, path.join(location, 'heldout_test.py'));
  for (const file of Array.isArray(target) ? target : [target]) {
    const entry = await fs.lstat(path.join(project, file));
    if (!entry.isFile() || entry.isSymbolicLink()) return { passed: false, unexpected, output: 'Implementation is not a regular file', code: -1 };
    await fs.copyFile(path.join(project, file), path.join(location, file));
  }
  const scratch = path.join(location, '.scratch'); await fs.mkdir(scratch);
  const sandbox = await benchmarkSandbox({ roots: [{ path: location, access: 'write' }, ...runtimeRoots], temporary: scratch, internet: false }, python, ['-B', '-m', 'unittest', 'discover', '-v', '-p', '*_test.py']);
  let result;
  try { result = await execute(sandbox.executable, sandbox.args, location,
    { PATH: benchmarkPath, HOME: scratch, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, 30_000); }
  finally { await sandbox.cleanup(); }
  return { passed: result.code === 0 && unexpected.length === 0, unexpected, ...result };
}

async function runPi(project: string, state: string, port: number, prompt: string, timeout = 600_000, pilot: PilotModel = resolvePilotModel(), readRoots: string[] = [], pythonExecutable = python) {
  await fs.mkdir(state, { recursive: true });
  const home = path.join(state, 'home'); await fs.mkdir(home);
  // Dedicated empty store: Pi must not discover the user's real credentials.
  await fs.writeFile(path.join(state, 'auth.json'), '{}');
  await fs.writeFile(path.join(state, 'models.json'), JSON.stringify({ providers: { pilot: { baseUrl: `http://127.0.0.1:${port}/pi/v1`, api: pilot.api === 'responses' ? 'openai-responses' : 'openai-completions', apiKey: 'unused-local-placeholder',
    models: [{ id: pilot.id, name: `Pilot ${pilot.name}`, reasoning: pilot.reasoning !== 'none', input: ['text'], contextWindow: 96000, maxTokens: 6000, cost: { input: pilot.input, output: pilot.output, cacheRead: pilot.cacheRead, cacheWrite: pilot.cacheWrite } }] } } }));
  await fs.writeFile(path.join(state, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true }, autoUpdate: false }));
  const dependencies = piDependencies;
  const trace = new PiTraceCapture();
  const sandbox = await benchmarkSandbox({ roots: [{ path: project, access: 'write' }, { path: dependencies, access: 'read' }, ...runtimeRoots, ...readRoots.map(path => ({ path, access: 'read' as const }))], temporary: state, internet: false, metadataReadRoots: [state, path.join(dependencies, 'node_modules/openai')], localhostPort: port }, node, [path.join(dependencies, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    '--provider', 'pilot', '--model', pilot.id, '--thinking', pilot.reasoning === 'none' ? 'off' : pilot.reasoning, '--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', 'read,bash,edit,write,grep,find,ls', '-p', prompt]);
  let result;
  try { result = await execute(sandbox.executable, sandbox.args, project,
    { PATH: `${path.dirname(pythonExecutable)}:${benchmarkPath}`, HOME: home, TMPDIR: state, PI_CODING_AGENT_DIR: state, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', CI: '1' }, timeout, trace); }
  finally { await sandbox.cleanup(); }
  await fs.writeFile(path.join(state, 'trace.jsonl'), trace.text(), { mode: 0o600 });
  const last = trace.lastAssistant;
  return { status: result.code === 0 && last?.stopReason === 'stop' ? 'completed' : last?.stopReason === 'length' ? 'incomplete' : 'error', exitCode: result.code,
    steps: trace.steps, toolCalls: trace.toolCalls, toolErrors: trace.toolErrors, traceTruncated: trace.truncated, droppedProgressEvents: trace.droppedProgress,
    error: last?.errorMessage ?? (result.code !== 0 ? result.output.slice(-1500) : undefined) };
}

async function main() {
  const modelIndex = process.argv.indexOf('--model');
  if (modelIndex >= 0 && !process.argv[modelIndex + 1]) throw new Error('--model requires a canonical model ID');
  const pilot = resolvePilotModel(modelIndex < 0 ? undefined : process.argv[modelIndex + 1]);
  await ready();
  if (dry && process.argv.includes('--resume-from')) throw new Error('--dry-run cannot resume a live run');
  if (!(await sandboxAvailable())) throw new Error('Native sandbox unavailable');
  const manifestIndex = process.argv.indexOf('--manifest');
  const manifestPath = manifestIndex < 0 ? path.join(base, 'manifest.json') : path.resolve(process.argv[manifestIndex + 1]);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length || manifest.tasks.some((task: unknown) => typeof task !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(task))) throw new Error('Invalid manifest task paths');
  const swe = manifest.kind === 'swe-bench-verified-local';
  const diverse = manifest.kind === 'local-diverse-v1';
  const flashFlag = process.argv.includes('--flash-campaign'), refactor = process.argv.includes('--refactor-campaign');
  if (flashFlag && refactor) throw new Error('--flash-campaign and --refactor-campaign are mutually exclusive');
  const campaign = flashFlag ? 'flash-20261022' as const : refactor ? refactorCampaign : undefined;
  if (campaign && pilot.id !== 'deepseek/deepseek-v4.1-flash-1017') throw new Error(refactor ? 'Refactor campaign requires the Flash model' : 'Flash campaign requires its frozen model');
  if (refactor && (process.argv.includes('--validate-fixtures') || process.argv.includes('--resume-from'))) throw new Error('--refactor-campaign supports benchmark runs only');
  const armsIndex = process.argv.indexOf('--arms');
  const selectedArms = armsIndex < 0 ? ['workbench', 'pi'] : process.argv[armsIndex + 1].split(',');
  if (!selectedArms.length || selectedArms.some(arm => !['workbench', 'pi'].includes(arm)) || new Set(selectedArms).size !== selectedArms.length) throw new Error('Invalid arms');
  // Agents see absolute project paths and the gateway rejects private home/repository paths,
  // so cases always execute under /private/tmp (same layout as earlier campaigns).
  const work = await fs.mkdtemp(path.join(benchmarkTemp, `workbench-pilot-${dry ? 'dry' : 'live'}-`));
  // Refactor campaign: the registered ledger, report and an archive of every case live in a persistent directory.
  let output = work;
  if (refactor) {
    const parent = path.join(base, refactorCampaign, dry ? 'flash-dry' : 'flash');
    await fs.mkdir(parent, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    output = await fs.mkdtemp(path.join(parent, `${path.basename(manifestPath, '.json')}-${stamp}-`));
  }
  if (process.argv.includes('--validate-fixtures')) {
    if (!diverse) throw new Error('Fixture validation requires the diverse manifest');
    const validations = [];
    for (const task of manifest.tasks) {
      const source = path.join(base, 'dataset', task), before = await snapshot(source);
      for (const kind of ['baseline', 'oracle']) {
        const candidate = kind === 'baseline' ? source : path.join(base, 'diverse-oracles', task);
        const result = await grade(source, candidate, manifest.taskFiles[task], path.join(output, `${task}-${kind}`), before, path.join(base, 'diverse-hidden', `${task}_test.py`));
        validations.push({ task, kind, ...result });
        await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(validations, null, 2));
        if (result.passed !== (kind === 'oracle')) throw new Error(`Fixture validation failed: ${task} ${kind}: ${result.output}`);
        console.log(`VALIDATED ${task} ${kind} passed=${result.passed}`);
      }
    }
    console.log(`VALIDATION ${output}/validation.json`);
    return;
  }
  // Public dependency package only; no source repository is visible to either agent.
  if (selectedArms.includes('pi')) {
    try { await fs.access(path.join(piDependencies, 'node_modules/@earendil-works/pi-coding-agent/package.json')); }
    catch { await fs.cp(path.join(base, 'pi'), piDependencies, { recursive: true, errorOnExist: true, force: false }); }
  }
  const credential = await credentialResolver(dry);
  const resumeIndex = process.argv.indexOf('--resume-from');
  if (resumeIndex >= 0) {
    const previous = path.resolve(process.argv[resumeIndex + 1]);
    const baseline = JSON.parse(await fs.readFile(path.join(previous, 'report.json'), 'utf8'));
    if (baseline.model !== pilot.id) throw new Error('Resume cannot change the original benchmark model');
    const proxy = await trackedGateway(base, output, credential, false, 0, 1.5, 0.30, pilot);
    const diagnostics: any = { kind: 'resume-diagnostic-not-comparative-rerun', primary: previous, extraStepLimit: 0, cases: [] };
    console.log(`START RESUME ${output}`);
    try {
      for (const item of baseline.cases.filter((c:any)=>c.arm==='workbench' && c.status==='limited')) {
        proxy.select('workbench', item.task);
        const caseRoot = path.join(previous, `${item.task}-workbench`), source = path.join(base, 'dataset', item.task);
        console.log(`RESUME ${item.task}`);
        const result = await runWorkbench(path.join(caseRoot,'project'),path.join(caseRoot,'state'),`http://127.0.0.1:${proxy.port}/workbench/v1`,'',testCommand,false,true,0.30,600_000,pilot);
        const grading = await grade(source,path.join(caseRoot,'project'),item.task.replaceAll('-','_')+'.py',path.join(output,`${item.task}-grading`),await snapshot(source));
        const calls = proxy.ledger.calls.filter((c:any)=>c.task===item.task);
        diagnostics.cases.push({task:item.task,...result,passed:grading.passed,extraRequests:calls.length,costUsd:calls.reduce((s:number,c:any)=>s+(c.costUsd??c.reservationUsd),0)});
        diagnostics.billing=proxy.ledger;
        await fs.writeFile(path.join(output,'diagnostics.json'),JSON.stringify(diagnostics,null,2));
        console.log(`RESUMED ${item.task} status=${result.status} tests=${grading.passed} extraRequests=${calls.length}`);
      }
      console.log(`DONE RESUME cost=$${proxy.ledger.chargedUsd.toFixed(6)} report=${output}/diagnostics.json`);
    } finally {proxy.close();}
    return;
  }
  const taskUsd = manifest.maxCostPerTask ?? 0.30;
  const durationMs = manifest.maxDurationMs ?? 600_000;
  // Flash: $10 campaign cap. Refactor: $3, further limited by the registry to its remaining authorization.
  const invocationUsd = campaign === 'flash-20261022' ? 10 : campaign === refactorCampaign ? 3 : 3.8;
  const proxy = await trackedGateway(base, output, credential, dry, 0, invocationUsd, taskUsd, pilot, false, campaign);
  const report: any = { protocol: 'workbench-pi-pilot-v7-portable', platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, campaign, selectedArms, dry, ...(refactor ? { manifestPath, workDirectory: work, invocationCapUsd: invocationUsd } : {}), manifest, behaviorVerification: process.argv.includes('--behavior-checks'), model: pilot.id, maxRequestBytes: pilot.maxRequestBytes, pricingPerMillion: pilot, provider: pilot.provider ?? 'openai', piVersion: '1.1.0', maxCallsPerTask: 0, maxDurationMs: durationMs, maxCostPerTask: taskUsd, maxOutputTokens: 6000, reasoningEffort: pilot.reasoning, api: pilot.api, temperature: 'provider default', cases: [] };
  console.log(`START ${dry ? 'OFFLINE' : 'LIVE'} ${output}`);
  if (output !== work) console.log(`WORK ${work}`);
  try {
    for (const [index, task] of (dry ? manifest.tasks.slice(0,1) : manifest.tasks).entries()) {
      for (const arm of (index % 2 ? ['pi', 'workbench'] : ['workbench', 'pi']).filter(arm => selectedArms.includes(arm))) {
        const caseRoot = path.join(work, `${task}-${arm}`); await fs.mkdir(caseRoot);
        const source = path.join(base, 'dataset', task), project = path.join(caseRoot, 'project');
        await fs.cp(source, project, { recursive: true });
        if (swe) await swePrepareDevelopment(project, manifest.cases[task]);
        const target: string | string[] = manifest.taskFiles?.[task] ?? task.replaceAll('-', '_') + '.py';
        const instructions = await fs.readFile(path.join(source, '.docs/instructions.md'), 'utf8');
        let append = ''; try { append = await fs.readFile(path.join(source, '.docs/instructions.append.md'), 'utf8'); } catch {}
        const command = swe ? sweCommand(manifest.cases[task]) : testCommand;
        const prompt = swe
          ? `Fix this real SymPy issue in the existing repository. Inspect the code and existing tests, implement the complete behavior and run the relevant tests. Only change implementation Python files under sympy/; do not change tests, instructions, dependencies, test runners or configuration. Do not use network access. A separate grader will run held-out regression tests. The development command runs unaffected baseline tests; other old tests may assert behavior this issue asks to change. Verify the requested new behavior yourself as well. Development test command: ${command}\n\n${instructions}`
          : `Implement the requested ${diverse ? 'behavior and deliverables' : 'Python behavior'} in ${Array.isArray(target) ? target.join(', ') : target}. Read the existing files and tests, implement the requested behavior, run the tests and fix failures. Only change ${Array.isArray(target) ? target.join(', ') : target}; do not modify tests, input data or instructions. Use ${diverse ? 'Python or Node.js standard libraries only; no network or dependency installation. Hidden tests check the written specification, including edge cases. Public tests are smoke checks, not complete acceptance' : 'Python standard library only'}. Test command: ${testCommand}\n\n${instructions}\n${append}`;
        const before = await snapshot(project), started = Date.now();
        proxy.select(arm, task);
        console.log(`RUN ${arm} ${task}`);
        const result = arm === 'workbench' ? await runWorkbench(project, path.join(caseRoot, 'state'), `http://127.0.0.1:${proxy.port}/workbench/v1`, prompt, command, dry, false, taskUsd, durationMs, pilot, swe ? sweReadRoots : [], process.argv.includes('--behavior-checks'))
          : await runPi(project, path.join(caseRoot, 'state'), proxy.port, prompt, durationMs, pilot, swe ? sweReadRoots : [], swe ? swePython : python);
        const grading = swe
          ? await sweGrade(source, project, path.join(caseRoot, 'grading'), before, await snapshot(project), manifest.cases[task], path.join(base,'swe-evidence',`${task}.test.patch`), execute)
          : await grade(source, project, target, path.join(caseRoot, 'grading'), before, diverse ? path.join(base, 'diverse-hidden', `${task}_test.py`) : undefined);
        await fs.writeFile(path.join(caseRoot,'grading-result.json'), JSON.stringify(grading,null,2));
        const bill = proxy.ledger.calls.filter((c: any) => c.arm === arm && c.task === task);
        const item = { arm, task, ...result, passed: grading.passed, unexpectedChanges: grading.unexpected, testExitCode: grading.code,
          durationMs: Date.now()-started, requests: bill.length, costUsd: bill.reduce((s:number,c:any)=>s+(c.costUsd??c.reservationUsd),0), unknownCostCalls: bill.filter((c:any)=>c.state!=='reported').length,
          inputTokens: bill.reduce((s:number,c:any)=>s+(c.inputTokens??0),0), outputTokens: bill.reduce((s:number,c:any)=>s+(c.outputTokens??0),0) };
        await fs.writeFile(path.join(caseRoot, 'test-output.txt'), grading.output);
        let archiveError: string | undefined;
        if (output !== work) {
          // APFS clone where possible; the /private/tmp work copy is kept as well.
          try { await fs.cp(caseRoot, path.join(output, path.basename(caseRoot)), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, mode: fsConstants.COPYFILE_FICLONE }); }
          catch (error) { archiveError = error instanceof Error ? error.message : 'Archive copy failed'; console.log(`ARCHIVE FAILED ${arm} ${task}; work copy kept at ${caseRoot}`); }
        }
        report.cases.push(archiveError ? { ...item, archiveError } : item); report.billing = proxy.ledger;
        await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report,null,2));
        console.log(`RESULT ${arm} ${task} tests=${item.passed} status=${item.status} requests=${item.requests} cost=$${item.costUsd.toFixed(5)}`);
        if (!dry && !bill.some((c:any) => c.state === 'reported')) throw new Error('No completed model response; stop infrastructure failure before other cases');
        if (dry && (item.requests !== 1 || item.status !== 'completed')) throw new Error(`Offline integration failed for ${arm}: ${item.error ?? item.status}`);
      }
      if (process.argv.includes('--stop-on-failure') && report.cases.some((item: any) => item.task === task && !item.passed)) {
        console.log(`PAUSED failed pair ${task}; report=${path.join(output,'report.json')}`);
        break;
      }
    }
    console.log(`DONE total=$${proxy.ledger.chargedUsd.toFixed(5)} report=${path.join(output,'report.json')}`);
  } finally { proxy.close(); }
}
main().then(() => finish(0)).catch(async error => { console.error(error instanceof Error ? error.message : 'Pilot failed'); await finish(1); });
