import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, Attachment, ChatMessage, FileChange, McpServerConfig, ModelConfig, Project, RunRecord, Session, Skill, TaskCheckpoint } from '../shared/types';

export interface StoredAttachment extends Attachment { file: string; source?: string; sha256?: string } // source: canonical import path, for inspect_image reuse
export interface WorkspaceState {
  version: 1;
  projects: Project[];
  sessions: Session[];
  models: ModelConfig[];
  modelPresetsInitialized?: boolean;
  modelPresetsRevision?: number;
  flashDefaultInitialized?: boolean;
  skills: Skill[];
  mcpServers?: McpServerConfig[];
  attachments: StoredAttachment[];
  messages: Record<string, ChatMessage[]>;
  changes: FileChange[];
  runs?: RunRecord[];
  settings?: AppSettings;
  checkpoints?: TaskCheckpoint[];
}
const initial = (): WorkspaceState => ({
  version: 1, projects: [], sessions: [], models: [], skills: [], mcpServers: [], attachments: [], messages: {}, changes: [], runs: [], checkpoints: [],
});

/** One serialized commit queue prevents unrelated IPC requests from losing updates. */
export class StateStore {
  readonly directory: string;
  private state?: WorkspaceState;
  private loading?: Promise<WorkspaceState>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string) { this.directory = path.resolve(directory); }

  private async initialize(): Promise<WorkspaceState> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, 'workspace.json'), 'utf8')) as WorkspaceState;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions) || !parsed.messages) {
        throw new Error('Unsupported workspace database. Existing data was preserved.');
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = initial();
    }
    return this.state!;
  }

  async read(): Promise<WorkspaceState> {
    await this.queue;
    this.loading ??= this.initialize();
    return structuredClone(await this.loading);
  }

  async mutate<T>(operation: (draft: WorkspaceState) => T | Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      this.loading ??= this.initialize();
      const draft = structuredClone(await this.loading);
      const result = await operation(draft);
      const temporary = path.join(this.directory, `.workspace-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(draft, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'workspace.json'));
      this.state = draft;
      this.loading = Promise.resolve(draft);
      return structuredClone(result);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}

export function requireItem<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find(value => value.id === id);
  if (!item) throw new Error(`${label} not found.`);
  return item;
}
export function validId(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid identifier.');
  return id;
}
