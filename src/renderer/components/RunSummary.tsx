import { CheckCircle2, CirclePause, Play, ShieldCheck, Signal, TriangleAlert } from 'lucide-react';
import type { RunRecord } from '../../shared/types';
import { Busy } from './Common';

export const runStatusLabel: Record<RunRecord['status'], string> = { running: 'Выполняется', completed: 'Ответ завершён', stopped: 'Остановлен', error: 'Ошибка', limited: 'Достигнут бюджет', incomplete: 'Ответ не завершён', interrupted: 'Прерван при закрытии' };
export const runPhaseLabel: Record<RunRecord['phase'], string> = { context: 'Собирает контекст', model: 'Запрашивает модель', tools: 'Выполняет инструменты', verification: 'Проверяет результат', naming: 'Создаёт название', final: 'Завершает запуск' };
const reasons: Record<NonNullable<RunRecord['limitReason']>, string> = { steps: 'шаги', tokens: 'токены', cost: 'стоимость', duration: 'время', output: 'длина ответа' };
export function costLabel(run: RunRecord) {
  if (run.usage.costUsd === undefined || run.usage.costSource === 'unknown' && run.usage.costUsd === 0) return 'Стоимость неизвестна';
  const money = run.usage.costUsd.toFixed(run.usage.costUsd > 0 && run.usage.costUsd < 0.0001 ? 6 : 4);
  if (run.usage.costSource === 'unknown') return `от $${money} (часть стоимости неизвестна)`;
  return `${run.usage.costSource === 'estimated' || run.usage.costSource === 'mixed' ? '≈ ' : ''}$${money}`;
}
export function RunSummary({ run, busy = false, locked = false, canVerify = false, onContinue, onVerify, onDetails }: {
  run: RunRecord; busy?: boolean; locked?: boolean; canVerify?: boolean; onContinue?: () => void; onVerify?: () => void; onDetails?: () => void;
}) {
  const verification = run.verification;
  const stale = Boolean(verification && verification.status !== 'running' && run.mutationRevision !== undefined && run.verifiedRevision !== run.mutationRevision);
  const active = run.status === 'running';
  return <section className="run-summary" data-testid="run-summary" aria-live="polite">
    <div className="run-summary-heading">{active ? <Signal size={14} /> : run.status === 'completed' ? <CheckCircle2 size={14} /> : run.status === 'error' ? <TriangleAlert size={14} /> : <CirclePause size={14} />}
      <strong>{active ? runPhaseLabel[run.phase] : runStatusLabel[run.status]}</strong>{run.limitReason && <span>· {reasons[run.limitReason]}</span>}
    </div>
    <div className="run-summary-facts"><span>{run.steps} шагов</span><span>{(run.usage.inputTokens + run.usage.outputTokens).toLocaleString('ru')} токенов{run.usage.tokenSource !== 'reported' ? ' · оценка' : ''}</span><span>{costLabel(run)}</span></div>
    <div className={`verification-label ${stale ? 'unknown' : verification?.status || 'unknown'}`} data-testid="verification-status"><ShieldCheck size={13} />{stale ? 'Требуется новая проверка' : verification?.status === 'passed' ? 'Проверка пройдена' : verification?.status === 'failed' ? 'Проверка не пройдена' : verification?.status === 'running' ? 'Проверка выполняется' : verification?.status === 'cancelled' ? 'Проверка отменена' : verification?.status === 'skipped' ? 'Проверка пропущена' : 'Проверка не запускалась'}</div>
    {(onDetails || onContinue && run.canContinue || canVerify && onVerify) && <div className="run-summary-actions">
      {run.canContinue && onContinue && <button className="secondary-button" data-testid="run-continue" disabled={busy || locked || active || verification?.status === 'running'} onClick={onContinue}>{busy ? <Busy text="Выполняем…" /> : <><Play size={12} />Продолжить</>}</button>}
      {canVerify && onVerify && <button className="secondary-button" data-testid="run-verify" disabled={busy || locked || active || verification?.status === 'running'} onClick={onVerify}><ShieldCheck size={13} />Проверить результат</button>}
      {onDetails && <button className="text-button" onClick={onDetails}>Журнал запуска</button>}
    </div>}
  </section>;
}
