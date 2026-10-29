import type { Project, RunRecord } from '../shared/types';
import { completionResult } from './task-contract';
import { freshVerification } from './verification';

/** Advisory context only: the runtime completion gates and tool catalog are unchanged. */
export function completionGuidance(run: RunRecord, project: Project): string | undefined {
  if (!run.verification && !run.behaviorCheck && !run.counterexampleReview?.attempts) return;
  const contract = JSON.parse(completionResult(run).text);
  // Do not append a fresh review cue after a clean pass; the actual receipt is
  // already in history. Surface only facts that still require attention.
  if (freshVerification(run, project) && run.verification?.status === 'passed'
    && !contract.missingCriteria.length && !contract.uncertainOperations.length && !run.behaviorCheck && !run.counterexampleReview?.attempts) return;
  return JSON.stringify({ kind: 'completion-state',
    verification: freshVerification(run, project) ? run.verification?.status : run.verification ? 'stale' : 'not-run',
    behaviorCheck: contract.behaviorCheck,
    counterexampleReview: contract.counterexampleReview,
    missingCriteria: contract.missingCriteria.map((item: { id: string }) => item.id),
    uncertainOperations: contract.uncertainOperations.map((item: { operationId: string }) => item.operationId),
    scope: 'Configured check and registered criteria only; other requested behavior still needs assessment.' });
}
