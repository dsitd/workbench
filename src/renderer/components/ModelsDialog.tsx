import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, KeyRound, Plus, Save, Signal, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import type { ModelConfig, ModelConnectionReport, ModelKind, ReasoningEffort } from '../../shared/types';
import { flashPreset, modelPresets } from '../../shared/model-presets';
import { modelLabel } from '../model-labels';
import { isOpenRouterCredentialProfile } from '../../shared/model-credentials';
import { ComposerSelect } from './ComposerSelect';
import '../model-credentials.css';
import { api, errorText } from '../api';
import { Busy, ErrorNote, Modal } from './Common';
import { WorkbenchSettings } from './WorkbenchSettings';

const kinds: Record<ModelKind, string> = {
  demo: 'Демо-агент',
  'openai-compatible': 'OpenAI-совместимый Chat API',
  'openai-responses': 'OpenAI Responses API',
  anthropic: 'Anthropic Messages API',
};
function newModel(): ModelConfig {
  return { id: crypto.randomUUID(), name: 'Новая модель', kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1', model: '', apiKeyEnv: 'OPENROUTER_API_KEY',
    contextWindow: 128000, maxOutputTokens: 8192, vision: true, enabled: true };
}
function configurationValue(model: ModelConfig): string {
  return JSON.stringify([model.name, model.kind, model.baseUrl, model.model, model.apiKeyEnv,
    model.contextWindow, model.maxOutputTokens, model.vision, model.enabled, model.reasoningEffort, model.inputPricePerMillion, model.outputPricePerMillion, model.cacheReadPricePerMillion, model.cacheWritePricePerMillion, model.credentialModelId]);
}

export function ModelsDialog({ models, onClose, onChanged }: {
  models: ModelConfig[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<ModelConfig>({ ...(models.find((model) => model.id === flashPreset.id) || models.find((model) => model.kind !== 'demo') || models[0] || newModel()) });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<ModelConnectionReport>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settingsTab, setSettingsTab] = useState(false);
  const selectedId = useRef(selected.id); selectedId.current = selected.id;
  const connectionResult = useRef<HTMLDivElement>(null);
  useEffect(() => { if (connection) connectionResult.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [connection]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const savedModel = models.find((model) => model.id === selected.id);
  const dirty = !savedModel || configurationValue(savedModel) !== configurationValue(selected) || key.length > 0;
  const working = busy || checking;
  const sharedKeyModels = models.filter((model) => model.id !== selected.id && !model.credentialModelId && model.hasKey && isOpenRouterCredentialProfile(model));
  const credentialSource = models.find((model) => model.id === selected.credentialModelId);
  const selectedPreset = modelPresets.find((preset) => preset.configuration.kind === selected.kind
    && preset.configuration.baseUrl === selected.baseUrl && preset.configuration.model === selected.model);

  const change = <K extends keyof ModelConfig>(name: K, value: ModelConfig[K]) => {
    if (working) return;
    setSelected((current) => ({ ...current, [name]: value, ...(name === 'baseUrl' ? { credentialModelId: undefined } : {}) })); setNotice(''); setConnection(undefined);
  };
  const select = (model: ModelConfig) => {
    if (working) return;
    setSelected({ ...model }); setKey(''); setError(undefined); setNotice('');
    setConfirmDelete(false); setConnection(undefined);
  };
  const changeProtocol = (kind: ModelKind) => {
    setSelected((current) => ({ ...current, kind, credentialModelId: undefined,
      baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com/v1' : kind === 'openai-compatible' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1',
      apiKeyEnv: kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : kind === 'openai-compatible' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY' }));
    setNotice(''); setConnection(undefined);
  };
  const save = async () => {
    if (working) return;
    setBusy(true); setError(undefined); setConnection(undefined);
    try {
      const saved = await api.saveModel(selected, key || undefined);
      if (!mounted.current) return;
      setSelected(saved); setKey(''); setNotice('Настройки модели сохранены');
      await onChanged();
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const remove = async () => {
    if (working) return;
    setBusy(true); setError(undefined); setConnection(undefined);
    try {
      await api.deleteModel(selected.id); await onChanged();
      if (!mounted.current) return;
      const next = models.find((model) => model.id !== selected.id) || newModel();
      setSelected({ ...next }); setKey(''); setNotice(''); setConfirmDelete(false);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const testConnection = async () => {
    if (working || dirty || !savedModel || selected.kind === 'demo') return;
    const id = selected.id;
    setChecking(true); setError(undefined); setConnection(undefined);
    try {
      const report = await api.testModel(id);
      if (mounted.current && selectedId.current === id && report.modelId === id) setConnection(report);
    } catch (cause) {
      if (mounted.current && selectedId.current === id) setError(errorText(cause));
    } finally { if (mounted.current && selectedId.current === id) setChecking(false); }
  };

  const tabs = <div className="dialog-tabs"><button className={!settingsTab ? 'active' : ''} onClick={() => setSettingsTab(false)} disabled={working}>Модели</button><button data-testid="workbench-settings-open" className={settingsTab ? 'active' : ''} onClick={() => setSettingsTab(true)} disabled={working}>Рабочее пространство</button></div>;
  if (settingsTab) return <Modal title="Модели и настройки" subtitle="Общие настройки рабочего пространства" onClose={onClose} wide>{tabs}<WorkbenchSettings models={models} onClose={onClose} onChanged={onChanged} /></Modal>;
  return <Modal title="Модели и настройки" subtitle="Подключайте свои API и выбирайте модель для каждого чата" onClose={onClose} wide>{tabs}
    <div className="split-dialog" aria-busy={working}>
      <aside className="dialog-list">
        <div className="dialog-list-heading">МОДЕЛИ<button data-testid="model-add" className="icon-button" aria-label="Добавить модель" disabled={working} onClick={() => select(newModel())}><Plus size={16} /></button></div>
        {models.map((model) => <button className={`model-list-item ${selected.id === model.id ? 'active' : ''}`} key={model.id} aria-pressed={selected.id === model.id} disabled={working} onClick={() => select(model)}>
          <span className={`model-initial ${model.kind === 'demo' ? 'demo' : ''}`}>{model.kind === 'demo' ? '✳' : model.name.slice(0, 1).toUpperCase()}</span>
          <span><strong>{modelLabel(model.name)}</strong><small>{model.kind === 'demo' ? 'Без API · локальная демонстрация' : model.model}</small></span>
          {model.enabled && <Check size={12} />}
        </button>)}
        <div className="model-presets">
          <div className="dialog-list-heading">ГОТОВЫЕ КОНФИГУРАЦИИ</div>
          {modelPresets.map((preset) => <button className="model-preset-button" key={preset.id}
            data-testid={`model-preset-${preset.id}`} aria-label={`Добавить ${preset.label}`} disabled={working}
            onClick={() => {
              const configuration = { ...preset.configuration, id: crypto.randomUUID() };
              const source = models.find((model) => model.hasKey && !model.credentialModelId && isOpenRouterCredentialProfile(model));
              select({ ...configuration, ...(source && isOpenRouterCredentialProfile(configuration) ? { credentialModelId: source.id, hasKey: true } : {}) });
            }}>
            <Sparkles size={15} /><span><strong>{preset.label.split(' · ')[0]}</strong><small>{preset.provider} · новая конфигурация</small></span><Plus size={13} />
          </button>)}
          <p>Выбор добавляет новую конфигурацию. Существующие модели сохраняются.</p>
        </div>
      </aside>
      <div className="dialog-detail">
        <ErrorNote text={error} />
        <fieldset className="model-config-fields" disabled={working}>
          <div className="form-grid">
            <label className="field"><span>Название в приложении</span><input data-testid="model-display-name" value={selected.name} onChange={(event) => change('name', event.target.value)} /></label>
            <label className="field"><span>Протокол API</span><select data-testid="model-api-protocol" value={selected.kind} onChange={(event) => changeProtocol(event.target.value as ModelKind)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <label className="field"><span>Рассуждение по умолчанию</span><select data-testid="model-reasoning" value={selected.reasoningEffort || 'auto'} onChange={(event) => change('reasoningEffort', event.target.value as ReasoningEffort)}><option value="auto">auto</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select><small>Чат может выбрать другой уровень. Поддержка зависит от API и модели.</small></label>
          <div className="form-grid"><label className="field"><span>Вход, USD за 1 млн токенов</span><input type="number" min={0} step="any" value={selected.inputPricePerMillion ?? ''} onChange={(event) => change('inputPricePerMillion', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="Не указано" /></label><label className="field"><span>Выход, USD за 1 млн токенов</span><input type="number" min={0} step="any" value={selected.outputPricePerMillion ?? ''} onChange={(event) => change('outputPricePerMillion', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="Не указано" /></label></div>
          <details className="model-cache-prices"><summary>Тарифы кэша для оценки расходов</summary><div className="form-grid">
            <label className="field"><span>Чтение кэша, USD за 1 млн</span><input data-testid="model-cache-read-price" type="number" min={0} step="any" value={selected.cacheReadPricePerMillion ?? ''} onChange={(event) => change('cacheReadPricePerMillion', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="Не указано" /></label>
            <label className="field"><span>Запись кэша, USD за 1 млн</span><input data-testid="model-cache-write-price" type="number" min={0} step="any" value={selected.cacheWritePricePerMillion ?? ''} onChange={(event) => change('cacheWritePricePerMillion', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="Не указано" /></label>
          </div><small>Используются только без стоимости из API. Это полные тарифы для токенов кэша; итог API уже учитывает кэш.</small></details>
          {selectedPreset && <div className="model-preset-note"><Sparkles size={13} /><span>Готовая конфигурация {selectedPreset.provider}</span><a href={selectedPreset.sourceUrl} target="_blank" rel="noreferrer">Документация API</a></div>}
          {selected.kind !== 'demo' ? <>
            <label className="field"><span>Адрес API</span><input className="config-input" data-testid="model-api-endpoint" value={selected.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} placeholder="https://openrouter.ai/api/v1" spellCheck={false} /></label>
            <label className="field"><span>Идентификатор модели</span><input className="config-input" data-testid="model-identifier" value={selected.model} onChange={(event) => change('model', event.target.value)} placeholder="Имя модели из API вашего провайдера" spellCheck={false} /></label>
            {isOpenRouterCredentialProfile(selected) && (sharedKeyModels.length > 0 || selected.credentialModelId) && <div className="field"><span>Ключ OpenRouter</span><ComposerSelect className="model-credential-choice" testId="model-credential-source" ariaLabel="Источник ключа OpenRouter" value={selected.credentialModelId || ''} disabled={working} options={[{ value: '', label: 'Свой ключ или переменная окружения' }, ...sharedKeyModels.map((model) => ({ value: model.id, label: modelLabel(model.name) }))]} onChange={(value) => { change('credentialModelId', value || undefined); setKey(''); }} /><small>Можно использовать ключ уже подключённой модели OpenRouter.</small></div>}
            <div className="key-status"><KeyRound size={14} /><span>{credentialSource ? `Используется ключ: ${credentialSource.name}` : selected.hasKey ? 'Ключ сохранён' : 'Ключ пока не сохранён'}</span></div>
            <label className="field"><span>API-ключ</span><input data-testid="model-api-key" disabled={Boolean(selected.credentialModelId)} type="password" autoComplete="new-password" value={key} onChange={(event) => { setKey(event.target.value); setNotice(''); setConnection(undefined); }} placeholder={selected.hasKey ? 'Оставьте пустым, чтобы сохранить текущий ключ' : 'Введите ключ провайдера'} /><small>Существующие ключи не отображаются. Ключ можно также передать через переменную окружения.</small></label>
            <label className="field"><span>Имя переменной окружения</span><input className="config-input" data-testid="model-api-key-env" disabled={Boolean(selected.credentialModelId)} value={selected.apiKeyEnv} onChange={(event) => change('apiKeyEnv', event.target.value)} placeholder="OPENROUTER_API_KEY" spellCheck={false} /></label>
          </> : <div className="info-box">Демо-агент позволяет проверить интерфейс, сессии и инструменты. Для работы с полноценной моделью добавьте API-провайдера.</div>}
          <div className="form-grid">
            <label className="field"><span>Контекст модели, токенов</span><input type="number" min="1024" value={selected.contextWindow} onChange={(event) => change('contextWindow', Number(event.target.value))} /></label>
            <label className="field"><span>Максимальный ответ, токенов</span><input type="number" min="256" value={selected.maxOutputTokens} onChange={(event) => change('maxOutputTokens', Number(event.target.value))} /></label>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={selected.vision} onChange={(event) => change('vision', event.target.checked)} /><span>Модель поддерживает изображения</span></label>
          <label className="checkbox-row"><input type="checkbox" checked={selected.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>Доступна в выборе моделей</span></label>
        </fieldset>
        {notice && <div className="success-note" role="status">{notice}</div>}
        {selected.kind !== 'demo' && <section className="model-connection-section" aria-label="Проверка подключения модели">
          <div className="model-connection-heading"><div><strong>Проверка подключения</strong><p>Проверяет ответ модели и вызов инструментов.</p></div>
            <button data-testid="model-test-connection" className="secondary-button" disabled={working || dirty} onClick={() => void testConnection()}>
              {checking ? <Busy text="Проверяем…" /> : <><Signal size={14} />Проверить подключение</>}
            </button>
          </div>
          <p className="model-connection-cost">Проверка делает два коротких API-запроса, тарифицируемых провайдером.</p>
          {dirty && <p className="model-connection-save-first">Сначала сохраните конфигурацию, затем проверьте подключение.</p>}
          {connection && <div ref={connectionResult} data-testid="model-connection-result" aria-label="Результат проверки подключения" role="status" aria-live="polite"
            className={`model-connection-result ${connection.ok && connection.toolCalling ? 'success' : connection.ok ? 'partial' : 'failed'}`}>
            <div className="model-connection-result-title">{connection.ok && connection.toolCalling ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}<strong>{connection.ok && connection.toolCalling ? 'Подключение работает' : connection.ok ? 'API ответил, инструменты не подтверждены' : 'Подключение не подтверждено'}</strong></div>
            <p>{connection.message}</p>
            <div className="model-connection-facts"><span>Проверка завершена: {connection.ok ? 'да' : 'нет'}</span><span>Вызов инструментов: {connection.toolCalling ? 'да' : 'нет'}</span>{connection.costUsd !== undefined && <span>Стоимость по данным API: ${connection.costUsd.toFixed(6)}</span>}</div>
            <small>{Math.round(connection.latencyMs).toLocaleString('ru')} мс · {new Date(connection.checkedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК</small>
          </div>}
        </section>}
      </div>
    </div>
    <footer className="modal-footer"><div>{savedModel && (confirmDelete ? <div className="delete-confirm"><span>Удалить модель?</span><button className="danger-button" onClick={() => void remove()} disabled={working}>Удалить</button><button className="text-button" disabled={working} onClick={() => setConfirmDelete(false)}>Отмена</button></div> : <button className="danger-text" disabled={working} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Удалить модель</button>)}</div>
      <div className="footer-actions"><button className="secondary-button" onClick={onClose}>Закрыть</button><button data-testid="model-save" className="primary-button" disabled={working || !selected.name.trim() || (selected.kind !== 'demo' && !selected.model.trim())} onClick={() => void save()}>{busy ? <Busy text="Сохраняем…" /> : <><Save size={14} />Сохранить</>}</button></div>
    </footer>
  </Modal>;
}
