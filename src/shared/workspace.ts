export interface ContextPin { id: string; path: string; startLine?: number; endLine?: number }
export interface ProjectMapFile { path: string; relativePath: string; symbols: string[]; kind: string; signatures?: string[]; dependencies?: string[] }
export interface ProjectMap { files: ProjectMapFile[]; truncated: boolean; scanned: number; generatedAt: string }
export interface FileConflict { path: string; expectedVersion: string | null; currentVersion: string | null; currentContent: string | null }
export type FileWriteResult = { ok: true } | { ok: false; conflict: FileConflict };
export interface TaskCheckpoint { id: string; projectId: string; sessionId: string; title: string; createdAt: string; runId?: string }
export interface GitFileStatus { path: string; index: string; worktree: string; originalPath?: string }
export interface GitRootStatus { root: string; repository: boolean; branch?: string; head?: string; files: GitFileStatus[]; error?: string }
export interface GitStatus { roots: GitRootStatus[] }
export interface GitDiff { root: string; path?: string; staged: boolean; text: string; truncated: boolean }
export interface CommandProcess {
  id: string; projectId: string; sessionId: string; command: string; cwd: string;
  status: 'running' | 'completed' | 'failed' | 'stopped'; output: string;
  startedAt: string; finishedAt?: string; exitCode?: number; background: boolean;
  /** Normal managed exit, with no cancellation, timeout, startup failure or inherited open pipes. */
  exitObserved?: boolean;
}
export interface CommandUpdate { process: CommandProcess; delta?: string }
