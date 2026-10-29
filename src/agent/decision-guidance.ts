import type { ToolDefinition } from '../shared/types';

/** Avoid spending small code/file contexts on advice for external record mutations. */
export function hasRecordActions(tools: ToolDefinition[]): boolean {
  const references = (schema: unknown, depth = 0): boolean => {
    if (!schema || typeof schema !== 'object' || depth > 8) return false;
    const s = schema as Record<string, unknown>;
    const properties = s.properties as Record<string, unknown> | undefined;
    return !!properties && Object.entries(properties).some(([key, child]) =>
      /(?:^|_)(?:ids?|emails?|number)$/i.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')) || references(child, depth + 1))
      || references(s.items, depth + 1);
  };
  return tools.some(t => (t.permission === 'write' || t.permission === 'mcp') && references(t.parameters));
}

/** A task-solving procedure, not domain policy or a second source of facts. */
export const decisionGuidance = `Before proposing a consequential choice, refusing a requested action, or claiming a task finished, resolve the decision from the user's request and observed records:
1. Keep the requested outcomes and constraints distinct: target object, allowed candidate set, required attributes, optimization/rank, cost limit, and payment destination. Preserve earlier constraints unless the user actually changes them. Confirmation of your proposal does not make your earlier claim that it was cheapest or eligible true. If a choice conflicts with the original objective, correct the proposal before asking for confirmation.
2. Restrict the candidate set FIRST, then compare every eligible option in that set. "Among these records" is different from "any matching record in the catalogue". For multi-part alternatives compare complete totals in the requested category, not the first component or the original route. For an ordinal choice, sort the eligible complete totals numerically; do not confuse cheapest with second cheapest. Use computed comparison data or an available calculator; do not guess arithmetic from a long list. Respect availability and ties. Do not invent a preference to break an unresolved tie.
3. Bind each observation to its own object and field. A destination address on one record is not proof that a related profile was updated. Identify the exact before-state and desired after-state, then look for the successful action result on that target. A proposal, confirmation, or successful lookup is not a mutation receipt.
4. Check the scope of a policy condition and any explicit exception for the actual fields being changed. A tool name can implement several operations with different eligibility rules. Do not extend a prohibition on one kind of change to all changes, or invent an exception. If the requested path is prohibited, consider a policy-permitted alternative and explain its consequences before acting.
5. For multiple requested changes, reason about their dependencies and resulting states BEFORE the first mutation. Preserve the preconditions for remaining actions; combine same-kind changes when an operation is one-shot. If no allowed ordering can complete the full request, explain the conflict and obtain the user's choice before partially committing. Inspect the result after each mutation and re-plan from the actual state. Before ending, account for each requested outcome as done, waiting for input, or explicitly unresolved. Keep this reasoning concise; do not add a ceremony or repeat confirmations already given.`;
