import { ChevronDown } from 'lucide-react';
import type { ContextReport, RunUsage } from '../../shared/types';
import { cacheShareLabel } from '../context-cache';

export function ContextBadge({ context, usage, onDetails }: { context?: ContextReport; usage?: RunUsage; onDetails: () => void }) {
  const cache = cacheShareLabel(usage);
  const details = context ? [`Контекст перед последним запросом: ≈ ${context.estimatedTokens.toLocaleString('ru')} из ${context.budget.toLocaleString('ru')} токенов.`,
    ...context.sections.map(section => `${section.name}: ≈ ${section.tokens.toLocaleString('ru')}`)] : ['Откройте состав контекста.'];
  if (usage) details.push(`Последний запуск: ${cache}. Вход из кэша входит во входные токены; стоимость API учитывает его тариф.`);
  return <button data-testid="context-details-open" onClick={onDetails} title={details.join('\n')} aria-label="Состав контекста и использование кэша">{context ? `≈ ${context.estimatedTokens.toLocaleString('ru')} / ${context.budget.toLocaleString('ru')} токенов` : 'Контекст'}{usage && <span data-testid="context-cache-share"> · {cache}</span>}<ChevronDown size={10} /></button>;
}
