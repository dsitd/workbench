import { useEffect, useState } from 'react';
import { Pin, Plus, Save, X } from 'lucide-react';
import type { ContextPin, Project } from '../../shared/types';
import { api, basename, errorText } from '../api';
import { Busy, ErrorNote, IconButton } from './Common';
import { ContextPinPicker } from './ContextPinPicker';

export function ProjectKnowledge({ project, locked, onChanged }: { project: Project; locked: boolean; onChanged: () => void }) {
  const [pins, setPins] = useState<ContextPin[]>(project.pins || []);
  const [memory, setMemory] = useState(project.memory || '');
  const [savedMemory, setSavedMemory] = useState(project.memory || '');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  useEffect(() => { setPins(project.pins || []); }, [project.pins]);
  useEffect(() => { if (memory === savedMemory) setMemory(project.memory || ''); setSavedMemory(project.memory || ''); }, [project.memory]);
  const remove = async (id: string) => { setBusy(true); setError(undefined); try { setPins(await api.setContextPins(project.id, pins.filter((pin) => pin.id !== id))); onChanged(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  const save = async () => { setBusy(true); setError(undefined); try { await api.saveProjectMemory(project.id, memory); setSavedMemory(memory); setNotice('Память проекта сохранена'); onChanged(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <section className="project-knowledge"><ErrorNote text={error} /><div className="panel-section-heading"><Pin size={14} /><h3>Закреплённый контекст</h3><IconButton label="Закрепить файл" disabled={locked || busy} onClick={() => setPicker(true)}><Plus size={14} /></IconButton></div>
    {pins.length ? <div className="context-pin-list">{pins.map((pin) => <div className="context-pin" key={pin.id}><span title={pin.path}>{basename(pin.path)}{pin.startLine ? `:${pin.startLine}${pin.endLine && pin.endLine !== pin.startLine ? `–${pin.endLine}` : ''}` : ' · до 300 строк'}</span><IconButton label={`Убрать ${basename(pin.path)} из контекста`} disabled={locked || busy} onClick={() => void remove(pin.id)}><X size={12} /></IconButton></div>)}</div> : <p className="field-help">Файлы и диапазоны строк, которые нужны каждому запуску проекта.</p>}
    <label className="field project-memory"><span>Память проекта</span><textarea data-testid="project-memory" value={memory} onChange={(event) => { setMemory(event.target.value); setNotice(''); }} disabled={locked || busy} rows={7} placeholder="Короткие устойчивые решения и полезные сведения о проекте…" /></label>
    <button className="secondary-button" data-testid="memory-save" disabled={locked || busy || memory === savedMemory} onClick={() => void save()}>{busy ? <Busy text="Сохраняем…" /> : <><Save size={13} />Сохранить память</>}</button>{notice && <p className="field-help" role="status">{notice}</p>}
    {picker && <ContextPinPicker project={{ ...project, pins }} onClose={() => setPicker(false)} onSaved={(value) => { setPins(value); onChanged(); }} />}
  </section>;
}
