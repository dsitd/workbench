import { useState } from 'react';
import { Save } from 'lucide-react';
import type { RunLimits } from '../../shared/types';
import { errorText } from '../api';
import { Busy, ErrorNote, Modal } from './Common';
import { RunLimitsFields } from './RunLimitsFields';

export function SessionLimitsDialog({ value, inherited, onSave, onClose }: {
  value: RunLimits; inherited: RunLimits; onSave: (limits: RunLimits) => Promise<void>; onClose: () => void;
}) {
  const [limits, setLimits] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => { setBusy(true); setError(undefined); try { await onSave(limits); onClose(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <Modal title="Бюджет этого чата" subtitle="Применяется к новым запускам и продолжению задачи" onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-content"><ErrorNote text={error} /><RunLimitsFields value={limits} inherited={inherited} disabled={busy} onChange={setLimits} /></div>
    <footer className="modal-footer"><span /><div className="footer-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary-button" data-testid="session-limits-save" disabled={busy} onClick={() => void save()}>{busy ? <Busy text="Сохраняем…" /> : <><Save size={14} />Сохранить</>}</button></div></footer>
  </Modal>;
}
