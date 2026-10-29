import type { ChatMessage, RunRecord, ToolCall } from '../shared/types';
import { AgentError } from './errors';

/** Only append to an unfinished final group; never move or overwrite persisted history. */
export function recoveryCalls(history: ChatMessage[], parent: RunRecord): ToolCall[] {
  const userId = parent.checkpoint?.userMessageId;
  const latestUser = [...history].reverse().find(item => item.role === 'user');
  if (!userId || latestUser?.id !== userId)
    throw new AgentError('Этот запуск нельзя продолжить: отсутствует исходная задача или после неё уже отправлена новая. Продолжите последнюю задачу.');
  const start = history.findIndex(item => item.id === userId);
  for (let index = start + 1; index < history.length; index++) {
    const assistant = history[index];
    if (!assistant.toolCalls?.length) continue;
    const calls = assistant.toolCalls;
    const tail = history.slice(index + 1);
    const results = tail.slice(0, calls.length);
    let paired = 0;
    while (paired < results.length && results[paired].role === 'tool' && results[paired].toolCallId === calls[paired].id) paired++;
    if (paired === calls.length) { index += paired; continue; }
    if (tail.length !== paired || new Set(calls.map(call => call.id)).size !== calls.length)
      throw new AgentError('История содержит нарушенную пару инструментов. Автоматическое продолжение отклонено; начните новую задачу, указав текущее состояние файлов.');
    return calls.slice(paired);
  }
  return [];
}
