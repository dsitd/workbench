import type { ContextCacheTrace as Trace } from '../../shared/runs';

const labels: Record<Trace['transition'], string> = {
  initial: 'Начальная сборка контекста', append: 'История дополнена',
  compaction: 'Контекст сокращён под бюджет', 'history-change': 'История изменилась',
  'policy-change': 'Изменились инструкции, модель или инструменты',
};

export function ContextCacheTrace({ trace }: { trace?: Trace }) {
  if (!trace) return null;
  return <div data-testid="context-cache-trace" className="field-help">
    <p>{labels[trace.transition]} · этап контекста {trace.epoch}</p>
    <p>{trace.retainedMessageCount} сообщений{trace.removedMessageCount ? ` · исключено ${trace.removedMessageCount}` : ''}
      {trace.historyPrefixPreserved ? ' · состав начала истории сохранён' : ''}</p>
    <p>Это состав локального контекста. Попадание в кэш подтверждают счётчики API выше.</p>
  </div>;
}
