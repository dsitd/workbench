/** Harness policy bounds in one place. Protocol parsing and validation size guards stay next to their parsers. */

/** Tokens kept free beside the configured output for message framing and estimation error. */
export const CONTEXT_RESERVE_TOKENS = 1024;
/** Model-facing tool output; start and end are kept, ranged reads recover the middle. */
export const TOOL_OUTPUT_CHARS = 18_000;
/** Service output retained locally before the model-facing bound; half from each end. */
export const LOCAL_TOOL_OUTPUT_CHARS = 128_000;
/** Tool calls one model response may declare. */
export const MAX_TOOL_CALLS_PER_STEP = 16;
/** Independent native reads executed at once; results still commit in declaration order. */
export const PARALLEL_READS = 4;
/** Identical call/result observations before the next identical call is blocked. */
export const REPEAT_LIMIT = 3;
/** Completion-contract checks before a run stops as unconfirmed. */
export const COMPLETION_ATTEMPTS = 3;
/** Consecutive empty answers, or malformed-argument batches, that end the run. */
export const EMPTY_RESPONSE_LIMIT = 2;
export const INVALID_ARGUMENTS_LIMIT = 2;
/** Read-only explore_code helper; all requests share the parent run budget. */
export const EXPLORE_LIMITS = { requests: 6, outputTokens: 1200, toolOutputChars: 6000, summaryChars: 6000 } as const;
/** Hard size of the model memory section for omitted history, in local estimate units. */
export const MODEL_SUMMARY_MAX_TOKENS = 1200;
/** Attachment metadata entries listed with a user message; image message IDs remembered as already presented. */
export const PROMPT_ATTACHMENTS = 24;
export const PRESENTED_IMAGES = 256;
