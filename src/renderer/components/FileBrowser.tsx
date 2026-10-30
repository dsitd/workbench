import { shortcutModifier } from '../platform';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen, LockKeyhole, RefreshCw, Save, X } from 'lucide-react';
import type { FileConflict, FileEntry, Project } from '../../shared/types';
import { api, basename, errorText, sizeLabel } from '../api';
import { Busy, ErrorNote, IconButton } from './Common';
import { ConflictReview } from './ConflictReview';

export function FileBrowser({ project, revision, active }: { project: Project; revision: number; active: boolean }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [directory, setDirectory] = useState<string>();
  const [file, setFile] = useState<FileEntry>();
  const [content, setContent] = useState('');
  const [conflict, setConflict] = useState<FileConflict>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const activeFile = useRef(file?.path); activeFile.current = file?.path;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; fileGeneration.current++; }; }, []);
  const dirty = Boolean(file && content !== file.content);
  const load = async () => { const target = ++generation.current; setBusy(true); setError(undefined); try { const values = await api.listFiles(project.id, directory); if (target === generation.current) setEntries(values); } catch (cause) { if (target === generation.current) setError(errorText(cause)); } finally { if (target === generation.current) setBusy(false); } };
  useEffect(() => { if (active) void load(); }, [project.id, directory, revision, active]);
  const close = () => { if (saving || dirty && !window.confirm('Закрыть файл без сохранения?')) return; fileGeneration.current++; setFile(undefined); setConflict(undefined); setError(undefined); };
  const open = async (entry: FileEntry) => {
    if (saving || dirty && !window.confirm('Есть несохранённые изменения. Открыть другой файл без сохранения?')) return;
    const target = ++fileGeneration.current; setConflict(undefined);
    if (entry.kind === 'directory') { setDirectory(entry.path); setFile(undefined); return; }
    setBusy(true); setError(undefined); try { const value = await api.readFile(project.id, entry.path); if (target === fileGeneration.current) { setFile(value); setContent(value.content || ''); } } catch (cause) { if (target === fileGeneration.current) setError(errorText(cause)); } finally { if (target === fileGeneration.current) setBusy(false); }
  };
  const goUp = () => { if (saving || dirty && !window.confirm('Закрыть файл без сохранения?')) return; fileGeneration.current++; setFile(undefined); setConflict(undefined); if (!directory) return; const root = project.folders.find((folder) => directory === folder.path || directory.startsWith(`${folder.path}/`))?.path; setDirectory(directory === root ? undefined : directory.substring(0, directory.lastIndexOf('/'))); };
  const save = async () => {
    if (!file || !file.writable || saving || conflict) return;
    const path = file.path; const savedContent = content; setSaving(true); setError(undefined);
    try {
      const result = await api.writeFile(project.id, path, savedContent, file.version ?? null);
      if (!mounted.current || activeFile.current !== path) return;
      if (!result.ok) { setConflict(result.conflict); return; }
      const latest = await api.readFile(project.id, path);
      if (!mounted.current || activeFile.current !== path) return;
      if (latest.content !== savedContent) { setConflict({ path, expectedVersion: file.version ?? null, currentVersion: latest.version ?? null, currentContent: latest.content ?? null }); return; }
      setFile(latest);
    } catch (cause) { if (mounted.current && activeFile.current === path) setError(errorText(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const reread = async () => { if (!file) return; const path = file.path; setSaving(true); setError(undefined); try { const latest = await api.readFile(project.id, path); if (mounted.current && activeFile.current === path) { setConflict({ path, expectedVersion: file.version ?? null, currentVersion: latest.version ?? null, currentContent: latest.content ?? null }); setFile((current) => current ? { ...current, writable: latest.writable } : current); } } catch (cause) { if (mounted.current) setError(errorText(cause)); } finally { if (mounted.current) setSaving(false); } };
  const reviewed = () => { if (!conflict || !file) return; setFile({ ...file, version: conflict.currentVersion ?? undefined, content: conflict.currentContent ?? '' }); setConflict(undefined); };
  return <><ErrorNote text={error} /><div className="file-breadcrumb"><button onClick={goUp} disabled={saving}><FolderOpen size={13} /><span>{directory ? basename(directory) : 'Папки проекта'}</span></button>{busy ? <Busy text="" /> : <IconButton label="Обновить файлы" onClick={() => void load()}><RefreshCw size={13} /></IconButton>}</div>
    {file ? <div className="file-editor"><div className="editor-header"><FileCode2 size={14} /><span title={file.path}>{file.name}</span>{dirty && <span className="unsaved-dot" title="Не сохранено" />}{!file.writable && <LockKeyhole size={12} />}<IconButton label="Закрыть файл" disabled={saving} onClick={close}><X size={13} /></IconButton></div><div className="editor-path" title={file.path}>{file.path}</div>
      {conflict ? <ConflictReview currentContent={conflict.currentContent ?? ''} draft={content} busy={saving} onReload={() => void reread()} onDraft={setContent} onReviewed={reviewed} /> : <textarea data-testid="file-editor" className="code-editor" value={content} onChange={(event) => setContent(event.target.value)} readOnly={!file.writable || saving} spellCheck={false} aria-label={`Редактор ${file.name}`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }} />}
      <div className="editor-footer"><span>{conflict ? 'Сначала сверьте версии' : file.writable ? `${shortcutModifier} S — сохранить` : 'Только чтение'}</span><button className="secondary-button" data-testid="file-save" disabled={!dirty || !file.writable || saving || Boolean(conflict)} onClick={() => void save()}>{saving ? <Busy text="" /> : <Save size={13} />}Сохранить</button></div>
    </div> : <div className="file-list">{directory && <button className="file-row file-up" onClick={goUp}><FolderOpen size={15} /><span>..</span></button>}{entries.map((entry) => <button className="file-row" key={entry.path} onClick={() => void open(entry)} title={entry.path}>{entry.kind === 'directory' ? <Folder size={16} /> : <FileCode2 size={15} />}<span>{entry.name}</span>{!entry.writable && <LockKeyhole size={11} />}{entry.kind === 'directory' ? <ChevronRight size={12} /> : entry.size !== undefined ? <small>{sizeLabel(entry.size)}</small> : null}</button>)}{!entries.length && !busy && <div className="panel-empty"><p>Папка пуста.</p></div>}</div>}
  </>;
}
