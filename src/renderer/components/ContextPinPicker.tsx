import { useEffect, useState } from 'react';
import { FileCode2, Pin, Search } from 'lucide-react';
import type { ContextPin, Project, ProjectMap, ProjectMapFile } from '../../shared/types';
import { api, errorText } from '../api';
import { Busy, ErrorNote, Modal } from './Common';

export function ContextPinPicker({ project, initialSearch = '', onClose, onSaved }: {
  project: Project; initialSearch?: string; onClose: () => void; onSaved: (pins: ContextPin[], file: ProjectMapFile, pin: ContextPin) => void;
}) {
  const [map, setMap] = useState<ProjectMap>();
  const [search, setSearch] = useState(initialSearch);
  const [selected, setSelected] = useState<ProjectMapFile>();
  const [startLine, setStartLine] = useState('');
  const [endLine, setEndLine] = useState('');
  const [lines, setLines] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; api.getProjectMap(project.id).then((value) => { if (active) setMap(value); }).catch((cause) => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [project.id]);
  useEffect(() => { let active = true; setLines(undefined); setStartLine(''); setEndLine(''); if (selected) api.readFile(project.id, selected.path).then((entry) => { if (active) setLines((entry.content || '').split('\n').length); }).catch((cause) => { if (active) setError(errorText(cause)); }); return () => { active = false; }; }, [project.id, selected?.path]);
  const filtered = (map?.files || []).filter((file) => `${file.relativePath} ${file.symbols.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const first = startLine === '' ? undefined : Number(startLine);
  const last = endLine === '' ? first : Number(endLine);
  const valid = first === undefined ? endLine === '' : Number.isInteger(first) && first > 0 && Number.isInteger(last) && (last ?? 0) >= first && (lines === undefined || (last ?? 0) <= lines);
  const save = async () => { if (!selected || !valid) return; setBusy(true); setError(undefined); try { const pin: ContextPin = { id: crypto.randomUUID(), path: selected.path, startLine: first, endLine: last }; const pins = await api.setContextPins(project.id, [...(project.pins || []), pin]); onSaved(pins, selected, pin); onClose(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <Modal title="Файл в контексте проекта" subtitle="Закрепите файл или точный диапазон строк" onClose={() => { if (!busy) onClose(); }} wide>
    <div className="split-dialog pin-picker"><aside className="dialog-list"><div className="search-field"><Search size={14} /><input data-testid="pin-search" aria-label="Поиск файлов и имён символов" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Путь или имя символа" /></div>
      {loading ? <Busy /> : filtered.map((file) => <button key={file.path} className={`model-list-item ${selected?.path === file.path ? 'active' : ''}`} onClick={() => { setSelected(file); setError(undefined); }} aria-pressed={selected?.path === file.path}><FileCode2 size={15} /><span><strong>{file.relativePath}</strong><small>{file.kind}</small></span></button>)}
      {!loading && filtered.length === 0 && <p className="empty-note">Подходящих файлов нет.</p>}
    </aside><div className="dialog-detail"><ErrorNote text={error} />{selected ? <><div className="panel-section-heading"><h3>{selected.relativePath}</h3></div><p className="field-help">{lines === undefined ? 'Считаем строки…' : `${lines} строк. Без диапазона используются первые 300 строк; большой фрагмент может быть сокращён в контексте.`}</p>
      <div className="form-grid"><label className="field"><span>С первой строки</span><input data-testid="pin-start" type="number" min={1} max={lines} value={startLine} onChange={(event) => setStartLine(event.target.value)} placeholder="Без диапазона" /></label><label className="field"><span>По строку включительно</span><input data-testid="pin-end" type="number" min={first || 1} max={lines} value={endLine} onChange={(event) => setEndLine(event.target.value)} placeholder={startLine || 'Без диапазона'} /></label></div>
      {!valid && <ErrorNote text="Укажите целый диапазон строк внутри выбранного файла." />}
      <div className="panel-section-heading"><h3>Имена в файле</h3></div><p className="field-help">Эвристическая карта помогает найти объявление; состав контекста показывает отправленный текст.</p><div className="symbol-chips">{selected.symbols.map((symbol, index) => <code key={`${symbol}-${index}`}>{symbol}</code>)}</div>
    </> : <div className="empty-detail"><Pin size={28} /><h3>Нужный фрагмент</h3><p>Выберите файл слева. Закреплённый контекст доступен чатам этого проекта.</p></div>}{map?.truncated && <p className="field-help">Карта ограничена размером проекта; показана часть файлов.</p>}</div></div>
    <footer className="modal-footer"><span /><div className="footer-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary-button" data-testid="pin-save" disabled={busy || !selected || !valid || lines === undefined} onClick={() => void save()}>{busy ? <Busy text="Закрепляем…" /> : <><Pin size={14} />Закрепить</>}</button></div></footer>
  </Modal>;
}
