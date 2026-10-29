/** A chat permission mode; missing legacy values retain the existing behavior. */
export type AgentMode = 'plan' | 'auto-edit' | 'ask' | 'bypass';

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'plan' || value === 'auto-edit' || value === 'ask' || value === 'bypass';
}

export function agentMode(value: unknown): AgentMode {
  if (value === undefined) return 'auto-edit';
  if (!isAgentMode(value)) throw new Error('Неизвестный режим чата. Выберите допустимый режим в настройках разговора.');
  return value;
}
