import type { RunRecord } from '../../shared/types';
import { nonEvidenceTools } from '../../shared/evidence-policy';

export function TaskEvidence({ run }: { run: RunRecord }) {
  const criteria = run.acceptanceCriteria ?? [], operations = run.operations ?? [];
  if (!criteria.length && !operations.length) return null;
  const fresh = (item: typeof criteria[number]) => item.toolName && item.expectedText && !nonEvidenceTools.has(item.toolName) && item.evidence && item.evidence.revision === (run.mutationRevision ?? 0) && item.evidence.scope === run.evidenceScope;
  const labels = { running: 'Выполняется', confirmed: 'Результат сохранён', failed: 'Команда завершилась с ошибкой', uncertain: 'Исход неизвестен — требуется проверка', 'not-executed': 'Повтор разрешён пользователем' };
  return <section className="run-verification" data-testid="task-evidence">
    {criteria.length > 0 && <details className="run-step" open><summary>Критерии задачи · подтверждено {criteria.filter(fresh).length} из {criteria.length}</summary>
      <ul>{criteria.map(item => <li key={item.id}><strong>{fresh(item) ? 'Подтверждено' : item.evidence ? 'Требуется новая проверка' : 'Ожидает проверки'}</strong> · {item.text}</li>)}</ul>
      <p className="field-help">Подтверждение относится к зарегистрированному способу проверки.</p>
    </details>}
    {operations.length > 0 && <details className="run-step"><summary>Результаты действий</summary><ul>{operations.map(item => <li key={item.id}>{item.toolName} · {labels[item.status]}</li>)}</ul></details>}
  </section>;
}
