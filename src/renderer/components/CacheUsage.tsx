import type { RunUsage } from '../../shared/types';

type CacheCounts = Pick<RunUsage, 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheDetailsPartial'>;
const count = (value: number | undefined) => value === undefined ? 'Нет данных' : value.toLocaleString('ru');

export function CacheUsage({ usage }: { usage: RunUsage }) {
  if (usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) return null;
  return <>
    <div data-testid="run-cache-read"><span>Вход из кэша</span><strong>{count(usage.cacheReadTokens)}</strong></div>
    <div data-testid="run-cache-write"><span>Запись входа в кэш</span><strong>{count(usage.cacheWriteTokens)}</strong></div>
    <p className="field-help" data-testid="run-cache-note">Кэш входит во входные токены.{usage.cacheDetailsPartial ? ' Данные есть только для части вызовов.' : ''}{usage.costSource === 'api' ? ' Стоимость API уже учитывает кэш.' : ''}</p>
  </>;
}

export function StepCacheUsage({ usage }: { usage: CacheCounts }) {
  if (usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) return null;
  return <p className="field-help">Из входа: {usage.cacheReadTokens !== undefined ? `${count(usage.cacheReadTokens)} из кэша` : 'чтение кэша неизвестно'} · {usage.cacheWriteTokens !== undefined ? `${count(usage.cacheWriteTokens)} записано в кэш` : 'запись кэша неизвестна'}{usage.cacheDetailsPartial ? ' · часть данных' : ''}</p>;
}
