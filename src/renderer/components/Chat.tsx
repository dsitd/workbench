import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Archive, ArchiveRestore, ArrowUp, Globe2, ImagePlus, LoaderCircle, Pencil, Pin, ShieldCheck, Sparkles, Square } from 'lucide-react';
import type { Attachment, ChatMessage, ContextReport, ModelConfig, Project, Session, ReasoningEffort, RunLimits, RunRecord } from '../../shared/types';
import { agentMode } from '../../shared/modes';
import { api, errorText, statusLabels } from '../api';
import { AttachmentImage, ErrorNote, IconButton, Markdown } from './Common';
import { ModeHelp, ModeSelector } from './ModeSelector';
import { ReasoningSelector } from './ReasoningSelector';
import { ComposerSelect } from './ComposerSelect';
import { SessionLimitsDialog } from './SessionLimitsDialog';
import { ContextPinPicker } from './ContextPinPicker';
import { RunSummary, runPhaseLabel } from './RunSummary';
import { useRunJournal } from '../hooks/useRunJournal';
import { defaultRunLimits } from '../../shared/runs';
import { fileReference } from '../file-references';
import { isRunActive } from '../state';
import { chatCosts, type CostSummary } from '../request-costs';
import { ChatCost, RequestCost } from './RequestCost';
import { conversationActivity, responseMessages, type AssistantResponse } from '../conversation-activity';
import { ActivityDisclosure } from './ActivityDisclosure';
import { ContextBadge } from './ContextBadge';
import { chatModelOptions } from '../model-labels';

export function Chat({ project, session, models, messages, context, loading, defaultLimits, onSend, onStop, onConfigure, onRename, onNewProject, onModels, onContext, onProjectSettings, onNewSession, onRestore, onProjectChanged, onRuns }: {
  project?: Project; session?: Session; models: ModelConfig[]; messages: ChatMessage[]; context?: ContextReport; loading: boolean; defaultLimits?: RunLimits;
  onSend: (text: string, attachments: string[]) => Promise<void>; onStop: () => void;
  onConfigure: (patch: Partial<Pick<Session, 'modelId' | 'mode' | 'reasoningEffort' | 'runLimits'>>) => Promise<void>;
  onRename: (title: string) => void; onNewProject: () => void; onModels: () => void; onContext: () => void; onProjectSettings: () => void; onProjectChanged: () => void; onRuns: () => void; onNewSession: () => void; onRestore: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [importing, setImporting] = useState(false);
  const [sending, setSending] = useState(false);
  const [configurationSaves, setConfigurationSaves] = useState<Map<string, 'mode' | 'reasoning' | 'model' | 'limits'>>(new Map());
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [pinPicker, setPinPicker] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const { runs, error: journalError } = useRunJournal(project?.id, session?.id);
  const costs = useMemo(() => chatCosts(runs, messages, session?.id ?? ''), [runs, messages, session?.id]);
  const latestRun = runs.find((run) => run.kind !== 'title');
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const activeSession = useRef(session?.id); activeSession.current = session?.id;
  const activeRun = runs.find(isRunActive);
  const running = session?.status === 'running' || session?.status === 'approval' || Boolean(activeRun);
  const agentWorking = session?.status === 'running' || session?.status === 'approval' || Boolean(activeRun?.kind !== 'title' && activeRun?.status === 'running');
  const conversation = useMemo(() => conversationActivity(messages, agentWorking, activeRun?.kind !== 'title' ? activeRun?.startedAt : undefined), [messages, agentWorking, activeRun?.kind, activeRun?.startedAt]);
  const activityLabel = session?.status === 'approval' ? 'Ожидает разрешение…' : activeRun ? `${runPhaseLabel[activeRun.phase]}…` : 'Работает над задачей…';
  const pendingConfiguration = session ? configurationSaves.get(session.id) : undefined;
  const savingConfiguration = Boolean(pendingConfiguration);
  const savingMode = pendingConfiguration === 'mode';
  const model = models.find((item) => item.id === session?.modelId);
  const mode = agentMode(session?.mode);
  const reasoningEffort = session?.reasoningEffort || model?.reasoningEffort || 'auto';

  useEffect(() => { setDraft(''); setAttachments([]); setError(undefined); setSending(false); setEditingTitle(false); setLimitsOpen(false); setPinPicker(false); setRunBusy(false); nearBottom.current = true; input.current?.focus(); }, [session?.id]);
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: 'instant' }); }, [messages]);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 190)}px`; } }, [draft]);
  const importImages = async (paths?: string[]) => {
    setImporting(true); setError(undefined); const target = activeSession.current;
    try { const result = await api.importImages(paths); if (activeSession.current === target) setAttachments((current) => [...current, ...result]); } catch (cause) { setError(errorText(cause)); } finally { setImporting(false); }
  };
  const importFiles = (files: File[]) => {
    const paths = files.filter((file) => file.type.startsWith('image/')).map((file) => api.getFilePath(file)).filter(Boolean);
    if (paths.length) void importImages(paths); else if (files.length) setError('Выберите изображения PNG, JPEG, WebP, GIF или другие поддерживаемые форматы.');
  };
  const onPaste = (event: ClipboardEvent) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); const paths = files.map((file) => api.getFilePath(file)).filter(Boolean); if (paths.length) void importImages(paths); else { setImporting(true); const target = activeSession.current; void api.pasteImages().then((images) => { if (activeSession.current === target) setAttachments((current) => [...current, ...images]); }).catch((cause) => setError(errorText(cause))).finally(() => setImporting(false)); } } };
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); importFiles(Array.from(event.dataTransfer.files)); };
  const send = async () => {
    if (!session || session.archivedAt || running || sending || runBusy || savingConfiguration || (!draft.trim() && attachments.length === 0)) return;
    setSending(true); setError(undefined); const target = session.id;
    const value = draft; const imageIds = attachments.map((item) => item.id);
    setDraft(''); setAttachments([]); nearBottom.current = true;
    try { await onSend(value, imageIds); } catch (cause) { if (activeSession.current === target) { setError(errorText(cause)); setDraft(value); setAttachments((current) => [...attachments, ...current]); } } finally { if (activeSession.current === target) { setSending(false); input.current?.focus(); } }
  };
  const configure = async (kind: 'mode' | 'reasoning' | 'model' | 'limits', patch: Partial<Pick<Session, 'mode' | 'modelId' | 'reasoningEffort' | 'runLimits'>>) => {
    if (!session || session.archivedAt || running || sending || runBusy || savingConfiguration) return;
    const target = session.id; setConfigurationSaves((current) => new Map(current).set(target, kind)); setError(undefined);
    try { await onConfigure(patch); }
    catch (cause) { if (activeSession.current === target) setError(errorText(cause)); throw cause; }
    finally { setConfigurationSaves((current) => { const next = new Map(current); next.delete(target); return next; }); }
  };
  const runAction = async (kind: 'continue' | 'verify') => {
    if (!session || session.archivedAt || !latestRun || running || sending || runBusy || savingConfiguration) return;
    const target = session.id; setRunBusy(true); setError(undefined);
    try { if (kind === 'continue') await api.continueRun(target, latestRun.id); else await api.verifyRun(target, latestRun.id); }
    catch (cause) { if (activeSession.current === target) setError(errorText(cause)); }
    finally { if (activeSession.current === target) setRunBusy(false); }
  };
  const mention = draft.match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const rename = () => { if (title.trim()) onRename(title.trim()); setEditingTitle(false); };
  return <main className="chat-main"><header className="chat-header"><div className="chat-heading"><div className="breadcrumb">{project?.name || 'Личное пространство'}<span>/</span>{session ? 'Чат' : 'Начало работы'}</div><div className="chat-title-row">{editingTitle ? <input className="title-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') rename(); if (event.key === 'Escape') setEditingTitle(false); }} onBlur={rename} /> : <h1>{session?.title || 'Добро пожаловать'}</h1>}{session && <IconButton label="Переименовать чат" onClick={() => { setTitle(session.title); setEditingTitle(true); }}><Pencil size={13} /></IconButton>}</div></div>{session && <div className={`status-pill ${running && session.status !== 'approval' ? 'running' : session.status}`}>{running ? <LoaderCircle size={12} className="spin" /> : <span className="status-dot" />}{session.status === 'approval' ? statusLabels.approval : activeRun ? runPhaseLabel[activeRun.phase] : statusLabels[session.status]}</div>}</header>
    {session?.archivedAt && <div className="archived-chat-banner" data-testid="archived-chat-banner"><Archive size={15} /><span>Чат в архиве. История и расходы сохранены.</span><ChatCost cost={costs.total} unassignedRuns={costs.unassignedRuns} onDetails={onRuns} error={journalError} /><button className="secondary-button" data-testid="archived-chat-restore" onClick={onRestore}><ArchiveRestore size={13} />Восстановить</button></div>}
    <div className="conversation-scroll" ref={viewport} onScroll={() => { if (viewport.current) nearBottom.current = viewport.current.scrollHeight - viewport.current.scrollTop - viewport.current.clientHeight < 120; }}>
      {!session || messages.length === 0 ? <div className="welcome"><div className="welcome-symbol"><Sparkles size={42} strokeWidth={1.15} /></div><p className="welcome-eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</p><h2>{project ? 'Что будем создавать?' : 'Одна идея. Свой инструмент.'}</h2><p>{project ? `Исследуйте код, исправляйте ошибки и создавайте новое в «${project.name}». Агент видит только папки этого проекта.` : 'Откройте проект, выберите модель и работайте с кодом в одном месте. Файлы, чаты и правила — под вашим контролем.'}</p>{!project ? <button className="primary-button" onClick={onNewProject}><PlusMark />Добавить проект</button> : !session ? <button className="primary-button" onClick={onNewSession}><PlusMark />Начать чат</button> : <div className="suggestions">{['Разберись в структуре проекта', 'Найди ошибки и предложи исправления', 'Прочитай AGENTS.md и объясни правила'].map((suggestion) => <button key={suggestion} onClick={() => { setDraft(suggestion); input.current?.focus(); }}>{suggestion}<ArrowUp size={14} className="suggestion-arrow" /></button>)}</div>}{model?.kind === 'demo' && <div className="demo-welcome"><Sparkles size={14} />Включён демо-режим. <button onClick={onModels}>Подключить реальную модель</button></div>}</div> : <div className="message-list">{conversation.map((entry) => entry.kind === 'user' ? <Message key={entry.id} message={entry.message} cost={costs.requests.get(entry.id)} onCostDetails={onRuns} /> : <ResponseMessage key={`${session.id}-${entry.id}`} response={entry} activeLabel={activityLabel} run={entry.active ? activeRun?.kind !== 'title' ? activeRun : undefined : runs.find(run => run.kind !== 'title' && run.status !== 'running' && responseMessages(entry).some(message => message.id === run.checkpoint?.assistantMessageId))} />)}{running && !agentWorking && <div className="working-indicator"><span /><span /><span /><span className="working-label">{activityLabel}</span></div>}<div ref={bottom} /></div>}
      {loading && <div className="messages-loading"><LoaderCircle className="spin" size={20} /></div>}
    </div>
    {session && !session.archivedAt && <div className="composer-area"><ErrorNote text={error} />{latestRun && <RunSummary run={latestRun} busy={runBusy} locked={running || savingConfiguration || sending} canVerify={Boolean(project?.verificationCommand && mode !== 'plan')} onContinue={() => void runAction('continue')} onVerify={() => void runAction('verify')} onDetails={onRuns} />}{model?.kind === 'demo' && <div className="demo-banner"><Sparkles size={13} /><span>Демо-агент · ответы без внешней модели</span><button onClick={onModels}>Подключить API</button></div>}<div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}>
      {attachments.length > 0 && <div className="draft-attachments">{attachments.map((attachment) => <AttachmentImage key={attachment.id} id={attachment.id} attachment={attachment} onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />)}</div>}
      {project?.pins?.length ? <div className="composer-pins">{project.pins.map((pin) => <span key={pin.id} title={pin.path}><Pin size={11} />{pin.path.split('/').pop()}{pin.startLine ? `:${pin.startLine}${pin.endLine && pin.endLine !== pin.startLine ? `–${pin.endLine}` : ''}` : ''}</span>)}</div> : null}
      {mention !== undefined && project && <button className="text-button mention-picker" data-testid="mention-file" disabled={running || sending || runBusy || savingConfiguration} onClick={() => setPinPicker(true)}><Pin size={12} />Выбрать файл {mention && `«${mention}»`}</button>}
      <textarea data-testid="chat-input" ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder={running ? 'Можно подготовить следующее сообщение…' : 'Опишите задачу. Перетащите сюда изображения…'} aria-label="Сообщение агенту" rows={2} />
      <div className="composer-toolbar"><div className="composer-options"><IconButton label="Добавить изображения" disabled={importing} onClick={() => void importImages()}>{importing ? <LoaderCircle className="spin" size={17} /> : <ImagePlus size={17} />}</IconButton><IconButton label="Добавить файл в контекст" testId="context-pin-open" disabled={running || sending || runBusy || savingConfiguration || !project} onClick={() => setPinPicker(true)}><Pin size={16} /></IconButton><ComposerSelect key={`model-${session.id}`} className="model-choice" testId="model-choice" ariaLabel="Модель для чата" value={session.modelId} options={chatModelOptions(models, session.modelId)} disabled={running || sending || runBusy || savingConfiguration} busy={pendingConfiguration === 'model'} onChange={(value) => void configure('model', { modelId: value }).catch(() => {})} /><ModeSelector key={`mode-${session.id}`} mode={mode} disabled={running || sending || runBusy || savingConfiguration} saving={savingMode} onChange={(value) => void configure('mode', { mode: value }).catch(() => {})} /><ReasoningSelector key={`reasoning-${session.id}`} value={reasoningEffort} options={[{ value: 'auto', label: 'auto' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }]} disabled={running || sending || runBusy || savingConfiguration} saving={pendingConfiguration === 'reasoning'} onChange={(value) => void configure('reasoning', { reasoningEffort: value as ReasoningEffort }).catch(() => {})} /></div>{running ? <button className="send-button stop-button" aria-label="Остановить агента" onClick={onStop}><Square size={15} fill="currentColor" /></button> : <button data-testid="chat-send" className="send-button" aria-label="Отправить сообщение" onClick={() => void send()} disabled={sending || runBusy || savingConfiguration || importing || (!draft.trim() && attachments.length === 0)}><ArrowUp size={20} /></button>}</div>
    </div><ModeHelp mode={mode} saving={savingMode} /><div className="composer-footer"><button onClick={onProjectSettings}><Globe2 size={12} />{project?.internet ? 'Интернет включён' : 'Интернет выключен'}</button><button onClick={onProjectSettings}><ShieldCheck size={12} />{project?.commandPolicy === 'sandbox' ? 'Команды в sandbox' : 'Команды с разрешением'}</button><button data-testid="session-limits-open" disabled={running || sending || runBusy || savingConfiguration} onClick={() => setLimitsOpen(true)}>Бюджет</button><ContextBadge context={context} usage={latestRun?.usage} onDetails={onContext} /><ChatCost cost={costs.total} unassignedRuns={costs.unassignedRuns} onDetails={onRuns} error={journalError} /><span>Enter — отправить</span></div></div>}
    {limitsOpen && session && <SessionLimitsDialog value={session.runLimits || {}} inherited={{ ...defaultRunLimits, ...defaultLimits, ...project?.runLimits }} onClose={() => setLimitsOpen(false)} onSave={(runLimits: RunLimits) => configure('limits', { runLimits })} />}
    {pinPicker && project && <ContextPinPicker project={project} initialSearch={mention || ''} onClose={() => setPinPicker(false)} onSaved={(_, _file, pin) => { onProjectChanged(); const reference = fileReference(pin); if (reference) setDraft((current) => current.replace(/(^|\s)@[^\s@]*$/, (_match, space: string) => `${space}${reference} `)); }} />}
  </main>;
}
function PlusMark() { return <span style={{ fontSize: 20, lineHeight: '16px' }}>+</span>; }
function Message({ message, cost, onCostDetails }: { message: ChatMessage; cost?: CostSummary; onCostDetails: () => void }) {
  return <article className="message user"><div className="message-avatar"><span>Вы</span></div><div className="message-body"><div className="message-author">Вы<time>{new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time></div>{message.attachmentIds && <div className="message-attachments">{message.attachmentIds.map((id) => <AttachmentImage key={id} id={id} />)}</div>}<Markdown text={message.content} />{cost && <RequestCost cost={cost} onDetails={onCostDetails} />}</div></article>;
}
function ResponseMessage({ response, run, activeLabel }: { response: AssistantResponse; run?: RunRecord; activeLabel: string }) {
  const answer = response.answer, createdAt = answer?.createdAt || response.activity[0]?.createdAt;
  return <article className="message assistant" data-response-id={response.id}><div className="message-avatar"><Sparkles size={18} strokeWidth={1.5} /></div><div className="message-body"><div className="message-author">Workbench{createdAt && <time>{new Date(createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time>}</div><ActivityDisclosure messages={response.activity} active={response.active} activeLabel={activeLabel} run={run} />{answer && <div data-testid="assistant-answer">{answer.attachmentIds && <div className="message-attachments">{answer.attachmentIds.map(id => <AttachmentImage key={id} id={id} />)}</div>}<Markdown text={answer.content} /></div>}</div></article>;
}
