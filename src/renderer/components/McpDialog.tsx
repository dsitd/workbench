import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Globe2, KeyRound, Plug, Plus, Save, ShieldCheck, Terminal, Trash2, TriangleAlert, Unplug } from 'lucide-react';
import type { McpConnectionReport, McpSecretsInput, McpServerConfig, Project } from '../../shared/types';
import { api, errorText } from '../api';
import { Busy, ErrorNote, IconButton, Modal } from './Common';

interface EnvRow { id: string; name: string; value: string }
type ArgsMode = 'json' | 'lines';
function newServer(): McpServerConfig {
  return { id: crypto.randomUUID(), name: '', transport: 'stdio', enabled: false,
    projectIds: [], command: '', args: [], url: '', envNames: [], bearerTokenEnv: '',
    enabledTools: [], tools: [] };
}
function envRows(server?: McpServerConfig): EnvRow[] {
  return (server?.envNames || []).map((name) => ({ id: crypto.randomUUID(), name, value: '' }));
}
function configurationValue(server: McpServerConfig): string {
  return JSON.stringify([server.name, server.transport, server.enabled, [...server.projectIds].sort(),
    server.command, server.args, server.url, server.envNames, server.bearerTokenEnv, [...server.enabledTools].sort()]);
}
function parseArgs(text: string, mode: ArgsMode): string[] {
  if (mode === 'lines') return text.split(/\r?\n/).filter((line) => line.length > 0);
  let value: unknown;
  try { value = JSON.parse(text || '[]'); } catch { throw new Error('Аргументы должны быть JSON-массивом строк, например ["server.js", "--port", "3000"].'); }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('Укажите JSON-массив, в котором каждый аргумент — строка.');
  return value;
}
function localHttpEndpoint(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
  catch { return false; }
}

export function McpDialog({ servers, projects, projectId, sandboxAvailable, locked, onClose, onChanged }: {
  servers: McpServerConfig[]; projects: Project[]; projectId?: string; sandboxAvailable: boolean;
  locked: boolean; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState(servers);
  const [selected, setSelected] = useState<McpServerConfig | undefined>(servers[0]);
  const [argsMode, setArgsMode] = useState<ArgsMode>('json');
  const [argsText, setArgsText] = useState(JSON.stringify(servers[0]?.args || [], null, 2));
  const [environment, setEnvironment] = useState<EnvRow[]>(envRows(servers[0]));
  const [token, setToken] = useState('');
  const [testProjectId, setTestProjectId] = useState(servers[0]?.projectIds.includes(projectId || '') ? projectId || '' : servers[0]?.projectIds[0] || '');
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | 'disconnect'>();
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<McpConnectionReport>();
  const [connected, setConnected] = useState<boolean>();
  const [authorizing, setAuthorizing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const statusGeneration = useRef(0);
  const result = useRef<HTMLDivElement>(null);
  const working = Boolean(busy);
  const controlsLocked = locked || working;
  const saved = items.find((item) => item.id === selected?.id);
  let prepared: McpServerConfig | undefined;
  let argsError: string | undefined;
  if (selected) {
    try {
      prepared = { ...selected, name: selected.name.trim(), command: selected.command.trim(), url: selected.url.trim(),
        args: selected.transport === 'stdio' ? parseArgs(argsText, argsMode) : selected.args,
        envNames: environment.map((row) => row.name.trim()).filter(Boolean), bearerTokenEnv: selected.bearerTokenEnv.trim() };
    } catch (cause) { argsError = errorText(cause); }
  }
  const hasNewSecrets = token.length > 0 || environment.some((row) => row.value.length > 0);
  const dirty = !prepared || !saved || configurationValue(prepared) !== configurationValue(saved) || hasNewSecrets;
  const scopedProjects = projects.filter((project) => selected?.projectIds.includes(project.id));
  const testProject = scopedProjects.find((project) => project.id === testProjectId);
  const unavailableReason = !selected?.enabled ? 'Включите сервер и сохраните настройки.'
    : !testProject ? 'Разрешите доступ хотя бы к одному проекту и выберите его для подключения.'
    : selected.transport === 'http' && !localHttpEndpoint(selected.url) && !testProject.internet ? 'Для удалённого HTTP-подключения включите интернет в настройках выбранного проекта.'
    : selected.transport === 'stdio' && !sandboxAvailable ? 'Sandbox macOS недоступен: локальный MCP-сервер нельзя запустить в этой среде.'
    : undefined;

  useEffect(() => { setItems(servers); }, [servers]);
  useEffect(() => {
    mounted.current = true;
    api.listMcpServers().then((values) => { if (mounted.current) setItems(values); })
      .catch((cause) => { if (mounted.current) setError(errorText(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; statusGeneration.current++; };
  }, []);
  useEffect(() => {
    const generation = ++statusGeneration.current;
    setConnected(undefined);
    if (!saved || !testProjectId || !saved.projectIds.includes(testProjectId)) return;
    api.getMcpStatus(saved.id, testProjectId).then((status) => {
      if (mounted.current && generation === statusGeneration.current) setConnected(status.connected);
    }).catch((cause) => { if (mounted.current && generation === statusGeneration.current) setError(errorText(cause)); });
  }, [saved?.id, testProjectId]);
  useEffect(() => { if (connection || error || notice) result.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [connection, error, notice]);
  useEffect(() => {
    setAuthorizing(false);
    if (busy !== 'test' || !saved || !testProjectId) return;
    let active = true, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const status = await api.getMcpStatus(saved.id, testProjectId); if (active) setAuthorizing(Boolean(status.authorizing)); }
      catch { /* The connection request owns the visible error. */ }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 500);
    return () => { active = false; clearInterval(timer); };
  }, [busy, saved?.id, testProjectId]);

  const resetFeedback = () => { setError(undefined); setNotice(''); setConnection(undefined); setConfirmDelete(false); };
  const select = (server: McpServerConfig) => {
    if (working) return;
    setSelected({ ...server }); setArgsMode('json'); setArgsText(JSON.stringify(server.args, null, 2));
    setEnvironment(envRows(server)); setToken(''); setConnected(undefined);
    setTestProjectId(server.projectIds.includes(projectId || '') ? projectId || '' : server.projectIds[0] || '');
    resetFeedback();
  };
  const change = <K extends keyof McpServerConfig>(key: K, value: McpServerConfig[K], connectionChanged = false) => {
    if (controlsLocked) return;
    setSelected((current) => current ? { ...current, [key]: value,
      ...(connectionChanged ? { tools: [], enabledTools: [], checkedAt: undefined } : {}) } : current);
    resetFeedback();
  };
  const clearCatalog = () => { setSelected((current) => current ? { ...current, tools: [], enabledTools: [], checkedAt: undefined } : current); resetFeedback(); };
  const toggleProject = (id: string, enabled: boolean) => {
    if (!selected || controlsLocked) return;
    const ids = enabled ? [...selected.projectIds, id] : selected.projectIds.filter((value) => value !== id);
    change('projectIds', ids);
    if (!ids.includes(testProjectId)) setTestProjectId(ids[0] || '');
  };
  const changeEnv = (id: string, patch: Partial<Pick<EnvRow, 'name' | 'value'>>) => {
    if (controlsLocked) return;
    setEnvironment((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row)); clearCatalog();
  };
  const changeTransport = (transport: McpServerConfig['transport']) => {
    if (!selected || controlsLocked) return;
    change('transport', transport, true); setToken(''); setEnvironment(envRows(selected));
  };
  const setArgumentsMode = (mode: ArgsMode) => {
    if (controlsLocked) return;
    try {
      const args = parseArgs(argsText, argsMode);
      if (mode === 'lines' && args.some((arg) => arg.length === 0 || /[\r\n]/.test(arg))) throw new Error('Для пустых аргументов и аргументов с переносами строк используйте JSON-массив.');
      setArgsText(mode === 'json' ? JSON.stringify(args, null, 2) : args.join('\n')); setArgsMode(mode); resetFeedback();
    }
    catch (cause) { setError(errorText(cause)); }
  };
  const save = async () => {
    if (controlsLocked || !prepared) return;
    if (!prepared.name) { setError('Укажите название MCP-сервера.'); return; }
    if (prepared.transport === 'stdio' && !prepared.command) { setError('Укажите исполняемую команду локального MCP-сервера.'); return; }
    if (prepared.transport === 'http') {
      let endpoint: URL;
      try { endpoint = new URL(prepared.url); } catch { setError('Укажите полный HTTP или HTTPS URL MCP-endpoint.'); return; }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) { setError('Укажите URL без логина, пароля, query-параметров и фрагментов. Для авторизации используйте поле Bearer-токена.'); return; }
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && localHttpEndpoint(prepared.url))) { setError('Для удалённого сервера нужен HTTPS. HTTP доступен только для localhost, 127.0.0.1 или [::1].'); return; }
    }
    const names = environment.map((row) => row.name.trim());
    if (environment.some((row) => row.value && !row.name.trim()) || names.some((name) => name && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name))
      || new Set(names.filter(Boolean)).size !== names.filter(Boolean).length) { setError('Укажите уникальные имена вроде SERVICE_API_KEY: заглавные латинские буквы, цифры и знак _, до 64 символов. Имя не должно начинаться с цифры.'); return; }
    if (prepared.bearerTokenEnv && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(prepared.bearerTokenEnv)) { setError('Укажите имя переменной вроде MCP_BEARER_TOKEN: заглавные латинские буквы, цифры и знак _, до 64 символов.'); return; }
    const secrets: McpSecretsInput = {};
    if (prepared.transport === 'http' && token.length > 0) secrets.bearerToken = token;
    const env = prepared.transport === 'stdio' ? Object.fromEntries(environment.filter((row) => row.name.trim() && row.value.length > 0).map((row) => [row.name.trim(), row.value])) : {};
    if (Object.keys(env).length > 0) secrets.env = env;
    setBusy('save'); resetFeedback();
    try {
      const value = await api.saveMcpServer(prepared, Object.keys(secrets).length > 0 ? secrets : undefined);
      if (!mounted.current) return;
      setItems((current) => current.some((item) => item.id === value.id) ? current.map((item) => item.id === value.id ? value : item) : [...current, value]);
      setSelected(value); setArgsText(argsMode === 'json' ? JSON.stringify(value.args, null, 2) : value.args.join('\n'));
      setToken(''); setEnvironment(envRows(value)); setConnected(false); setNotice('Настройки сохранены. Подключение запускается отдельной кнопкой.');
      await onChanged();
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const test = async () => {
    if (controlsLocked || dirty || !saved || !testProject || unavailableReason) return;
    setBusy('test'); resetFeedback();
    try {
      const report = await api.testMcpServer(saved.id, testProject.id);
      if (!mounted.current) return;
      setConnection(report); setConnected(report.ok);
      if (report.ok) {
        const values = await api.listMcpServers();
        if (!mounted.current) return;
        setItems(values);
        const value = values.find((item) => item.id === saved.id);
        if (value) setSelected(value);
        await onChanged();
      }
    } catch (cause) { if (mounted.current) { setConnected(false); setError(errorText(cause)); } }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const disconnect = async () => {
    if (controlsLocked || !saved) return;
    setBusy('disconnect'); resetFeedback();
    try { await api.disconnectMcpServer(saved.id); if (mounted.current) { setConnected(false); setNotice('Все подключения этого сервера закрыты.'); } }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const cancelConnection = async () => {
    if (!saved || busy !== 'test') return;
    try { await api.disconnectMcpServer(saved.id); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
  };
  const remove = async () => {
    if (controlsLocked || !saved) return;
    setBusy('delete'); resetFeedback();
    try {
      await api.deleteMcpServer(saved.id);
      if (!mounted.current) return;
      const remaining = items.filter((item) => item.id !== saved.id); setItems(remaining);
      setSelected(undefined); setToken(''); setEnvironment([]); setConnected(undefined); setNotice('MCP-сервер удалён.');
      await onChanged();
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(undefined); }
  };

  return <Modal title="MCP-серверы" subtitle="Подключения и инструменты для выбранных проектов" onClose={() => { if (!working) onClose(); }} wide>
    {locked && <div className="mcp-lock-note" role="status"><ShieldCheck size={15} />Настройки MCP можно менять после завершения или остановки всех активных задач.</div>}
    <div className="split-dialog mcp-split" aria-busy={working || loading}>
      <aside className="dialog-list">
        <div className="dialog-list-heading"><span>ВАШИ СЕРВЕРЫ</span><IconButton label="Добавить MCP-сервер" testId="mcp-new" disabled={controlsLocked} onClick={() => select(newServer())}><Plus size={16} /></IconButton></div>
        {loading && items.length === 0 ? <div className="mcp-list-loading"><Busy /></div> : items.length === 0 && <div className="skill-empty"><Plug size={26} /><strong>Подключений пока нет</strong><p>Добавьте локальный сервер или HTTP-endpoint.</p></div>}
        {items.map((server) => <button data-testid={`mcp-server-${server.id}`} className={`model-list-item ${selected?.id === server.id ? 'active' : ''}`} key={server.id} aria-pressed={selected?.id === server.id} disabled={working} onClick={() => select(server)}><span className="model-initial">{server.transport === 'stdio' ? <Terminal size={16} /> : <Globe2 size={16} />}</span><span><strong>{server.name}</strong><small>{server.transport === 'stdio' ? 'Локальный · stdio' : 'HTTP'} · {server.enabled ? 'Включён' : 'Выключен'}</small></span></button>)}
      </aside>
      <div className="dialog-detail mcp-detail">
        {selected ? <>
          <div className="mcp-detail-heading"><div><h3>{saved ? 'Настройки подключения' : 'Новый MCP-сервер'}</h3><p>Сначала сохраните конфигурацию, затем подключитесь и выберите инструменты.</p></div><Plug size={22} strokeWidth={1.5} /></div>
          <fieldset className="mcp-config-fields" disabled={controlsLocked}>
            <label className="field"><span>Название</span><input data-testid="mcp-name" value={selected.name} onChange={(event) => change('name', event.target.value)} placeholder="Например, документация проекта" /></label>
            <label className="field"><span>Способ подключения</span><select data-testid="mcp-transport" value={selected.transport} onChange={(event) => changeTransport(event.target.value as McpServerConfig['transport'])}><option value="stdio">Локальный сервер · stdio</option><option value="http">HTTP-сервер · Streamable HTTP</option></select></label>
            {selected.transport === 'stdio' ? <>
              <label className="field"><span>Исполняемая команда</span><input className="config-input" data-testid="mcp-command" value={selected.command} onChange={(event) => change('command', event.target.value, true)} placeholder="/usr/local/bin/node" spellCheck={false} /><small>Одна исполняемая команда. Локальный сервер запускается в sandbox macOS с доступом выбранного проекта. Сохранённые секреты не переносятся на другую команду или аргументы.</small></label>
              <div className="field"><div className="field-title"><span>Аргументы команды</span><select className="mcp-args-format" aria-label="Формат аргументов" value={argsMode} onChange={(event) => setArgumentsMode(event.target.value as ArgsMode)}><option value="json">JSON-массив</option><option value="lines">Один аргумент на строку</option></select></div><textarea className="config-textarea" wrap="off" data-testid="mcp-args" value={argsText} onChange={(event) => { setArgsText(event.target.value); clearCatalog(); }} rows={4} spellCheck={false} aria-label="Аргументы MCP-команды" /><small>{argsMode === 'json' ? 'Каждый элемент массива — один аргумент. Например: ["server.js", "--port", "3000"].' : 'Каждая непустая строка — один аргумент; пробелы и кавычки сохраняются буквально.'} Shell-синтаксис, перенаправления и подстановка переменных не выполняются.</small>{argsError && <ErrorNote text={argsError} />}</div>
              <div className="field"><div className="field-title"><span>Переменные окружения</span><button className="text-button" data-testid="mcp-env-add" onClick={() => { setEnvironment((current) => [...current, { id: crypto.randomUUID(), name: '', value: '' }]); resetFeedback(); }}><Plus size={13} />Добавить</button></div>
                {environment.length === 0 && <small>Добавляйте только переменные, которые нужны серверу. Значения вводятся отдельно и сохраняются в защищённом хранилище.</small>}
                {environment.map((row, index) => <div className="mcp-env-row" key={row.id}><label><span>Имя переменной</span><input className="config-input" data-testid={`mcp-env-name-${index}`} value={row.name} onChange={(event) => changeEnv(row.id, { name: event.target.value })} placeholder="SERVICE_API_KEY" autoComplete="off" spellCheck={false} /></label><label><span>{selected.secretNames?.includes(row.name) ? 'Новое значение · уже сохранено' : 'Значение'}</span><input data-testid={`mcp-env-value-${index}`} type="password" value={row.value} onChange={(event) => changeEnv(row.id, { value: event.target.value })} placeholder={selected.secretNames?.includes(row.name) ? 'Оставьте пустым, чтобы сохранить' : 'Введите значение'} autoComplete="new-password" /></label><IconButton label={`Убрать переменную ${row.name || index + 1}`} onClick={() => { setEnvironment((current) => current.filter((value) => value.id !== row.id)); clearCatalog(); }}><Trash2 size={14} /></IconButton></div>)}
              </div>
            </> : <>
              <label className="field"><span>URL MCP-endpoint</span><input className="config-input" data-testid="mcp-url" value={selected.url} onChange={(event) => change('url', event.target.value, true)} placeholder="https://example.com/mcp" type="url" spellCheck={false} /><small>Endpoint Streamable HTTP: удалённый HTTPS требует интернета; localhost, 127.0.0.1 и [::1] доступны без него. При смене URL сохранённый токен не переносится.</small></label>
              <label className="field"><span>Bearer-токен · при необходимости</span><input data-testid="mcp-token" type="password" value={token} onChange={(event) => { setToken(event.target.value); clearCatalog(); }} placeholder={selected.hasToken ? 'Токен сохранён; пустое поле сохраняет его' : 'Для OAuth оставьте пустым'} autoComplete="new-password" /><small>Если сервер требует OAuth, при подключении откроется системный браузер для входа. Токен вручную нужен только для серверов с Bearer-авторизацией; сохранённое значение не отображается.</small></label>
              {selected.hasToken && <div className="key-status"><KeyRound size={12} />Bearer-токен сохранён в защищённом хранилище</div>}
              {selected.hasOAuth && <div className="key-status"><KeyRound size={12} />Данные OAuth сохранены в защищённом хранилище</div>}
              <label className="field"><span>Имя переменной токена · необязательно</span><input className="config-input" data-testid="mcp-token-env" value={selected.bearerTokenEnv} onChange={(event) => change('bearerTokenEnv', event.target.value, true)} placeholder="MCP_BEARER_TOKEN" autoComplete="off" spellCheck={false} /><small>Можно использовать переменную из локального окружения вместо ручного ввода токена. Значение не показывается.</small></label>
            </>}
            <label className="checkbox-row mcp-enabled"><input data-testid="mcp-enabled" type="checkbox" checked={selected.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>Включить сервер для выбранных проектов</span></label>
            <section className="mcp-section"><div className="mcp-section-heading"><ShieldCheck size={15} /><strong>Доступ к проектам</strong></div><p className="field-help">Выберите проекты, которым доступны подключение и разрешённые инструменты.</p><div className="mcp-project-list">{projects.length === 0 ? <p className="field-help">Сначала добавьте проект в Workbench.</p> : projects.map((project) => <label className="checkbox-row" key={project.id}><input data-testid={`mcp-project-${project.id}`} type="checkbox" checked={selected.projectIds.includes(project.id)} onChange={(event) => toggleProject(project.id, event.target.checked)} /><span>{project.name}<small>{project.internet ? 'Интернет включён' : 'Интернет выключен'}</small></span></label>)}</div></section>
          </fieldset>
          <section className="mcp-section mcp-connection-section"><div className="mcp-section-heading"><Plug size={15} /><strong>Подключение и проверка</strong>{saved && testProject && !dirty && <span className={`mcp-connection-state ${connected ? 'connected' : ''}`} data-testid="mcp-status">{connected === undefined ? 'Проверяем статус…' : connected ? 'Подключён' : 'Не подключён'}</span>}</div>
            <label className="field"><span>Проект для подключения</span><select data-testid="mcp-test-project" value={testProjectId} disabled={controlsLocked} onChange={(event) => { setTestProjectId(event.target.value); resetFeedback(); }}><option value="">Выберите проект</option>{scopedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <button className="secondary-button" data-testid="mcp-test" disabled={controlsLocked || dirty || Boolean(unavailableReason)} onClick={() => void test()}>{busy === 'test' ? <Busy text={authorizing ? 'Ожидаем вход в браузере…' : 'Подключаемся…'} /> : <><Plug size={14} />Подключить и получить инструменты</>}</button>
            {busy === 'test' && <button className="text-button" data-testid="mcp-cancel-connect" onClick={() => void cancelConnection()}>Отменить подключение</button>}
            {authorizing && <p className="field-help" role="status">Завершите вход в открывшемся браузере и вернитесь сюда. Ожидание ограничено пятью минутами.</p>}
            <p className="field-help mcp-connect-help">{selected.transport === 'stdio' ? 'Эта кнопка запускает локальный сервер в sandbox выбранного проекта.' : 'Эта кнопка подключается к HTTP-endpoint и при необходимости открывает OAuth-вход в браузере.'} Инструменты после проверки нужно включить вручную.</p>
            {dirty && <p className="mcp-save-first">Сначала сохраните изменения.</p>}{unavailableReason && <p className="mcp-save-first">{unavailableReason}</p>}
          </section>
          <div ref={result} className="mcp-feedback" aria-live="polite"><ErrorNote text={error} />{notice && <div className="success-note" role="status">{notice}</div>}{connection && <div data-testid="mcp-test-result" className={`model-connection-result ${connection.ok ? '' : 'failed'}`}><div className="model-connection-result-title">{connection.ok ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}<strong>{connection.ok ? 'Подключение проверено' : 'Не удалось подключиться'}</strong></div><p>{connection.message}</p><div className="model-connection-facts"><span>Инструментов: {connection.tools.length}</span><span>{connection.latencyMs} мс</span></div></div>}</div>
          <section className="mcp-section"><div className="mcp-section-heading"><ShieldCheck size={15} /><strong>Доступные инструменты</strong><span>{selected.enabledTools.length} включено</span></div><p className="field-help">Агент видит только отмеченные инструменты. Подтверждение зависит от режима чата; пометка сервера «только чтение» носит информационный характер.</p>
            {selected.tools.length === 0 ? <div className="mcp-tools-empty">Подключитесь, чтобы получить список инструментов.</div> : <fieldset className="mcp-config-fields" disabled={controlsLocked}>{selected.tools.map((tool) => <label className="mcp-tool-row" key={tool.name}><input data-testid={`mcp-tool-${tool.name}`} type="checkbox" checked={selected.enabledTools.includes(tool.name)} onChange={(event) => change('enabledTools', event.target.checked ? [...selected.enabledTools, tool.name] : selected.enabledTools.filter((name) => name !== tool.name))} /><span><strong>{tool.name}</strong>{tool.description && <p>{tool.description}</p>}{tool.readOnlyHint !== undefined && <small>Сервер: {tool.readOnlyHint ? 'только чтение' : 'может изменять данные'}</small>}</span></label>)}</fieldset>}
          </section>
        </> : <><div className="empty-detail"><Plug size={32} strokeWidth={1.25} /><h3>Инструменты для проектов</h3><p>Добавьте MCP-сервер, укажите доступ и выберите инструменты для агента.</p><button className="secondary-button" disabled={controlsLocked} onClick={() => select(newServer())}><Plus size={14} />Добавить сервер</button></div><div ref={result}><ErrorNote text={error} />{notice && <div className="success-note" role="status">{notice}</div>}</div></>}
      </div>
    </div>
    <footer className="modal-footer mcp-footer"><div className="footer-actions">{saved && <>{confirmDelete ? <div className="delete-confirm"><span>Удалить «{saved.name}» и его настройки?</span><button className="danger-button" data-testid="mcp-delete-confirm" disabled={controlsLocked} onClick={() => void remove()}>Удалить</button><button className="text-button" disabled={working} onClick={() => setConfirmDelete(false)}>Отмена</button></div> : <><button className="danger-text" data-testid="mcp-delete" disabled={controlsLocked} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Удалить</button><button className="text-button" data-testid="mcp-disconnect" disabled={controlsLocked} onClick={() => void disconnect()}><Unplug size={14} />Отключить</button></>}</>}</div><div className="footer-actions"><button className="secondary-button" disabled={working} onClick={onClose}>Готово</button>{selected && <button className="primary-button" data-testid="mcp-save" disabled={controlsLocked || !dirty || !prepared || !selected.name.trim()} onClick={() => void save()}>{busy === 'save' ? <Busy text="Сохраняем…" /> : <><Save size={14} />Сохранить</>}</button>}</div></footer>
  </Modal>;
}
