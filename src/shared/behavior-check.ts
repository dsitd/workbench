/** One reproducible command suite per run; the description is a model claim. */
export const standardCommandDescription = 'Run a command inside the macOS sandbox. Writes are limited to writable project roots and disposable scratch; credentials are blocked. Requires approval if command policy is ask. Fails closed when sandbox is unavailable.';
export interface BehaviorCheckRequest {
  phase: 'baseline' | 'regression';
  description: string;
  failureContains?: string;
  revisionReason?: string;
}
export interface BehaviorCheckReceipt {
  toolCallId: string; revision: number; scope?: string; exitCode?: number;
  status: 'reproduced' | 'passed' | 'failed' | 'unconfirmed';
}
export interface BehaviorCheck {
  command: string; cwd: string; description: string; failureContains?: string;
  locked?: boolean;
  baseline?: BehaviorCheckReceipt;
  latest?: BehaviorCheckReceipt;
  revisions?: (Omit<BehaviorCheck, 'revisions'> & { reason: string })[];
}
export const behaviorCheckSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    phase: { type: 'string', enum: ['baseline', 'regression'] },
    description: { type: 'string', minLength: 3, maxLength: 600 },
    failureContains: { type: 'string', minLength: 3, maxLength: 300 },
    revisionReason: { type: 'string', minLength: 20, maxLength: 800 },
  }, required: ['phase', 'description'],
};
