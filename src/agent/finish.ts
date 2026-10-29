import type { ToolDefinition } from '../shared/types';

/** A completion request is a claim; the runtime still owns every acceptance gate. */
export const finishTool: ToolDefinition = {
  name: 'finish_task', permission: 'read',
  description: 'Submit the final summary when the requested work is ready. Runtime runs configured verification and checks existing criteria and uncertain operations before accepting it. Use alone, never alongside other tool calls. A rejected check returns control for repair.',
  parameters: {
    type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 4000 } },
    required: ['summary'], additionalProperties: false,
  },
};
