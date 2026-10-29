import { createHash } from 'node:crypto';
import type { RunRecord, ToolCall, ToolResult } from '../shared/types';

export const PROGRESS_REVIEW_TURNS = 8;
export const PROGRESS_STOP_TURNS = 16;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function beginProgressTurn(run: RunRecord): void {
  if (run.searchProgress) run.searchProgress.turnsWithoutEvidence++;
}

/** Conservative signals, not a semantic proof of progress. Writes, prose and new errors do not count. */
export function observeSearchProgress(run: RunRecord, call: ToolCall, result: ToolResult): void {
  if (!run.searchProgress || result.error) return;
  if (call.name === 'read_file' && result.text.trim()) {
    // Reading our own successive edits must not reset the search clock indefinitely.
    recordProgress(run, ['read', call.arguments.path, call.arguments.startLine ?? 1, call.arguments.endLine ?? null]);
  }
  if (call.name === 'verify_project' && run.verification?.status === 'passed')
    recordProgress(run, ['project-check', run.verification.command, run.verification.cwd]);
  if (call.name === 'run_command' && result.commandExit?.code === 0) {
    if (run.counterexampleReview?.latest?.toolCallId === call.id && run.counterexampleReview.latest.status === 'passed')
      recordProgress(run, ['counterexample', run.counterexampleReview.probe?.command, run.counterexampleReview.probe?.cwd]);
    if (run.behaviorCheck?.latest?.toolCallId === call.id && run.behaviorCheck.latest.status === 'passed')
      recordProgress(run, ['behavior', run.behaviorCheck.command, run.behaviorCheck.cwd]);
  }
}

function recordProgress(run: RunRecord, fact: unknown): void {
  const state = run.searchProgress!, key = digest(fact);
  if (state.evidenceKeys.includes(key)) return;
  // Never evict old fingerprints: revisiting an old fact is not new progress.
  if (state.evidenceKeys.length >= 256) return;
  state.evidenceKeys.push(key);
  state.turnsWithoutEvidence = 0;
  state.warned = false;
}

export function progressWarning(run: RunRecord): string | undefined {
  const state = run.searchProgress;
  if (!state || state.turnsWithoutEvidence < PROGRESS_REVIEW_TURNS) return;
  if (!state.warned) { state.warned = true; state.warningCount++; }
  return JSON.stringify({ kind: 'search-progress', turnsWithoutEvidence: state.turnsWithoutEvidence,
    stopAfter: PROGRESS_STOP_TURNS,
    instruction: 'No new tracked evidence. Change the hypothesis or obtain a discriminating observation. New edits, plans, command spellings and failure text do not reset this counter. Inspect unread relevant code or execute the registered assertion suite. Request search_counterexamples with a concrete reason if its proposed test is wrong. Do not repeat failed work. This is a conservative heuristic, not a verdict about the task.' });
}

export function searchStalled(run: RunRecord): boolean {
  return (run.searchProgress?.turnsWithoutEvidence ?? 0) >= PROGRESS_STOP_TURNS;
}

export const stalledSearchText = 'Поиск приостановлен: 16 шагов без новых отслеживаемых свидетельств. Изменения и проверки сохранены; задача не объявлена решённой. Продолжение даст новое окно поиска. Проверьте гипотезу и область проверки.';
