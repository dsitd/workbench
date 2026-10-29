import type { PlanItem, ToolDefinition } from '../shared/types';
import { AgentError } from './errors';

export const planTool: ToolDefinition = {
  name: 'update_plan', permission: 'read',
  description: 'Optional checklist for complex work spanning multiple changes. Small inspect/edit/test tasks do not need a plan. Statuses: pending, running (also accepts in_progress), completed. Journal metadata only; not completion evidence.',
  parameters: { type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 30, items: {
    type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 280 }, status: { type: 'string', enum: ['pending', 'running', 'in_progress', 'completed'] } },
    required: ['text', 'status'], additionalProperties: false,
  } } }, required: ['items'], additionalProperties: false },
};

export function checkedPlan(arguments_: Record<string, unknown>): PlanItem[] {
  const items = arguments_.items;
  if (Object.keys(arguments_).some(key => key !== 'items') || !Array.isArray(items) || !items.length || items.length > 30)
    throw new AgentError('План должен содержать от 1 до 30 пунктов.');
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['text', 'status'].includes(key))
      || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 280 || /[\x00-\x1f]/.test(item.text)
      || !['pending', 'running', 'in_progress', 'completed'].includes(item.status)) throw new AgentError('Некорректный пункт плана: текст до 280 символов и статус pending, running или completed (in_progress также допустим).');
    return { text: item.text.trim(), status: item.status === 'in_progress' ? 'running' : item.status } as PlanItem;
  });
}
