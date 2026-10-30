import { shortcutModifier } from '../platform';
import { useState } from 'react';
import { Archive, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, FolderOpen, MessageSquare, MoreHorizontal, Pin, Plug, Plus, Settings2, Sparkles } from 'lucide-react';
import type { Project, Session } from '../../shared/types';
import { Busy, ErrorNote, IconButton, Modal } from './Common';
import { ChatMenu } from './ChatMenu';
import { projectChats } from '../chat-navigation';
import { errorText } from '../api';

export function Sidebar({ projects, sessions, projectId, sessionId, onProject, onSession, onNewProject, onEditProject, onNewSession, onRename, onPin, onArchive, onRestore, onSkills, onModels, onMcp }: {
  projects: Project[]; sessions: Session[]; projectId?: string; sessionId?: string;
  onProject: (id: string) => void; onSession: (id: string) => void; onNewProject: () => void;
  onEditProject: (project: Project) => void; onNewSession: (projectId: string) => void; onSkills: () => void; onModels: () => void; onMcp: () => void;
  onRename: (id: string, title: string) => Promise<void>; onPin: (chat: Session) => void; onArchive: (chat: Session) => void; onRestore: (chat: Session) => void;
}) {
  const [archives, setArchives] = useState(new Set<string>());
  const [renaming, setRenaming] = useState<Session>();
  const [title, setTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const rename = async () => { if (!renaming || busy || !title.trim()) return; setBusy(true); setError(undefined); try { await onRename(renaming.id, title.trim()); setRenaming(undefined); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const row = (chat: Session) => <div className={`session-entry ${chat.id === sessionId ? 'active' : ''}`} key={chat.id} data-testid={`chat-row-${chat.id}`}><button className={`session-row ${chat.id === sessionId ? 'active' : ''}`} onClick={() => onSession(chat.id)} title={chat.title}>{chat.pinned ? <Pin size={12} /> : <MessageSquare size={13} />}<span>{chat.title}</span>{(chat.status === 'running' || chat.status === 'approval') && <i className={`session-dot ${chat.status}`} />}</button><ChatMenu chat={chat} onRename={() => { setRenaming(chat); setTitle(chat.title); setError(undefined); }} onPin={() => onPin(chat)} onArchive={() => onArchive(chat)} onRestore={() => onRestore(chat)} /></div>;
  return <aside className="sidebar"><div className="sidebar-brand"><div className="brand-symbol"><Sparkles size={21} strokeWidth={1.5} /></div><span>Workbench</span><span className="brand-local">local</span></div>
    <button className="new-chat-button" disabled={!projectId} onClick={() => projectId && onNewSession(projectId)}><Plus size={17} /><span>Новый чат</span><kbd>{shortcutModifier} N</kbd></button>
    <div className="sidebar-section-label"><span>ПРОЕКТЫ</span><IconButton label="Добавить проект" testId="project-create" onClick={onNewProject}><Plus size={15} /></IconButton></div>
    <nav className="project-list" aria-label="Проекты">{projects.length === 0 && <p className="sidebar-empty">Добавьте папку проекта,<br />чтобы начать работу.</p>}{projects.map((project) => {
      const selected = project.id === projectId;
      const projectSessions = projectChats(sessions, project.id), archived = projectChats(sessions, project.id, true);
      const showArchive = archives.has(project.id) || archived.some(chat => chat.id === sessionId);
      return <div className="project-group" key={project.id}><div className={`project-row ${selected ? 'active' : ''}`}><button className="project-select" onClick={() => onProject(project.id)}>{selected ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderOpen size={16} /><span>{project.name}</span></button><IconButton testId={`project-new-chat-${project.id}`} label={`Новый чат в проекте ${project.name}`} onClick={() => onNewSession(project.id)}><Plus size={14} /></IconButton><IconButton label={`Настройки проекта ${project.name}`} onClick={() => onEditProject(project)}><MoreHorizontal size={16} /></IconButton></div>
        {selected && <div className="session-list">{projectSessions.length === 0 && <button className="session-empty" onClick={() => onNewSession(project.id)}><Plus size={13} /> Создать первый чат</button>}{projectSessions.map(row)}{archived.length > 0 && <><button className="archive-toggle" data-testid={`chat-archive-toggle-${project.id}`} aria-expanded={showArchive} onClick={() => setArchives(current => { const next = new Set(current); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; })}><Archive size={12} /><span>Архив</span><small>{archived.length}</small>{showArchive ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>{showArchive && <div className="archived-chats">{archived.map(row)}</div>}</>}</div>}
      </div>;
    })}</nav>
    <div className="sidebar-bottom"><button data-testid="skills-open" onClick={onSkills}><BookOpen size={17} /><span>Библиотека skills</span><ArrowUpRight size={13} /></button><button data-testid="mcp-open" onClick={onMcp}><Plug size={17} /><span>MCP-серверы</span></button><button data-testid="models-open" onClick={onModels}><Settings2 size={17} /><span>Модели и настройки</span></button><div className="local-footer"><span className="local-dot" />Работает на вашем Mac</div></div>
    {renaming && <Modal title="Переименовать чат" subtitle={projects.find(project => project.id === renaming.projectId)?.name} onClose={() => { if (!busy) setRenaming(undefined); }}><div className="modal-content"><ErrorNote text={error} /><label className="field"><span>Название чата</span><input autoFocus data-testid="chat-title-input" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(); }} /></label></div><footer className="modal-footer"><span /><div className="footer-actions"><button className="secondary-button" disabled={busy} onClick={() => setRenaming(undefined)}>Отмена</button><button data-testid="chat-title-save" className="primary-button" disabled={busy || !title.trim()} onClick={() => void rename()}>{busy ? <Busy text="Сохраняем…" /> : 'Сохранить'}</button></div></footer></Modal>}
  </aside>;
}
