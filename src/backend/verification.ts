import { randomUUID } from 'node:crypto';
import type { WorkspaceServices } from './index';
import type { Project, RunRecord, Session, VerificationResult } from '../shared/types';
import { agentMode } from '../shared/modes';

/** One command path for manual checks and checks performed inside the agent loop. */
export async function verifyProjectRun(workspace: WorkspaceServices, run: RunRecord, session: Session, project: Project, signal: AbortSignal): Promise<VerificationResult> {
  if (!project.verificationCommand) throw new Error('Задайте команду проверки в настройках проекта.');
  if (agentMode(session.mode) === 'plan') throw new Error('Режим плана не позволяет запускать команды проверки.');
  if (!run.checkpointId) run.checkpointId = await workspace.createCheckpoint(project, session.id, 'Перед проверкой задачи', run.id);
  const result: VerificationResult = { id: randomUUID(), runId: run.id, projectId: project.id, sessionId: session.id,
    command: project.verificationCommand, cwd: project.folders[0].path, status: 'running', output: '', startedAt: new Date().toISOString() };
  run.verification = result; run.phase = 'verification'; await workspace.saveRun(run);
  try {
    let process: Awaited<ReturnType<WorkspaceServices['commands']['runDetailed']>> | undefined;
    result.output = await workspace.files.trackCommand(project, session.id, async () => {
      process = await workspace.commands.runDetailed({ project, sessionId: session.id, mode: agentMode(session.mode), signal, runId: run.id, checkpointId: run.checkpointId }, result.command, result.cwd, 300_000, await workspace.skills.readRoots(project.id));
      return process.output;
    }, run.checkpointId);
    result.exitCode = process!.exitCode;
    result.status = process!.status === 'stopped' ? 'cancelled' : process!.status === 'completed' && process!.exitCode === 0 ? 'passed' : 'failed';
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'failed';
    result.output = error instanceof Error ? error.message : 'Не удалось запустить проверку.';
  } finally {
    result.finishedAt = new Date().toISOString(); result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
    run.verifiedRevision = run.mutationRevision ?? 0;
    run.phase = run.status === 'running' ? 'model' : 'final';
    run.changedFiles = run.checkpointId ? [...new Set((await workspace.getChanges(run.projectId)).filter(change => change.checkpointId === run.checkpointId).map(change => change.path))] : [];
    await workspace.saveRun(run);
  }
  return result;
}
