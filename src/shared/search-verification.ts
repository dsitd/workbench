/** Experimental search state. Model proposals are not observed proof. */
export interface CounterexampleProbe {
  focus: string;
  command: string;
  cwd: string;
  expected: string;
  failureContains: string;
}
export interface CounterexampleReceipt {
  toolCallId: string; revision: number; scope?: string; exitCode?: number;
  status: 'passed' | 'counterexample' | 'failed' | 'unconfirmed';
}
export interface CounterexampleReview {
  attempts: number;
  status: 'pending' | 'ready' | 'unavailable';
  reason?: string;
  probe?: CounterexampleProbe;
  latest?: CounterexampleReceipt;
  /** Preserve rejected proposals and receipts; a revision never inherits their proof. */
  revisions: { probe?: CounterexampleProbe; latest?: CounterexampleReceipt; reason: string }[];
}
export interface SearchProgress {
  turnsWithoutEvidence: number;
  evidenceKeys: string[];
  warningCount: number;
  warned: boolean;
  /** Resuming explicitly grants a fresh observation window, keeping prior evidence. */
  resumes: number;
}
