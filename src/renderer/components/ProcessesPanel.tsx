import { useEffect, useRef, useState } from 'react';
import { Square, Terminal } from 'lucide-react';
import type { CommandProcess, Project, Session } from '../../shared/types';
import { api, errorText } from '../api';
import { Busy, ErrorNote } from './Common';

const labels: Record<CommandProcess['status'], string> = { running: 'Выполняется', completed: 'Завершён', failed: 'Ошибка', stopped: 'Остановлен' };
export function ProcessesPanel({ project, session }: { project: Project; session?: Session }) {
  const [processes, setProcesses] = useState<CommandProcess[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const output = useRef<HTMLPreElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => { let active = true; setProcesses([]); api.listProcesses(project.id, session?.id).then((values) => { if (active) setProcesses((live) => { const ids = new Set(live.map((item) => item.id)); return [...live, ...values.filter((item) => !ids.has(item.id))]; }); }).catch((cause) => { if (active) setError(errorText(cause)); });
    const remove = api.onEvent((event) => { const value = event.command?.process; if (active && value?.projectId === project.id && (!session || value.sessionId === session.id)) setProcesses((current) => [value, ...current.filter((item) => item.id !== value.id)]); });
    return () => { active = false; remove(); };
  }, [project.id, session?.id]);
  const selected = processes.find((item) => item.id === selectedId) || processes[0];
  useEffect(() => { nearBottom.current = true; if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [selected?.id]);
  useEffect(() => { if (output.current && nearBottom.current) output.current.scrollTop = output.current.scrollHeight; }, [selected?.output]);
  const stop = async () => { if (!selected) return; setBusy(true); setError(undefined); try { await api.stopProcess(project.id, selected.id); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <div className="process-panel panel-scroll"><ErrorNote text={error} /><div className="panel-section-heading"><Terminal size={14} /><h3>Команды и процессы</h3></div>
    {processes.length === 0 ? <div className="panel-empty"><Terminal size={26} /><p>Здесь появятся запущенные команды и их живой вывод.</p></div> : <>
      <div className="run-list">{processes.map((item) => <button className={`panel-list-item ${selected?.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => setSelectedId(item.id)}><strong>{labels[item.status]}{item.background ? ' · фон' : ''}</strong><span>{item.command}</span></button>)}</div>
      {selected && <><code className="panel-command">{selected.command}</code><p className="field-help">{selected.cwd}{selected.exitCode !== undefined ? ` · код ${selected.exitCode}` : ''}</p><pre className="panel-output process-output" data-testid="command-output" ref={output} onScroll={() => { if (output.current) nearBottom.current = output.current.scrollHeight - output.current.scrollTop - output.current.clientHeight < 60; }}>{selected.output || 'Ожидаем вывод…'}</pre>{selected.status === 'running' && <button className="secondary-button" data-testid="process-stop" disabled={busy} onClick={() => void stop()}>{busy ? <Busy text="Останавливаем…" /> : <><Square size={12} />Остановить процесс</>}</button>}</>}
    </>}
  </div>;
}
