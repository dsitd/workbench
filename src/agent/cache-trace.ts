import type { ContextSelectionState } from '../shared/context';
import type { ContextCacheTrace } from '../shared/runs';

/** Describes local selection, not provider routing, tokenizer counts, or cache hits. */
export function contextCacheTrace(previous: ContextSelectionState | undefined, current: ContextSelectionState): ContextCacheTrace {
  const sameEpoch = previous?.epoch === current.epoch;
  const reason = current.lastCompaction?.reason;
  const transition = !previous ? 'initial' : sameEpoch ? 'append'
    : reason === 'budget' ? 'compaction' : reason === 'history-change' ? 'history-change'
      : reason === 'policy-change' ? 'policy-change' : 'initial';
  return {
    epoch: current.epoch, transition,
    historyPrefixPreserved: Boolean(previous && sameEpoch && previous.policyHash === current.policyHash
      && previous.providerId === current.providerId
      && previous.selectedMessageIds.every((id, index) => current.selectedMessageIds[index] === id)),
    removedMessageCount: sameEpoch ? 0 : current.lastCompaction?.removedMessageCount ?? 0,
    retainedMessageCount: current.selectedMessageIds.length,
  };
}
