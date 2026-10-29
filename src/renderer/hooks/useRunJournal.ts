import { useEffect, useRef, useState } from 'react';
import type { RunRecord } from '../../shared/types';
import { api, errorText } from '../api';

export function useRunJournal(projectId?: string, sessionId?: string) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const scope = useRef({ projectId, sessionId }); scope.current = { projectId, sessionId };
  useEffect(() => {
    const target = ++generation.current; setRuns([]); setError(undefined);
    if (!projectId) return;
    api.listRuns(projectId, sessionId).then((loaded) => { if (target === generation.current) setRuns((live) => {
      const ids = new Set(live.map((run) => run.id)); return [...live, ...loaded.filter((run) => !ids.has(run.id))].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }); }).catch((cause) => { if (target === generation.current) setError(errorText(cause)); });
    return () => { generation.current++; };
  }, [projectId, sessionId]);
  useEffect(() => api.onEvent((event) => {
    const run = event.run;
    if (event.type !== 'run' || !run || run.projectId !== scope.current.projectId || (scope.current.sessionId && run.sessionId !== scope.current.sessionId)) return;
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }), []);
  return { runs, error };
}
