import { diffLines } from 'diff';
import { FileWarning, RefreshCw } from 'lucide-react';
import { Busy } from './Common';

/** A review surface only: the parent retains the draft and controls versioned saves. */
export function ConflictReview({ currentContent, draft, busy, onReload, onDraft, onReviewed }: {
  currentContent: string; draft: string; busy: boolean; onReload: () => void;
  onDraft: (value: string) => void; onReviewed: () => void;
}) {
  return <section className="conflict-review" data-testid="file-conflict" aria-label="Сверка изменившегося файла">
    <div className="conflict-review-heading"><FileWarning size={16} aria-hidden="true" /><strong>Файл изменился на диске</strong></div>
    <p>Ваша правка сохранена в редакторе. Сверьте её с актуальным файлом и объедините нужные изменения.</p>
    <button className="secondary-button" disabled={busy} data-testid="conflict-reread" onClick={onReload}>
      {busy ? <Busy text="Перечитываем…" /> : <><RefreshCw size={13} />Перечитать файл</>}
    </button>
    <details open className="conflict-comparison"><summary>Различия: файл на диске → ваша правка</summary>
      <pre>{diffLines(currentContent, draft).map((part, index) => <span key={index} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</span>)}</pre>
    </details>
    <label className="field"><span>Объединённый текст</span><textarea className="config-textarea" data-testid="conflict-merged-text"
      aria-label="Объединённый текст файла" value={draft} onChange={(event) => onDraft(event.target.value)} spellCheck={false} rows={8} /></label>
    <button className="secondary-button" disabled={busy} data-testid="conflict-reviewed" onClick={onReviewed}>Продолжить с этим текстом</button>
    <p className="field-help">После сверки сохраните файл обычной кнопкой. Повторное изменение снова потребует сверки.</p>
  </section>;
}
