import { useEffect, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import type { AppSettings, ModelConfig } from '../../shared/types';
import { defaultAppSettings } from '../../shared/runs';
import { api, errorText } from '../api';
import { Busy, ErrorNote } from './Common';
import { RunLimitsFields } from './RunLimitsFields';
import { ComposerSelect } from './ComposerSelect';
import { isOpenRouterCredentialProfile } from '../../shared/model-credentials';
import { promptCacheCapability } from '../../agent/cache-policy';
import { modelLabel } from '../model-labels';

export function WorkbenchSettings({ models, onClose, onChanged }: {
  models: ModelConfig[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  useEffect(() => { let active = true; api.getSettings().then((value) => { if (active) { setSettings(value); setLoaded(true); } })
    .catch((cause) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const save = async () => { if (!loaded || busy) return; setBusy(true); setError(undefined); setNotice(''); try { setSettings(await api.saveSettings(settings)); await onChanged(); setNotice('Настройки рабочего пространства сохранены'); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const profiles = models.filter(isOpenRouterCredentialProfile);
  const cache = settings.promptCache ?? { enabled: true, ttl: '5m' as const };
  const cacheModels = models.filter(model => model.enabled && model.kind !== 'demo');
  return <><div className="modal-content workbench-settings" aria-busy={loading || busy}><ErrorNote text={error} />
    {loading ? <Busy /> : <fieldset className="settings-fields" disabled={busy || !loaded}>
      <section className="settings-section"><div className="settings-section-heading"><Sparkles size={16} /><h3>Названия чатов</h3></div>
        <label className="checkbox-row"><input data-testid="auto-title-enabled" type="checkbox" checked={settings.autoTitle.enabled} onChange={(event) => setSettings({ ...settings, autoTitle: { ...settings.autoTitle, enabled: event.target.checked } })} /><span>Создавать короткое название после первого запуска</span></label>
        <p className="field-help">Лёгкая модель получает краткое описание задачи. Вручную заданное название сохраняется.</p>
        <div className="field"><span>Профиль OpenRouter для авторизации</span><ComposerSelect testId="auto-title-profile" ariaLabel="Профиль OpenRouter для названий" value={settings.autoTitle.credentialModelId || ''} options={[{ value: '', label: 'Подходящий профиль автоматически' }, ...profiles.map(model => ({ value: model.id, label: modelLabel(model.name) }))]} onChange={value => setSettings({ ...settings, autoTitle: { ...settings.autoTitle, credentialModelId: value || undefined } })} /></div>
        <label className="field"><span>Лёгкая модель для названий</span><input className="config-input" data-testid="auto-title-model" value={settings.autoTitle.model} onChange={(event) => setSettings({ ...settings, autoTitle: { ...settings.autoTitle, model: event.target.value } })} spellCheck={false} placeholder="google/gemini-2.5-flash-lite" /></label>
      </section>
      <section className="settings-section"><div className="settings-section-heading"><h3>Бюджеты по умолчанию</h3></div><p className="field-help">Проект и отдельный чат могут уточнить эти значения.</p>
        <RunLimitsFields value={settings.runLimits} inherited={defaultAppSettings.runLimits} onChange={(runLimits) => setSettings({ ...settings, runLimits })} />
      </section>
      <section className="settings-section"><div className="settings-section-heading"><h3>Проверка исправлений</h3></div>
        <label className="checkbox-row"><input data-testid="behavior-verification-enabled" type="checkbox" checked={settings.behaviorVerification === true} onChange={event => setSettings({ ...settings, behaviorVerification: event.target.checked })} /><span>Фиксировать воспроизведение и повторную проверку ошибки</span></label>
        <p className="field-help">Экспериментальный режим. Сохраняет результаты проверок до и после исправления. Может увеличить расходы; преимущество в решении задач пока не подтверждено. Начатые проверки сохраняются при продолжении задачи.</p>
      </section>
      <section className="settings-section"><div className="settings-section-heading"><h3>Исполнение и завершение</h3></div>
        {settings.runtimeEngine === 'legacy' && <><label className="checkbox-row"><input data-testid="search-verification-enabled" type="checkbox" checked={settings.searchVerification === true} onChange={event => setSettings({ ...settings, searchVerification: event.target.checked })} /><span>Искать контрпримеры и контролировать прогресс</span></label>
        <p className="field-help">Эксперимент для задач с кодом. Отдельная проверка ищет пропущенные случаи; затянувшийся поиск приостанавливается с сохранением работы. Дополнительные запросы используют выбранную модель и общий бюджет. Преимущество в качестве ещё проверяется.</p></>}
        <label className="checkbox-row"><input data-testid="parallel-tools-enabled" type="checkbox" checked={settings.toolExecution !== 'sequential'} onChange={event => setSettings({ ...settings, toolExecution: event.target.checked ? 'parallel' : 'sequential' })} /><span>Читать независимые файлы параллельно</span></label>
        <p className="field-help">Независимые чтения выполняются одновременно. Пакеты с правками, командами, MCP или подтверждениями выполняются последовательно.</p>
        {settings.runtimeEngine === 'legacy' && <><label className="checkbox-row"><input data-testid="verified-completion-enabled" type="checkbox" checked={settings.completionPolicy !== 'natural'} onChange={event => setSettings({ ...settings, completionPolicy: event.target.checked ? 'verified' : 'natural' })} /><span>Запускать проверку проекта перед завершением</span></label>
        <p className="field-help">Если выключено, задача завершается по ответу модели без автоматического запуска команды проекта. Зарегистрированные критерии и неопределённые операции проверяются в обоих режимах.</p></>}
      </section>
      <section className="settings-section"><div className="settings-section-heading"><h3>Контекст и кэш</h3></div>
        <label className="checkbox-row"><input data-testid="full-context-enabled" type="checkbox" checked={settings.contextPolicy !== 'custom'} onChange={event => setSettings({ ...settings, contextPolicy: event.target.checked ? 'model-window' : 'custom', adaptiveContext: false })} /><span>Сохранять историю до заполнения окна модели</span></label>
        <p className="field-help">Оставляем место для ответа. Помещающаяся история сохраняется; сокращение включается при нехватке места. Исходные сообщения остаются в чате.</p>
        {settings.contextPolicy === 'custom' && <label className="field"><span>Пользовательский предел контекста, токенов</span><input data-testid="context-budget" type="number" min={4000} max={1000000} step={1000} value={settings.contextBudgetTokens ?? 32000} onChange={event => setSettings({ ...settings, contextBudgetTokens: Number(event.target.value) })} /></label>}
        <label className="checkbox-row"><input data-testid="model-compaction-enabled" type="checkbox" checked={settings.modelCompaction !== false} onChange={event => setSettings({ ...settings, modelCompaction: event.target.checked })} /><span>Суммировать вытесняемую историю моделью</span></label>
        <p className="field-help">Только при заполнении контекста. Дополнительные запросы входят в общий бюджет и журнал задачи. Исходная история сохраняется полностью. Если сжатие не удалось и история уже не помещается, запрос приостанавливается.</p>
        <label className="checkbox-row"><input data-testid="prompt-cache-enabled" type="checkbox" checked={cache.enabled} onChange={event => setSettings({ ...settings, promptCache: { ...cache, enabled: event.target.checked } })} /><span>Запрашивать кэширование</span></label>
        <p className="field-help">Фактическое использование сообщает API; часть провайдеров кэширует автоматически. Отключение запроса не выключает автоматический кэш провайдера.</p>
        <div className="field"><span>Срок кэша Claude</span><ComposerSelect testId="prompt-cache-ttl" ariaLabel="Срок кэша Claude" value={cache.ttl} disabled={!cache.enabled} options={[{ value: '5m', label: '5 минут', description: 'Обычный срок для повторных запросов' }, { value: '1h', label: '1 час', description: 'Запись в кэш может стоить дороже' }]} onChange={ttl => setSettings({ ...settings, promptCache: { ...cache, ttl: ttl as '5m' | '1h' } })} /><small>Для современных GPT используется отдельный срок 30 минут. Claude через Responses поддерживает только 5 минут. У других провайдеров срок определяется их API.</small></div>
        {cacheModels.map(model => { const capability = promptCacheCapability(model); return <p key={model.id} className="field-help">{model.name}: {capability.ttl === 'claude' ? 'управляемый кэш, 5 минут / 1 час' : capability.ttl === '5m' ? 'управляемый кэш, только 5 минут (Responses)' : capability.ttl === '30m' ? 'управляемый кэш, 30 минут' : capability.strategy === 'implicit' ? 'автоматический кэш провайдера' : 'управление кэшем не заявлено API'}.</p>; })}
      </section>
    </fieldset>}{notice && <div className="success-note" role="status">{notice}</div>}</div>
    <footer className="modal-footer"><span /><div className="footer-actions"><button className="secondary-button" onClick={onClose}>Закрыть</button><button data-testid="settings-save" className="primary-button" disabled={loading || busy || !loaded || !settings.autoTitle.model.trim()} onClick={() => void save()}>{busy ? <Busy text="Сохраняем…" /> : <><Save size={14} />Сохранить</>}</button></div></footer></>;
}
