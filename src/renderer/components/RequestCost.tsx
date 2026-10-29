import type { CostSummary } from '../request-costs';
import { costDescription, moneyLabel } from '../request-costs';

export function RequestCost({ cost, onDetails }: { cost: CostSummary; onDetails: () => void }) {
  return <button className="request-cost" data-testid="request-cost" title={costDescription(cost)} onClick={onDetails}>
    <span>Запрос</span><span aria-hidden="true">·</span><span>{moneyLabel(cost)}</span>
  </button>;
}

export function ChatCost({ cost, unassignedRuns, onDetails, error }: { cost: CostSummary; unassignedRuns: number; onDetails: () => void; error?: string }) {
  return <button className="chat-cost" data-testid="chat-total-cost" title={error || costDescription(cost, true, unassignedRuns)} onClick={onDetails}>
    Чат · {error ? 'Расходы недоступны' : moneyLabel(cost)}
  </button>;
}
