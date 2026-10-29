import { useState } from 'react';
import { Clock3, ListChecks } from 'lucide-react';
import type { Project, RunRecord, Session, VerificationResult } from '../../shared/types';
import { api, errorText } from '../api';
import { useRunJournal } from '../hooks/useRunJournal';
import { Busy, ErrorNote } from './Common';
import { costLabel, RunSummary, runStatusLabel } from './RunSummary';
import { isRunActive } from '../state';
import { CacheUsage, StepCacheUsage } from './CacheUsage';
import { ContextCacheTrace } from './ContextCacheTrace';
import { TaskEvidence } from './TaskEvidence';

export function RunsPanel({ project, session }: { project: Project; session?: Session }) {
  const { runs, error: loadError } = useRunJournal(project.id, session?.id);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = runs.find((run) => run.id === selectedId) || runs[0];
  const locked = Boolean(session?.archivedAt) || session?.status === 'running' || session?.status === 'approval' || runs.some(isRunActive);
  const action = async (kind: 'continue' | 'verify') => {
    if (!selected || locked) return; setBusy(true); setError(undefined);
    try { if (kind === 'continue') await api.continueRun(selected.sessionId, selected.id); else await api.verifyRun(selected.sessionId, selected.id); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return <div className="run-panel panel-scroll"><ErrorNote text={loadError || error} />
    <div className="panel-section-heading"><Clock3 size={14} /><h3>Журнал запусков</h3></div>
    {runs.length === 0 ? <div className="panel-empty"><Clock3 size={26} /><p>После первого запуска появятся шаги, стоимость и результаты проверки.</p></div> : <>
      <div className="run-list">{runs.map((run) => <button className={`panel-list-item ${selected?.id === run.id ? 'active' : ''}`} key={run.id} aria-pressed={selected?.id === run.id} onClick={() => setSelectedId(run.id)}>
        <strong>{run.kind === 'title' ? 'Название чата' : runStatusLabel[run.status]}</strong><span>{new Date(run.startedAt).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {costLabel(run)}</span>
      </button>)}</div>
      {selected && <><RunSummary run={selected} busy={busy} locked={locked} canVerify={Boolean(project.verificationCommand && session?.mode !== 'plan' && selected.kind !== 'title')}
        onContinue={() => void action('continue')} onVerify={() => void action('verify')} />
        <TaskEvidence run={selected} />
        <div className="run-detail-facts"><div><span>Модель</span><strong>{selected.modelIdentifier || selected.modelId}</strong></div><div><span>Стоимость</span><strong>{selected.usage.costSource === 'api' ? 'Данные API' : selected.usage.costSource === 'estimated' ? 'Оценка по тарифам' : selected.usage.costSource === 'mixed' ? 'API и оценка' : 'Неизвестна'}</strong></div>
          <div><span>Вход / выход{selected.usage.tokenSource !== 'reported' ? ' · оценка' : ''}</span><strong>{selected.usage.inputTokens.toLocaleString('ru')} / {selected.usage.outputTokens.toLocaleString('ru')}</strong></div><CacheUsage usage={selected.usage} />{selected.durationMs !== undefined && <div><span>Время</span><strong>{Math.round(selected.durationMs / 1000)} с</strong></div>}
        </div>{selected.error && <ErrorNote text={selected.error} />}
        {selected.plan?.length ? <section className="run-plan"><div className="panel-section-heading"><ListChecks size={14} /><h3>План</h3></div>{selected.plan.map((item, index) => <div key={index} className={`plan-item ${item.status}`}><span>{item.status === 'completed' ? '✓' : item.status === 'running' ? '•' : '○'}</span><p>{item.text}</p></div>)}</section> : null}
        <RunVerificationHistory run={selected} />
        <div className="panel-section-heading"><h3>Шаги</h3></div>{selected.stepLog.map((step) => <details className="run-step" key={step.index}><summary>Шаг {step.index}{step.kind === 'action-review' ? ' · Проверка действия' : step.kind === 'compaction' ? ' · Суммаризация истории' : step.kind === 'explore' ? ' · Исследование кода' : ''} · {Math.round(step.durationMs / 1000)} с{step.retries ? ` · повторов: ${step.retries}` : ''}</summary><p>{step.toolNames.length ? step.toolNames.join(', ') : step.kind === 'compaction' ? 'Обновление памяти истории' : step.kind === 'explore' ? 'Ответ исследователя' : 'Ответ модели'}</p><p className="field-help">{step.inputTokens.toLocaleString('ru')} вход · {step.outputTokens.toLocaleString('ru')} выход{step.costUsd !== undefined ? ` · $${step.costUsd.toFixed(4)}` : ''}</p><StepCacheUsage usage={step} /><ContextCacheTrace trace={step.contextCache} />{step.errors.map((text, index) => <ErrorNote key={index} text={text} />)}</details>)}
      </>}
    </>}{busy && <Busy text="Выполняем…" />}
  </div>;
}

export function RunVerificationHistory({ run }: { run: RunRecord }) {
  const records = new Map<string, VerificationResult>();
  for (const result of run.verificationHistory ?? []) { records.delete(result.id); records.set(result.id, result); }
  // Manual verification can replace the current evidence without entering the
  // bounded repair history. Its freshest copy belongs at the end exactly once.
  if (run.verification) { records.delete(run.verification.id); records.set(run.verification.id, run.verification); }
  const results = [...records.values()];
  if (!results.length) return null;
  const labels: Record<VerificationResult['status'], string> = { passed: 'Пройдена', failed: 'Не пройдена', running: 'Выполняется', cancelled: 'Отменена', skipped: 'Пропущена' };
  return <section className="run-verification"><div className="panel-section-heading"><h3>Проверки проекта</h3></div>{results.map((result, index) => <details className="run-step" key={result.id} data-testid="verification-history-entry" data-verification-id={result.id} open={index === results.length - 1}>
    <summary>Проверка {index + 1} · {labels[result.status]}{result.id === run.verification?.id ? ' · Последняя' : ''}</summary><code className="panel-command">{result.command}</code><p className="field-help">{result.cwd}{result.exitCode !== undefined ? ` · код ${result.exitCode}` : ''}</p><pre className="panel-output">{result.output || 'Вывод отсутствует'}</pre>
  </details>)}</section>;
}
