import type { ChatMessage } from '../shared/types';

export interface AssistantResponse {
  kind: 'response'; id: string; activity: ChatMessage[]; answer?: ChatMessage; active: boolean;
}
export type ConversationEntry = { kind: 'user'; id: string; message: ChatMessage } | AssistantResponse;

/** Groups public progress and tool results; provider reasoning payloads are never read. */
export function conversationActivity(messages: ChatMessage[], active = false, activeStartedAt?: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const answerPositions = new Map<string, number>();
  let scope = 'history', ordinal = 0, pending: AssistantResponse | undefined;
  const current = () => pending ??= { kind: 'response', id: `${scope}-response-${ordinal}`, activity: [], active: false };
  const flush = () => { if (pending) { entries.push(pending); pending = undefined; ordinal++; } };
  const keepEarlierAnswer = (response: AssistantResponse) => {
    if (!response.answer) return;
    if (!response.activity.some(item => item.id === response.answer!.id)) response.activity.splice(answerPositions.get(response.id) ?? response.activity.length, 0, response.answer);
    response.answer = undefined; answerPositions.delete(response.id);
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      flush(); entries.push({ kind: 'user', id: message.id, message }); scope = message.id; ordinal = 0;
    } else if (message.role === 'tool' || message.toolCalls?.length) {
      if (message.runtimeKind === 'verification' && !pending) {
        const previous = entries.at(-1);
        if (previous?.kind === 'response' && previous.answer) {
          // Verification belongs to the candidate answer immediately before it.
          // Reopen the same response instead of exposing an earlier successful
          // final answer next to a separate, possibly failed verification.
          entries.pop(); pending = previous; ordinal = Math.max(0, ordinal - 1);
        }
      }
      const response = current();
      const failedVerification = message.role === 'tool' && message.error && response.activity.some(item => item.runtimeKind === 'verification' && item.toolCalls?.some(call => call.id === message.toolCallId));
      if (response.answer && (failedVerification || message.role === 'assistant' && message.runtimeKind !== 'verification')) keepEarlierAnswer(response);
      response.activity.push(message);
    } else {
      const response = current();
      keepEarlierAnswer(response);
      response.answer = message; answerPositions.set(response.id, response.activity.length); flush();
    }
  }
  flush();
  if (active) {
    const last = entries.at(-1);
    // A continuation starts a new response instead of hiding a previous final answer.
    const previousAnswer = last?.kind === 'response' && last.answer && activeStartedAt
      && Date.parse(last.answer.createdAt) < Date.parse(activeStartedAt);
    let response: AssistantResponse;
    if (last?.kind === 'response' && !previousAnswer && !last.answer?.error) response = last;
    else { response = { kind: 'response', id: `${scope}-response-${ordinal}`, activity: [], active: false }; entries.push(response); }
    response.active = true;
    keepEarlierAnswer(response);
  }
  return entries;
}

export function responseMessages(response: AssistantResponse): ChatMessage[] {
  return response.answer ? [...response.activity, response.answer] : response.activity;
}

export function activityCounts(messages: ChatMessage[]): { steps: number; tools: number; errors: number } {
  const calls = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
  const results = messages.filter(message => message.role === 'tool');
  const orphanResults = results.filter(message => !message.toolCallId || !calls.has(message.toolCallId));
  return { steps: messages.filter(message => message.role === 'assistant' && message.runtimeKind !== 'verification').length, tools: calls.size + orphanResults.length, errors: results.filter(message => message.error).length };
}
