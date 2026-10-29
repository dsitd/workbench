import type { RunRecord, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { BehaviorCheckRequest, BehaviorCheckReceipt } from '../shared/behavior-check';
import { standardCommandDescription } from '../shared/behavior-check';
import { AgentError } from './errors';

/** Experimental policy is opt-in; preserve the original lean command catalog by default. */
export function behaviorToolCatalog(tools: ToolDefinition[], enabled: boolean): ToolDefinition[] {
  if (enabled) return tools;
  return tools.map(tool => {
    if (tool.name !== 'run_command' || !(tool.parameters.properties as Record<string, unknown>)?.behaviorCheck) return tool;
    const copy = structuredClone(tool);
    delete (copy.parameters.properties as Record<string, unknown>).behaviorCheck;
    copy.description = standardCommandDescription;
    return copy;
  });
}

/** Called only after schema validation and normal command preflight. No execution path of its own. */
export function prepareBehaviorCheck(run: RunRecord, call: ToolCall, defaultCwd: string): boolean {
  if (call.name !== 'run_command' || !call.arguments.behaviorCheck) return false;
  const request = call.arguments.behaviorCheck as unknown as BehaviorCheckRequest;
  const command = call.arguments.command as string, cwd = (call.arguments.cwd as string) || defaultCwd;
  let previous = run.behaviorCheck;
  const frozen = previous?.locked || previous?.baseline?.status === 'reproduced' || previous?.latest?.status === 'passed';
  if (request.phase === 'baseline' && !request.failureContains)
    throw new AgentError('A baseline requires failureContains: a specific expected assertion failure, not a generic process error.');
  const changed = previous && (previous.description !== request.description || previous.command !== command || previous.cwd !== cwd
    || request.failureContains !== undefined && previous.failureContains !== request.failureContains);
  if (changed && (frozen || previous!.description !== request.description)) {
    if (!request.revisionReason?.trim() || request.revisionReason.trim().length < 20)
      throw new AgentError('The behavior suite is fixed by default. If your own assertion was incorrect, provide revisionReason explaining the correction with the new command. The old receipt will be archived and proof reset. User acceptance criteria cannot be weakened.');
    const { revisions, ...version } = previous!;
    run.behaviorCheck = { command, cwd, description: request.description, failureContains: request.failureContains,
      revisions: [...(revisions ?? []), { ...structuredClone(version), reason: request.revisionReason.trim() }] };
    previous = run.behaviorCheck;
  }
  if (previous?.baseline?.status === 'reproduced' && request.phase === 'baseline')
    throw new AgentError('The baseline receipt is already saved. Use phase regression to check the same command after the fix.');
  run.behaviorCheck ??= { command, cwd, description: request.description, failureContains: request.failureContains };
  if (!frozen) {
    // An unavailable interpreter or malformed reproduction must be repairable.
    // Its unsuccessful baseline is not carried over to a different command.
    if (run.behaviorCheck.command !== command || run.behaviorCheck.cwd !== cwd) delete run.behaviorCheck.baseline;
    Object.assign(run.behaviorCheck, { command, cwd, failureContains: request.failureContains ?? run.behaviorCheck.failureContains });
  }
  // Invalidate before execution: a denial, interruption or failed retry cannot reuse an old pass.
  delete run.behaviorCheck.latest;
  return true;
}

/** Trust backend process metadata, never parse "exit 0" or model-written claims from text. */
export function recordBehaviorCheck(run: RunRecord, call: ToolCall, result: ToolResult): ToolResult {
  const check = run.behaviorCheck!;
  const phase = (call.arguments.behaviorCheck as unknown as BehaviorCheckRequest).phase;
  const code = result.commandExit?.code;
  const observed = Number.isSafeInteger(code) && code! >= 0;
  const reproduced = phase === 'baseline' && observed && code !== 0 && Boolean(check.failureContains && result.text.includes(check.failureContains));
  const status = reproduced ? 'reproduced' : phase === 'regression' && observed && code === 0 && !result.error ? 'passed' : observed ? 'failed' : 'unconfirmed';
  if (status === 'reproduced' || status === 'passed') check.locked = true;
  const receipt: BehaviorCheckReceipt = { toolCallId: call.id, revision: run.mutationRevision ?? 0, scope: run.evidenceScope,
    ...(observed ? { exitCode: code } : {}), status };
  if (phase === 'baseline') check.baseline = receipt;
  check.latest = receipt;
  return { ...result, text: result.text + '\n' + JSON.stringify({ kind: 'behavior-check', ...behaviorCheckState(run),
    instruction: reproduced ? 'Expected failure observed. Fix the implementation, inspect related boundary cases, then rerun this exact command with phase regression.'
      : status === 'passed' ? 'This command passed. Its assertions prove only their tested scope; report any missing coverage.'
      : 'Behavior is not verified. Inspect the failure before retrying; a missing runtime or permission denial is not a reproduced bug.' }) };
}

export function behaviorCheckState(run: Pick<RunRecord, 'behaviorCheck' | 'mutationRevision' | 'evidenceScope'>) {
  const check = run.behaviorCheck;
  if (!check) return;
  const latest = check.latest;
  const fresh = latest && latest.revision === (run.mutationRevision ?? 0) && latest.scope === run.evidenceScope;
  const status = !latest ? 'unconfirmed' : !fresh ? 'stale' : latest.status;
  const baseline = check.baseline;
  return { description: check.description, command: check.command, cwd: check.cwd, status,
    revisions: check.revisions?.length ?? 0,
    ...(check.revisions?.length ? { lastRevisionReason: check.revisions.at(-1)!.reason } : {}),
    baseline: baseline?.status ?? 'not-recorded',
    failureThenPass: status === 'passed' && baseline?.status === 'reproduced'
      && baseline.scope === run.evidenceScope && baseline.revision < latest!.revision,
    scope: 'Observed command outcome only. Test relevance, assertion completeness and unchanged test files still require assessment.' };
}
