import type { Project, RunRecord, ToolDefinition, ToolResult, VerificationResult } from '../shared/types';

export const verificationTool: ToolDefinition = {
  name: 'verify_project', permission: 'command',
  description: 'Run the configured verification through normal approvals and sandbox. Use this instead of run_command for that check: records evidence and reuses a fresh result. After a pass, finish if the task and existing criteria are satisfied. After failure, fix and retry; do not repeat unchanged checks.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
export const VERIFICATION_HISTORY_LIMIT = 16;
export function freshVerification(run: RunRecord, project: Project): boolean {
  const result = run.verification;
  return Boolean(result && result.runId === run.id && result.projectId === run.projectId && run.projectId === project.id
    && result.sessionId === run.sessionId && run.verifiedRevision === (run.mutationRevision ?? 0) && result.command === project.verificationCommand
    && result.cwd === project.folders[0]?.path && result.status !== 'running');
}
export function verificationResult(result: VerificationResult): ToolResult {
  return { text: JSON.stringify({ status: result.status, command: result.command, cwd: result.cwd, exitCode: result.exitCode,
    output: result.output.slice(0, 7000) + (result.output.length > 9000 ? '\n[Middle verification output omitted]\n' + result.output.slice(-2000) : result.output.slice(7000)),
    instruction: result.status === 'passed' ? 'The configured check passed and its receipt is saved. It does not establish coverage of the reported bug or related boundary cases. If requested behavior and registered checks are verified, finish now. Otherwise perform the missing behavioral check. Reuse this receipt unless changes invalidate it; report only the scope actually tested.' : 'Verification did not pass. Inspect this result, repair the failure, and recheck within the remaining run budget. Respect declined permissions; do not evade or repeat a refused check without new user authorization. Do not claim the task is verified.' }), error: result.status !== 'passed' };
}
