import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppSettings, Attachment, ChatMessage, FileChange, McpServerConfig, ModelConfig, Project, RunRecord, Session, Skill, TaskCheckpoint } from '../shared/types';
import { ignoreMissing, isValidId, syncDirectory, validId, writeAtomic } from './durable-files';
import { MessageLog, serializeMessages } from './message-log';
export { validId } from './durable-files';

export interface StoredAttachment extends Attachment { file: string; source?: string; sha256?: string } // source: canonical import path, for inspect_image reuse
/** Change metadata; `before`/`after` bodies live in `changes/<id>.json`. */
export type ChangeRecord = Omit<FileChange, 'before' | 'after'> & { before?: never; after?: never; beforeVersion?: string | null; afterVersion?: string | null };
/** Layout v2: metadata only. Messages are append-only `messages/<sessionId>.jsonl`, change bodies `changes/<changeId>.json`. */
export interface WorkspaceState {
  version: 2;
  projects: Project[];
  sessions: Session[];
  models: ModelConfig[];
  modelPresetsInitialized?: boolean;
  modelPresetsRevision?: number;
  flashDefaultInitialized?: boolean;
  skills: Skill[];
  mcpServers?: McpServerConfig[];
  attachments: StoredAttachment[];
  changes: ChangeRecord[];
  runs?: RunRecord[];
  settings?: AppSettings;
  checkpoints?: TaskCheckpoint[];
}
interface LegacyWorkspaceState extends Omit<WorkspaceState, 'version' | 'changes'> { version: 1; messages: Record<string, ChatMessage[]>; changes: FileChange[] }
const initial = (): WorkspaceState => ({
  version: 2, projects: [], sessions: [], models: [], skills: [], mcpServers: [], attachments: [], changes: [], runs: [], checkpoints: [],
});
const unsupported = () => new Error('Unsupported workspace database. Existing data was preserved.');
export const backupName = 'workspace.v1.backup.json';
const collectAfterMs = 60_000;

export function changeRecord(change: FileChange): ChangeRecord {
  const { before: _before, after: _after, ...record } = change;
  return record;
}
const changeBody = (change: FileChange) => JSON.stringify({ before: change.before, after: change.after });

function legacyState(value: Record<string, unknown>): LegacyWorkspaceState {
  const messages = value.messages, changes = value.changes ?? [];
  if (!Array.isArray(value.projects) || !Array.isArray(value.sessions) || !messages || typeof messages !== 'object' || Array.isArray(messages) || !Array.isArray(changes)) throw unsupported();
  if (Object.values(messages).some(list => !Array.isArray(list))) throw unsupported();
  const ids = new Set<string>();
  for (const change of changes as FileChange[]) {
    if (!change || typeof change !== 'object' || !isValidId(change.id) || ids.has(change.id)) throw unsupported();
    ids.add(change.id);
  }
  return { ...value, changes } as unknown as LegacyWorkspaceState;
}
/** Bounded parallel file work; a failure is reported only after the whole batch settles, so nothing is left in flight. */
async function chunked<T>(items: readonly T[], operation: (item: T, index: number) => Promise<void>, size = 16): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    const failed = (await Promise.allSettled(items.slice(start, start + size).map((item, offset) => operation(item, start + offset)))).find(result => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
}

/** One serialized commit queue prevents unrelated IPC requests from losing metadata updates. */
export class StateStore {
  readonly directory: string;
  private state?: WorkspaceState;
  private loading?: Promise<WorkspaceState>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly log: MessageLog;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    this.log = new MessageLog(path.join(this.directory, 'messages'));
  }
  private get file() { return path.join(this.directory, 'workspace.json'); }
  private get changesDirectory() { return path.join(this.directory, 'changes'); }
  private changeFile(id: string) { return path.join(this.changesDirectory, `${validId(id)}.json`); }

  private async initialize(): Promise<WorkspaceState> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let original: Buffer;
    try { original = await readFile(this.file); }
    catch (error) { ignoreMissing(error); return this.state = initial(); }
    const parsed = JSON.parse(original.toString('utf8')) as Record<string, unknown> | null;
    if (parsed?.version === 1) return this.state = await this.migrate(original, legacyState(parsed));
    if (parsed?.version !== 2 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.changes)) throw unsupported();
    this.state = parsed as unknown as WorkspaceState;
    await this.collect(this.state).catch(() => undefined);
    return this.state;
  }

  /** v1 stays authoritative until the final rename, so a crash at any earlier step simply repeats the migration. */
  private async migrate(original: Buffer, legacy: LegacyWorkspaceState): Promise<WorkspaceState> {
    const { messages, changes, ...metadata } = legacy;
    const state: WorkspaceState = { ...metadata, version: 2, changes: changes.map(changeRecord) };
    await this.backup(original);
    await mkdir(this.log.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.changesDirectory, { recursive: true, mode: 0o700 });
    const sessions = [...new Set(state.sessions.map(session => session.id).filter(isValidId))];
    await chunked(sessions, async id => {
      const list = Object.hasOwn(messages, id) ? messages[id] : [];
      // A stale log from an abandoned newer layout must not reappear in a migrated chat.
      if (list.length) await writeAtomic(this.log.file(id), serializeMessages(list), true);
      else await unlink(this.log.file(id)).catch(ignoreMissing);
    });
    await chunked(changes, change => writeAtomic(this.changeFile(change.id), changeBody(change), true));
    await syncDirectory(this.log.directory); await syncDirectory(this.changesDirectory);
    await writeAtomic(this.file, JSON.stringify(state), true, 'workspace');
    await syncDirectory(this.directory);
    return state;
  }
  /** Never replaces an existing backup: a different v1 file gets its own content-named copy. A link publishes only a complete copy. */
  private async backup(original: Buffer): Promise<void> {
    let target = path.join(this.directory, backupName);
    try {
      if ((await readFile(target)).equals(original)) return;
      target = path.join(this.directory, `workspace.v1.${createHash('sha256').update(original).digest('hex').slice(0, 16)}.backup.json`);
    } catch (error) { ignoreMissing(error); }
    const temporary = path.join(this.directory, `.workspace-backup-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(original); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        try { await lstat(target); return; } catch (missing) { ignoreMissing(missing); }
        await rename(temporary, target);
      }
      await syncDirectory(this.directory);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  /** Removes logs, bodies and temporary files left by a crash between a metadata commit and file cleanup. */
  private async collect(state: WorkspaceState): Promise<void> {
    const cutoff = Date.now() - collectAfterMs;
    const sweep = async (directory: string, temporary: RegExp, owned?: RegExp, referenced?: Set<string>) => {
      let names: string[] = [];
      try { names = await readdir(directory); } catch (error) { ignoreMissing(error); }
      for (const name of names) {
        const id = owned?.exec(name)?.[1];
        if (id !== undefined ? referenced!.has(id) : !temporary.test(name)) continue;
        const file = path.join(directory, name);
        try { const info = await lstat(file); if (info.isFile() && info.mtimeMs < cutoff) await unlink(file); } catch { /* best effort */ }
      }
    };
    await sweep(this.directory, /^\.workspace(?:-backup)?-[0-9a-f-]{36}\.tmp$/);
    await sweep(this.log.directory, /^\..+\.tmp$/, /^([a-zA-Z0-9_-]{1,100})\.jsonl$/, new Set(state.sessions.map(session => session.id)));
    await sweep(this.changesDirectory, /^\..+\.tmp$/, /^([a-zA-Z0-9_-]{1,100})\.json$/, new Set(state.changes.map(change => change.id)));
  }
  private load(): Promise<WorkspaceState> { return this.loading ??= this.initialize(); }

  async read(): Promise<WorkspaceState> {
    await this.queue;
    return structuredClone(await this.load());
  }
  /** Like read(), but clones only the selected part of the state. */
  async view<T>(selector: (state: Readonly<WorkspaceState>) => T): Promise<T> {
    await this.queue;
    return structuredClone(selector(await this.load()));
  }

  async mutate<T>(operation: (draft: WorkspaceState) => T | Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      const draft = structuredClone(await this.load());
      const result = await operation(draft);
      await writeAtomic(this.file, JSON.stringify(draft), false, 'workspace');
      this.state = draft;
      this.loading = Promise.resolve(draft);
      return structuredClone(result);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  /** Copies of one session's history; other sessions are neither read nor cloned. */
  async messages(sessionId: string): Promise<ChatMessage[]> { validId(sessionId); await this.load(); return this.log.read(sessionId); }
  /** `prepare` validates against the metadata draft and returns the stored message; the commit updates metadata, then the line is appended. */
  async appendMessage(sessionId: string, prepare: (draft: WorkspaceState) => ChatMessage): Promise<void> {
    validId(sessionId); await this.load();
    await this.log.append(sessionId, ids => this.mutate(draft => {
      const message = prepare(draft);
      if (ids.has(message.id)) throw new Error('Message already exists.');
      return message;
    }));
  }
  /** Sessions that have stored messages, without parsing any history. */
  async messageSessions(): Promise<Set<string>> { await this.load(); return this.log.sessions(); }
  /** Deletes history files of sessions already removed from metadata. */
  async discardMessages(sessionIds: Iterable<string>): Promise<void> { await this.load(); await this.log.remove(sessionIds); }

  /** Bodies are written before the metadata commit; a failed commit removes them again. */
  async addChanges(changes: readonly FileChange[]): Promise<void> {
    if (!changes.length) return;
    await this.load();
    await mkdir(this.changesDirectory, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    try {
      await chunked(changes, async change => { await writeAtomic(this.changeFile(change.id), changeBody(change)); written.push(change.id); });
      await this.mutate(state => { state.changes.push(...changes.map(changeRecord)); });
    } catch (error) { await this.discardChanges(written).catch(() => undefined); throw error; }
  }
  /** Full changes in record order. `skipUnreadable` omits a missing or damaged body instead of failing the whole list. */
  async changeBodies(records: readonly ChangeRecord[], skipUnreadable = false): Promise<FileChange[]> {
    await this.load();
    const loaded: (FileChange | undefined)[] = new Array(records.length);
    await chunked(records, async (record, index) => {
      try { loaded[index] = await this.changeBody(record); } catch (error) { if (!skipUnreadable) throw error; }
    }, 32);
    return loaded.filter((change): change is FileChange => change !== undefined);
  }
  private async changeBody(record: ChangeRecord): Promise<FileChange> {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readFile(this.changeFile(record.id), 'utf8')); } catch { throw new Error('Change snapshot is missing or damaged.'); }
    const text = (value: unknown) => value === undefined || value === null || typeof value === 'string';
    if (!body || typeof body !== 'object' || !text(body.before) || !text(body.after)) throw new Error('Change snapshot is missing or damaged.');
    const change = { ...record } as unknown as FileChange;
    if (Object.hasOwn(body, 'before')) change.before = body.before as string | null;
    if (Object.hasOwn(body, 'after')) change.after = body.after as string | null;
    return change;
  }
  /** Commits removal of change metadata, then deletes the bodies; leftovers are collected on a later start. */
  async removeChanges(ids: Iterable<string>): Promise<void> {
    const removed = new Set(ids);
    await this.mutate(state => { state.changes = state.changes.filter(change => !removed.has(change.id)); });
    await this.discardChanges(removed).catch(() => undefined);
  }
  async discardChanges(ids: Iterable<string>): Promise<void> {
    await this.load();
    await chunked([...new Set(ids)], id => unlink(this.changeFile(id)).catch(ignoreMissing), 32);
  }
}

export function requireItem<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find(value => value.id === id);
  if (!item) throw new Error(`${label} not found.`);
  return item;
}
