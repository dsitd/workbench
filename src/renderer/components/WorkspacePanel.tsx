import { FileDiff, FolderOpen, FolderTree, GitBranch, History, Layers, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import type { ContextReport, Project, Session, Skill } from '../../shared/types';
import { IconButton } from './Common';
import { FileBrowser } from './FileBrowser';
import { ChangesPanel } from './ChangesPanel';
import { ContextView } from './ContextView';
import { RunsPanel } from './RunsPanel';
import { GitPanel } from './GitPanel';
import { ProcessesPanel } from './ProcessesPanel';

export type PanelTab = 'files' | 'changes' | 'context' | 'runs' | 'git' | 'processes';
const tabs: { value: PanelTab; label: string; Icon: LucideIcon }[] = [
  { value: 'files', label: 'Файлы', Icon: FolderTree }, { value: 'changes', label: 'Изменения', Icon: FileDiff }, { value: 'context', label: 'Контекст', Icon: Layers },
  { value: 'runs', label: 'Запуски', Icon: History }, { value: 'git', label: 'Git', Icon: GitBranch }, { value: 'processes', label: 'Команды', Icon: SquareTerminal },
];
export function WorkspacePanel({ project, session, context, tab, onTab, revision, onHide, skills, onProjectChanged }: {
  project?: Project; session?: Session; context?: ContextReport; tab: PanelTab; onTab: (tab: PanelTab) => void;
  revision: number; onError: (error: unknown) => void; onHide: () => void; skills: Skill[]; onProjectChanged: () => void;
}) {
  return <aside className="workspace-panel"><div className="panel-header"><div className="panel-tabs segmented-tabs">
    {tabs.map(({ value, label, Icon }) => <button data-testid={`tab-${value}`} key={value} className={tab === value ? 'active' : ''} aria-pressed={tab === value} aria-label={label} title={label} onClick={() => onTab(value)}><Icon size={14} aria-hidden="true" /><span>{label}</span></button>)}
  </div><IconButton label="Скрыть панель" onClick={onHide}><X size={14} /></IconButton></div>
    {!project ? <div className="panel-empty"><FolderOpen size={26} strokeWidth={1.25} /><p>Выберите проект,<br />чтобы увидеть его файлы.</p></div> : <>
      <div className="panel-page" hidden={tab !== 'files'}><FileBrowser project={project} revision={revision} active={tab === 'files'} /></div>
      <div className="panel-page" hidden={tab !== 'changes'}><ChangesPanel project={project} revision={revision} active={tab === 'changes'} /></div>
      <div className="panel-page" hidden={tab !== 'context'}><ContextView context={context} session={session} skills={skills} project={project} onChanged={onProjectChanged} /></div>
      {tab === 'runs' && <RunsPanel key={session?.id || project.id} project={project} session={session} />}
      {tab === 'git' && <GitPanel key={session?.id || project.id} project={project} session={session} revision={revision} />}
      {tab === 'processes' && <ProcessesPanel key={session?.id || project.id} project={project} session={session} />}
    </>}
  </aside>;
}
