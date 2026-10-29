import { useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw, Undo2 } from 'lucide-react';
import type { FileChange, GitDiff, GitRootStatus, GitStatus, Project, Session, TaskCheckpoint } from '../../shared/types';
import { api, basename, errorText } from '../api';
import { Busy, ErrorNote, IconButton, Modal } from './Common';

export function GitPanel({ project, session, revision }: { project: Project; session?: Session; revision: number }) {
  const [status, setStatus] = useState<GitStatus>();
  const [root, setRoot] = useState<string>();
  const [diff, setDiff] = useState<GitDiff>();
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [confirm, setConfirm] = useState<TaskCheckpoint>();
  const [staged, setStaged] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const diffGeneration = useRef(0);
  const activeProject = useRef(project.id); activeProject.current = project.id;
  const locked = session?.status === 'running' || session?.status === 'approval';
  const load = async () => { const target = ++generation.current; setLoading(true); setError(undefined); try {
    const [next, points, edits] = await Promise.all([api.getGitStatus(project.id), api.listCheckpoints(project.id, session?.id), api.getChanges(project.id)]);
    if (target !== generation.current || activeProject.current !== project.id) return;
    setStatus(next); setCheckpoints(points); setChanges(edits); setRoot((current) => next.roots.some((item) => item.root === current) ? current : next.roots[0]?.root);
  } catch (cause) { if (target === generation.current) setError(errorText(cause)); } finally { if (target === generation.current) setLoading(false); } };
  useEffect(() => { void load(); return () => { generation.current++; }; }, [project.id, session?.id, revision]);
  const selected: GitRootStatus | undefined = status?.roots.find((item) => item.root === root);
  useEffect(() => { const target = ++diffGeneration.current; setDiff(undefined); if (!selected?.repository) return;
    api.getGitDiff(project.id, selected.root, selectedPath, staged).then((value) => { if (target === diffGeneration.current) setDiff(value); }).catch((cause) => { if (target === diffGeneration.current) setError(errorText(cause)); });
    return () => { diffGeneration.current++; };
  }, [project.id, selected?.root, selected?.repository, selectedPath, staged, revision]);
  const revert = async () => { if (!confirm) return; setBusy(true); setError(undefined); try { await api.revertCheckpoint(project.id, confirm.id); setConfirm(undefined); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const checkpointChanges = changes.filter((change) => change.checkpointId === confirm?.id);
  return <div className="git-panel panel-scroll"><ErrorNote text={error} /><div className="panel-section-heading"><GitBranch size={14} /><h3>Git и изменения задачи</h3><IconButton label="Обновить Git" disabled={loading} onClick={() => void load()}><RefreshCw size={13} /></IconButton></div>
    {loading && !status ? <Busy /> : <><label className="field"><span>Папка проекта</span><select data-testid="git-root" value={root || ''} onChange={(event) => { setRoot(event.target.value); setSelectedPath(undefined); }}>{status?.roots.map((item) => <option key={item.root} value={item.root}>{basename(item.root)}</option>)}</select></label>
      {selected?.error && <ErrorNote text={selected.error} />}{selected && !selected.repository && <p className="field-help">В этой папке нет Git-репозитория.</p>}
      {selected?.repository && <><div className="git-branch"><GitBranch size={14} /><strong>{selected.branch || 'Detached HEAD'}</strong>{selected.head && <code>{selected.head.slice(0, 8)}</code>}</div>
        <label className="checkbox-row"><input data-testid="git-staged" type="checkbox" checked={staged} onChange={(event) => setStaged(event.target.checked)} /><span>Подготовленные изменения</span></label>
        <button className="text-button" onClick={() => setSelectedPath(undefined)}>Показать общий diff</button>
        <div className="git-file-list">{selected.files.map((file) => <button className={`panel-list-item ${selectedPath === file.path ? 'active' : ''}`} key={`${file.path}-${file.index}-${file.worktree}`} onClick={() => setSelectedPath(file.path)}><strong><code>{file.index}{file.worktree}</code> {basename(file.path)}</strong><span title={file.path}>{file.path}</span></button>)}</div>
        {diff && <><pre className="panel-output git-diff" data-testid="git-diff">{diff.text || 'Изменений нет'}</pre>{diff.truncated && <p className="field-help">Diff ограничен по размеру.</p>}</>}
      </>}
      <section className="checkpoint-list"><div className="panel-section-heading"><h3>Контрольные точки задач</h3></div>{checkpoints.length === 0 ? <p className="field-help">Контрольная точка создаётся перед первым изменением задачи.</p> : checkpoints.map((checkpoint) => <div className="checkpoint" key={checkpoint.id}><strong>{checkpoint.title}</strong><p>{new Date(checkpoint.createdAt).toLocaleString('ru')}</p><button data-testid={`checkpoint-revert-${checkpoint.id}`} className="secondary-button" disabled={busy || locked} onClick={() => setConfirm(checkpoint)}><Undo2 size={13} />Отменить изменения задачи</button></div>)}</section>
    </>}
    {confirm && <Modal title="Отменить изменения задачи?" subtitle={confirm.title} onClose={() => { if (!busy) setConfirm(undefined); }}><div className="modal-content"><ErrorNote text={error} /><p className="field-help">Будут возвращены сохранённые версии файлов этой контрольной точки. Более новые внешние правки требуют отдельной сверки.</p>{checkpointChanges.length > 0 && <ul className="checkpoint-files">{checkpointChanges.map((change) => <li key={change.id}>{change.path}</li>)}</ul>}</div><footer className="modal-footer"><span /><div className="footer-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirm(undefined)}>Оставить</button><button className="danger-button" data-testid="checkpoint-revert-confirm" disabled={busy || locked} onClick={() => void revert()}>{busy ? <Busy text="Возвращаем…" /> : 'Отменить изменения'}</button></div></footer></Modal>}
  </div>;
}
