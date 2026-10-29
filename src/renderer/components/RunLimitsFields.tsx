import type { RunLimits } from '../../shared/types';

export function RunLimitsFields({ value, onChange, inherited, disabled = false }: {
  value: RunLimits; onChange: (value: RunLimits) => void; inherited?: RunLimits; disabled?: boolean;
}) {
  const change = (key: keyof RunLimits, text: string, multiplier = 1) => onChange({ ...value, [key]: text === '' ? undefined : Number(text) * multiplier });
  return <fieldset className="settings-fields" disabled={disabled}>
    <div className="form-grid">
      <label className="field"><span>Шагов модели (0 — без лимита)</span><input data-testid="limit-steps" type="number" min={0} max={200} step={1}
        value={value.maxSteps ?? ''} placeholder={String(inherited?.maxSteps ?? 80)} onChange={(event) => change('maxSteps', event.target.value)} /></label>
      <label className="field"><span>Токенов за запуск</span><input data-testid="limit-tokens" type="number" min={1000} max={10000000} step={1000}
        value={value.maxTokens ?? ''} placeholder={String(inherited?.maxTokens ?? 1000000)} onChange={(event) => change('maxTokens', event.target.value)} /></label>
      <label className="field"><span>Бюджет, USD</span><input data-testid="limit-cost" type="number" min={0.001} max={1000} step="any"
        value={value.maxCostUsd ?? ''} placeholder={String(inherited?.maxCostUsd ?? 2)} onChange={(event) => change('maxCostUsd', event.target.value)} /></label>
      <label className="field"><span>Время, минут</span><input data-testid="limit-duration" type="number" min={1 / 6} max={480} step="any"
        value={value.maxDurationMs === undefined ? '' : value.maxDurationMs / 60000} placeholder={String((inherited?.maxDurationMs ?? 1800000) / 60000)} onChange={(event) => change('maxDurationMs', event.target.value, 60000)} /></label>
    </div>
    <p className="field-help">Пустые поля используют настройки выше по уровню. Токены включают вход и выход всех шагов. При достижении бюджета запуск останавливается; его можно продолжить отдельно.</p>
  </fieldset>;
}
