import { useEffect, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { FileCode2, RefreshCw, Undo2 } from 'lucide-react';
import type { FileChange, Project } from '../../shared/types';
import { api, basename, errorText } from '../api';
import { ErrorNote, IconButton } from './Common';

export function ChangesPanel({ project, revision, active }: { project: Project; revision: number; active: boolean }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState<FileChange>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const load = async () => { const target = ++generation.current; try { const values = await api.getChanges(project.id); if (target === generation.current) { setChanges(values); setSelected((current) => values.find((item) => item.id === current?.id) || values[0]); } } catch (cause) { if (target === generation.current) setError(errorText(cause)); } };
  useEffect(() => { if (active) void load(); return () => { generation.current++; }; }, [project.id, revision, active]);
  const revert = async () => { if (!selected) return; setBusy(true); setError(undefined); try { await api.revertChange(project.id, selected.id); setConfirm(false); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <><ErrorNote text={error} /><div className="changes-toolbar"><span>{changes.length} {changes.length === 1 ? 'изменение' : 'изменений'}</span><IconButton label="Обновить изменения" onClick={() => void load()}><RefreshCw size={13} /></IconButton></div>
    {!changes.length ? <div className="panel-empty"><FileCode2 size={28} strokeWidth={1.25} /><p>Изменения появятся здесь,<br />когда агент отредактирует файлы.</p></div> : <><div className="change-files">{changes.map((change) => <button className={`change-file ${change.id === selected?.id ? 'active' : ''}`} key={change.id} onClick={() => { setSelected(change); setConfirm(false); }}><span className={`change-badge ${change.after === null ? 'deleted' : change.before === null ? 'added' : ''}`}>{change.after === null ? 'D' : change.before === null ? 'A' : 'M'}</span><span title={change.path}>{basename(change.path)}</span><small>{new Date(change.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</small></button>)}</div>
      {selected && <div className="diff-container"><div className="diff-heading"><span title={selected.path}>{selected.path}</span></div><FileDiff before={selected.before || ''} after={selected.after || ''} /><div className="diff-footer">{confirm ? <div className="revert-confirm"><p>Вернуть содержимое до этой правки?</p><button className="secondary-button" onClick={() => setConfirm(false)}>Отмена</button><button className="danger-button" disabled={busy} onClick={() => void revert()}>Вернуть</button></div> : <button className="secondary-button" onClick={() => setConfirm(true)}><Undo2 size={14} />Отменить эту правку</button>}</div></div>}
    </>}
  </>;
}
function FileDiff({ before, after }: { before: string; after: string }) {
  let oldLine = 0; let newLine = 0;
  return <div className="diff-lines">{diffLines(before, after).flatMap((part, partIndex) => part.value.replace(/\n$/, '').split('\n').map((line, index) => {
    if (!part.added) oldLine++; if (!part.removed) newLine++;
    return <div className={`diff-line ${part.added ? 'added' : part.removed ? 'removed' : ''}`} key={`${partIndex}-${index}`}><span className="diff-number">{part.added ? '' : oldLine}</span><span className="diff-number">{part.removed ? '' : newLine}</span><span className="diff-marker">{part.added ? '+' : part.removed ? '−' : ' '}</span><code>{line || ' '}</code></div>;
  }))}</div>;
}
