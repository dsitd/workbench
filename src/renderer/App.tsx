import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelRightClose, PanelRightOpen, ShieldCheck, Square, X } from 'lucide-react';
import type { AgentEvent, ApprovalRequest, Bootstrap, ChatMessage, ContextReport, Project, SessionPatch } from '../shared/types';
import { fallbackChatModel, latestProjectChat } from './chat-navigation';
import { api, errorText } from './api';
import { applySessionUpdates, applyStatusUpdates, mergeLoadedMessages, type LiveStatus, type LocalSessionUpdate, type SessionMetadata } from './state';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { WorkspacePanel, type PanelTab } from './components/WorkspacePanel';
import { ProjectDialog } from './components/ProjectDialog';
import { ModelsDialog } from './components/ModelsDialog';
import { SkillsDialog } from './components/SkillsDialog';
import { McpDialog } from './components/McpDialog';
import { Busy, ErrorNote, IconButton, Modal } from './components/Common';

const empty: Bootstrap = { projects: [], sessions: [], models: [], skills: [], mcpServers: [], version: '0.1.0', platform: 'darwin', sandboxAvailable: false };
export function App() {
  const [data, setData] = useState<Bootstrap>(empty);
  const [projectId, setProjectId] = useState<string>();
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<ContextReport>();
  const [initializing, setInitializing] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState<'project' | 'skills' | 'models' | 'mcp'>();
  const [editProject, setEditProject] = useState<Project>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>('files');
  const [revision, setRevision] = useState(0);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const selectedRef = useRef({ projectId, sessionId });
  selectedRef.current = { projectId, sessionId };
  const dataRef = useRef(data); dataRef.current = data;
  const messageGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const approvalRevision = useRef(0);
  const statusRevision = useRef(0);
  const liveStatuses = useRef(new Map<string, LiveStatus>());
  const sessionRevision = useRef(0);
  const sessionUpdates = useRef(new Map<string, LocalSessionUpdate>());
  const pendingSelection = useRef<Promise<unknown>>(Promise.resolve());
  const project = data.projects.find((item) => item.id === projectId);
  const session = data.sessions.find((item) => item.id === sessionId);
  const reportError = useCallback((cause: unknown) => setError(errorText(cause)), []);
  const refresh = useCallback(async () => { const revision = approvalRevision.current; const statuses = statusRevision.current; const metadata = sessionRevision.current; const next = await api.bootstrap(); setData(applySessionUpdates(applyStatusUpdates(next, statuses, liveStatuses.current), metadata, sessionUpdates.current)); if (revision === approvalRevision.current) setApprovals(next.approvals || []); }, []);

  useEffect(() => {
    let active = true;
    const revision = approvalRevision.current;
    const statuses = statusRevision.current;
    api.bootstrap().then((next) => {
      if (!active) return; setData(applyStatusUpdates(next, statuses, liveStatuses.current));
      if (revision === approvalRevision.current) setApprovals(next.approvals || []);
      const remembered = localStorage.getItem('workbench-project');
      const first = next.projects.find((item) => item.id === remembered) || next.projects[0];
      if (first) { setProjectId(first.id); setSessionId(latestProjectChat(next.sessions, first.id)?.id); }
    }).catch((cause) => { if (active) reportError(cause); }).finally(() => { if (active) setInitializing(false); });
    return () => { active = false; };
  }, [reportError]);
  useEffect(() => { if (projectId) localStorage.setItem('workbench-project', projectId); }, [projectId]);
  useEffect(() => {
    const generation = ++messageGeneration.current; setMessages([]); setContext(undefined);
    if (!sessionId) { setLoadingMessages(false); return; }
    setLoadingMessages(true);
    Promise.all([api.getMessages(sessionId), api.getContext(sessionId)]).then(([nextMessages, nextContext]) => { if (generation === messageGeneration.current && selectedRef.current.sessionId === sessionId) { setMessages((live) => mergeLoadedMessages(nextMessages, live)); setContext((live) => live || nextContext); } }).catch((cause) => { if (generation === messageGeneration.current && selectedRef.current.sessionId === sessionId) reportError(cause); }).finally(() => { if (generation === messageGeneration.current && selectedRef.current.sessionId === sessionId) setLoadingMessages(false); });
  }, [sessionId, reportError]);
  useEffect(() => api.onEvent((event: AgentEvent) => {
    const isSelected = event.sessionId === selectedRef.current.sessionId;
    if (isSelected && (event.type === 'context' || event.type === 'status' && event.status === 'running')) setError(undefined);
    if (event.type === 'status' && event.status && event.sessionId) {
      const update = { revision: ++statusRevision.current, status: event.status, updatedAt: new Date().toISOString() };
      liveStatuses.current.set(event.sessionId, update);
      setData((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === event.sessionId ? { ...item, status: update.status, updatedAt: update.updatedAt } : item) }));
    }
    if (event.type === 'message' && event.message && isSelected) setMessages((current) => { const existing = current.findIndex((item) => item.id === event.message!.id); return existing >= 0 ? current.map((item, index) => index === existing ? event.message! : item) : [...current, event.message!]; });
    if (event.type === 'delta' && event.messageId && isSelected) setMessages((current) => { const existing = current.findIndex((item) => item.id === event.messageId); if (existing < 0) return [...current, { id: event.messageId!, role: 'assistant', content: event.text || '', createdAt: new Date().toISOString() }]; return current.map((item, index) => index === existing ? { ...item, content: item.content + (event.text || '') } : item); });
    if (event.type === 'context' && isSelected && event.context) setContext(event.context);
    if (event.type === 'approval' && event.approval) { approvalRevision.current++; setApprovals((current) => current.some((item) => item.id === event.approval!.id) ? current : [...current, event.approval!]); }
    if (event.type === 'approval-dismissed' && event.requestId) { approvalRevision.current++; setApprovals((current) => current.filter((item) => item.id !== event.requestId)); }
    if (event.type === 'changes') setRevision((current) => current + 1);
    if (event.type === 'error' && isSelected) setError(event.error || event.text || 'Ошибка агента');
    if (event.type === 'refresh') void refresh().catch(reportError);
  }), [refresh, reportError]);

  const createSession = useCallback(async (targetProjectId: string) => {
    const selection = ++selectionGeneration.current;
    const model = fallbackChatModel(dataRef.current.models);
    if (!model) { setModal('models'); return; }
    try { await pendingSelection.current; const created = await api.createSession(targetProjectId, model.id); setData((current) => ({ ...current, sessions: [created, ...current.sessions.filter((item) => item.id !== created.id)] })); if (selection === selectionGeneration.current) { selectedRef.current = { projectId: targetProjectId, sessionId: created.id }; setProjectId(targetProjectId); setSessionId(created.id); } } catch (cause) { reportError(cause); }
  }, [reportError]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && selectedRef.current.projectId && !modal && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); void createSession(selectedRef.current.projectId); } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [createSession, modal]);
  const chooseSession = (id: string) => {
    const target = dataRef.current.sessions.find(chat => chat.id === id); if (!target) return;
    ++selectionGeneration.current; selectedRef.current = { projectId: target.projectId, sessionId: id }; setProjectId(target.projectId); setSessionId(id);
    if (!target.archivedAt) pendingSelection.current = api.updateSession(id, { rememberSelection: true }).then(saved => { setData(current => ({ ...current, sessions: current.sessions.map(chat => chat.id === id ? { ...chat, updatedAt: saved.updatedAt } : chat) })); }).catch(reportError);
  };
  const chooseProject = (id: string) => { ++selectionGeneration.current; setProjectId(id); const latest = latestProjectChat(dataRef.current.sessions, id); if (latest) chooseSession(latest.id); else { selectedRef.current = { projectId: id, sessionId: undefined }; setSessionId(undefined); void createSession(id); } };
  const updateChat = async (id: string, patch: SessionPatch) => {
    const statuses = statusRevision.current;
    try {
      const saved = await api.updateSession(id, patch);
      const metadata: SessionMetadata = {};
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (key !== 'rememberSelection') Object.assign(metadata, { [key]: saved[key] });
      if (patch.title !== undefined) metadata.titleSource = saved.titleSource;
      sessionUpdates.current.set(saved.id, { revision: ++sessionRevision.current, metadata: { ...sessionUpdates.current.get(saved.id)?.metadata, ...metadata } });
      const live = liveStatuses.current.get(saved.id);
      const value = live && live.revision > statuses ? { ...saved, status: live.status, updatedAt: live.updatedAt } : saved;
      setData((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === saved.id ? value : item) }));
    } catch (cause) { reportError(cause); throw cause; }
  };
  const updateSession = async (patch: SessionPatch) => { if (sessionId) await updateChat(sessionId, patch); };
  const archiveChat = async (id: string) => {
    await updateChat(id, { archivedAt: new Date().toISOString() });
    if (selectedRef.current.sessionId === id) { const latest = latestProjectChat(dataRef.current.sessions.filter(chat => chat.id !== id), selectedRef.current.projectId!); if (latest) chooseSession(latest.id); else { selectedRef.current = { projectId: selectedRef.current.projectId, sessionId: undefined }; setSessionId(undefined); } }
  };
  const restoreChat = async (id: string) => { await updateChat(id, { archivedAt: null }); const target = dataRef.current.sessions.find(chat => chat.id === id); if (target) { ++selectionGeneration.current; selectedRef.current = { projectId: target.projectId, sessionId: id }; setProjectId(target.projectId); setSessionId(id); pendingSelection.current = api.updateSession(id, { rememberSelection: true }).catch(reportError); } };
  const savedProject = (saved: Project) => { setData((current) => ({ ...current, projects: current.projects.some((item) => item.id === saved.id) ? current.projects.map((item) => item.id === saved.id ? saved : item) : [...current.projects, saved] })); setModal(undefined); setEditProject(undefined); setProjectId(saved.id); if (!data.sessions.some((item) => item.projectId === saved.id)) void createSession(saved.id); };
  const deleteProject = () => { const removedId = editProject?.id; const remaining = data.projects.filter((item) => item.id !== removedId); setData((current) => ({ ...current, projects: remaining, sessions: current.sessions.filter((item) => item.projectId !== removedId) })); setModal(undefined); if (projectId === removedId) { setProjectId(remaining[0]?.id); setSessionId(remaining[0] ? latestProjectChat(data.sessions, remaining[0].id)?.id : undefined); } };
  const approval = approvals[0];
  const activeStatus = data.sessions.some((item) => item.status === 'running' || item.status === 'approval') || approvals.length > 0;
  const decideApproval = async (approved: boolean) => { if (!approval) return; setApprovalBusy(true); try { await api.respondApproval(approval.id, approved); approvalRevision.current++; setApprovals((current) => current.filter((item) => item.id !== approval.id)); } catch (cause) { reportError(cause); } finally { setApprovalBusy(false); } };
  const stopApprovalRun = async () => { if (!approval) return; setApprovalBusy(true); try { await api.stopRun(approval.sessionId); } catch (cause) { reportError(cause); } finally { setApprovalBusy(false); } };
  if (initializing) return <div className="app-loading"><div className="brand-symbol">✳</div><h1>Workbench</h1><Busy text="Открываем рабочее пространство…" /></div>;
  return <div className={`app-shell ${panelOpen ? 'with-panel' : 'without-panel'}`}><div className="titlebar"><div className="window-space" /><div className="titlebar-label">Workbench <span>·</span> {project?.name || 'Личное пространство'}</div><button className="panel-toggle" onClick={() => setPanelOpen((value) => !value)} aria-label={panelOpen ? 'Скрыть файлы' : 'Показать файлы'}>{panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div><Sidebar projects={data.projects} sessions={data.sessions} projectId={projectId} sessionId={sessionId} onProject={chooseProject} onSession={chooseSession} onRename={(id, title) => updateChat(id, { title })} onPin={chat => void updateChat(chat.id, { pinned: !chat.pinned }).catch(() => {})} onArchive={chat => void archiveChat(chat.id).catch(() => {})} onRestore={chat => void restoreChat(chat.id).catch(() => {})} onNewProject={() => { setEditProject(undefined); setModal('project'); }} onEditProject={(value) => { setEditProject(value); setModal('project'); }} onNewSession={(id) => void createSession(id)} onSkills={() => setModal('skills')} onModels={() => setModal('models')} onMcp={() => setModal('mcp')} />
    <Chat onNewSession={() => { if (projectId) void createSession(projectId); }} onRestore={() => { if (sessionId) void restoreChat(sessionId).catch(() => {}); }} project={project} session={session} models={data.models} defaultLimits={data.settings?.runLimits} messages={messages} context={context} loading={loadingMessages} onSend={async (text, attachments) => { if (sessionId) await api.sendMessage(sessionId, text, attachments); }} onStop={() => { if (sessionId) void api.stopRun(sessionId).catch(reportError); }} onConfigure={updateSession} onRename={(title) => void updateSession({ title }).catch(() => {})} onProjectChanged={() => void refresh().catch(reportError)} onRuns={() => { setPanelOpen(true); setPanelTab('runs'); }} onNewProject={() => { setEditProject(undefined); setModal('project'); }} onModels={() => setModal('models')} onContext={() => { setPanelOpen(true); setPanelTab('context'); }} onProjectSettings={() => { if (project) { setEditProject(project); setModal('project'); } }} />
    {panelOpen && <WorkspacePanel key={projectId || 'no-project'} skills={data.skills} project={project} session={session} context={context} tab={panelTab} onTab={setPanelTab} revision={revision} onProjectChanged={() => void refresh().catch(reportError)} onError={reportError} onHide={() => setPanelOpen(false)} />}
    {error && <div className="toast" role="alert"><span>{error}</span><IconButton label="Закрыть уведомление" onClick={() => setError(undefined)}><X size={15} /></IconButton></div>}
    {modal === 'project' && <ProjectDialog project={editProject} sandboxAvailable={data.sandboxAvailable} defaultLimits={data.settings?.runLimits} onClose={() => setModal(undefined)} onSaved={savedProject} onDeleted={deleteProject} />}
    {modal === 'models' && <ModelsDialog models={data.models} onClose={() => setModal(undefined)} onChanged={refresh} />}
    {modal === 'skills' && <SkillsDialog projects={data.projects} projectId={projectId} onClose={() => setModal(undefined)} onChanged={refresh} />}
    {modal === 'mcp' && <McpDialog servers={data.mcpServers || []} projects={data.projects} projectId={projectId} sandboxAvailable={data.sandboxAvailable} locked={activeStatus} onClose={() => setModal(undefined)} onChanged={refresh} />}
    {approval && <Modal title="Разрешение на действие" subtitle={data.projects.find((item) => item.id === approval.projectId)?.name} onClose={() => { if (!approvalBusy) void decideApproval(false); }}><div className="modal-content approval-content"><div className="approval-icon"><ShieldCheck size={27} /></div><h3>{approval.title}</h3><pre>{approval.description}</pre><p>Разрешение действует для этого действия. Вы можете остановить задачу в любой момент.</p><ErrorNote text={error} /></div><footer className="modal-footer"><div className="footer-actions"><button className="secondary-button" disabled={approvalBusy} onClick={() => void stopApprovalRun()}><Square size={11} fill="currentColor" />Остановить задачу</button><button className="secondary-button" disabled={approvalBusy} onClick={() => void decideApproval(false)}>Отклонить</button></div><button className="primary-button" disabled={approvalBusy} onClick={() => void decideApproval(true)}>{approvalBusy ? <Busy text="" /> : 'Разрешить'}</button></footer></Modal>}
  </div>;
}
