/** Metadata for an append-only prompt epoch; never stores tool output or image bytes. */
export interface ContextUsageBaseline {
  version: 1; providerId: string; policyHash: string;
  /** Hashes of the exact stable history sent before volatile reference data. */
  prefixHashes: string[];
  /** Inclusive input count actually reported by the provider, never a billing estimate. */
  inputTokens: number;
}

export interface ContextSelectionState {
  version: 1;
  taskMessageId: string;
  providerId: string;
  /** Fresh system instructions and tool schemas; changing policy invalidates the epoch. */
  policyHash: string;
  epoch: number;
  selectedMessageIds: string[];
  /** Detect same-ID edits or changed materialization without storing prompt content. */
  selectedContentHash: string;
  /** Last considered storage message, including omitted/incomplete groups. */
  throughMessageId?: string;
  targetTokens: number;
  rulePaths: string[];
  lastCompaction?: {
    reason: 'initial' | 'budget' | 'history-change' | 'policy-change';
    removedMessageCount: number;
    retainedMessageCount: number;
  };
}
