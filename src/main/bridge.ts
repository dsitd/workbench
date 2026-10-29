import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Bootstrap, ContextReport, ModelConfig, WorkbenchAPI } from '../shared/types';
import { WorkspaceServices } from '../backend';
import { AgentRuntime } from '../agent';
import { testModelConnection } from '../agent/connection';
import { ApprovalBroker } from './approvals';
import { CredentialVault } from './credentials';
import { createMcpBridge } from './mcp';
import { isAgentMode } from '../shared/modes';
import { RunCoordinator } from './run-coordinator';

export async function createBridge(dataDir: string, getWindow: () => BrowserWindow | undefined, version: string) {
  const emit = (event: AgentEvent) => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('workbench:event', event);
  };
  const broker = new ApprovalBroker(emit);
  const workspace = new WorkspaceServices(dataDir, { approve: (request, signal) => broker.request(request, signal), emit });
  const vault = new CredentialVault(dataDir);
  await vault.initialize();
  const reports = new Map<string, ContextReport>();
  const active = new Set<string>();
  const work = new Map<string, Promise<void>>();
  const coordinator = new RunCoordinator(workspace, vault, emit);
  const sessionUpdates = new Map<string, Promise<void>>();
  let shuttingDown = false;
  const probes = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const mcp = createMcpBridge(workspace, vault, broker, emit, () => shuttingDown || active.size > 0 || probes.size > 0 || sessionUpdates.size > 0, { openExternal: url => shell.openExternal(url) });
  const runtime = new AgentRuntime({
    getSession: id => workspace.getSession(id), getProject: id => workspace.getProject(id),
    getModel: id => workspace.getModel(id), getMessages: id => workspace.getMessages(id),
    appendMessage: (id, message) => workspace.appendMessage(id, message),
    updateSession: (id, patch) => workspace.updateSession(id, patch),
    loadInstructions: project => workspace.loadInstructions(project),
    listSkills: projectId => workspace.listSkills(projectId), readSkill: id => workspace.readSkill(id),
    getAttachment: id => workspace.getAttachment(id), resolveImage: id => workspace.resolveImage(id),
    resolveCredential: async model => vault.resolve(model, await workspace.listModels()), get tools() { return workspace.tools; },
    listAdditionalTools: (project, signal) => mcp.manager.catalog(project, signal),
    approveTool: (request, signal) => broker.request(request, signal),
    executeTool: (call, context) => call.name.startsWith('mcp_') ? mcp.manager.execute(call, context) : workspace.executeTool(call, context), emit,
    saveContext: report => reports.set(report.sessionId, report),
    getLatestModelSummary: async id => (await workspace.listRuns(undefined, id)).find(run => run.modelSummary)?.modelSummary,
    getSettings: () => workspace.getSettings(), saveRun: run => workspace.saveRun(run), getRun: id => workspace.getRun(id),
    createCheckpoint: (project, id, title, runId) => workspace.createCheckpoint(project, id, title, runId),
    verifyRun: (run, signal) => coordinator.verifyActiveRun(run, signal),
    getProjectContext: (project, query, signal, id, navigationPaths) => workspace.getProjectContext(project, query, signal, id, navigationPaths),
    retainToolOutput: (call, context, result) => workspace.outputs.retain(call, context, result),
    beginOperation: (call, context) => workspace.operations.begin(call, context),
    finishOperation: (id, result) => workspace.operations.finish(id, result),
    recoverToolResult: (call, context) => workspace.operations.recoveredResult(call, context),
    recoverOperation: (call, context) => workspace.operations.recoveredOperation(call, context),
    operationStates: (ids, context) => workspace.operations.states(ids, context),
  });

  const bootstrap = async (): Promise<Bootstrap> => {
    const base = await workspace.bootstrap(id => vault.has(id));
    return { ...base, version, platform: process.platform, approvals: broker.listRequests(),
      models: base.models.map(model => ({ ...model, hasKey: vault.hasModel(model, base.models) })),
      mcpServers: (base.mcpServers ?? []).map(mcp.decorate),
    };
  };
  const openDialog = async (options: Electron.OpenDialogOptions) => {
    const window = getWindow();
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
  };
  const handlers: Partial<WorkbenchAPI> = {
    ...mcp.handlers,
    bootstrap,
    chooseFolders: async () => {
      const result = await openDialog({ title: 'Папки проекта', properties: ['openDirectory', 'multiSelections', 'createDirectory'] });
      return result.canceled ? [] : result.filePaths;
    },
    createProject: async input => { const result = await workspace.createProject(input); emit({ type: 'refresh' }); return result; },
    saveProject: async project => {
      const previous = await workspace.getProject(project.id);
      if (JSON.stringify(previous.folders) !== JSON.stringify(project.folders) || previous.internet !== project.internet || previous.commandPolicy !== project.commandPolicy) {
        const sessions = await workspace.listSessions(project.id);
        if (sessions.some(session => active.has(session.id)) || (await workspace.listProcesses(project.id)).some(process => process.status === 'running') || mcp.isTesting()) throw new Error('Остановите задачи этого проекта и дождитесь проверки MCP перед изменением доступа.');
        await mcp.disconnectProject(project.id);
      }
      const result = await workspace.saveProject(project); emit({ type: 'refresh' }); return result;
    },
    deleteProject: async id => {
      if (mcp.isTesting()) throw new Error('Дождитесь завершения проверки MCP перед удалением проекта.');
      for (const session of await workspace.listSessions(id)) { broker.cancelSession(session.id); coordinator.stop(session.id); await runtime.stop(session.id); await workspace.commands.stopSession(session.id); }
      await mcp.disconnectProject(id);
      await workspace.deleteProject(id); emit({ type: 'refresh' });
    },
    listSessions: id => workspace.listSessions(id),
    createSession: async (projectId, modelId) => { const result = await workspace.createSession(projectId, modelId); emit({ type: 'refresh' }); return result; },
    updateSession: async (id, patch) => {
      const configurationChange = patch.modelId !== undefined || patch.mode !== undefined || patch.reasoningEffort !== undefined || patch.runLimits !== undefined;
      if (patch.archivedAt && active.has(id)) throw new Error('Сначала остановите работу в чате, затем архивируйте его.');
      if (configurationChange && (active.has(id) || sessionUpdates.has(id))) throw new Error('Сначала остановите задачу и дождитесь сохранения настроек, чтобы сменить модель или режим.');
      const changes: Parameters<WorkspaceServices['updateSession']>[1] = {};
      if (patch.reasoningEffort !== undefined) changes.reasoningEffort = patch.reasoningEffort;
      if (patch.runLimits !== undefined) changes.runLimits = patch.runLimits;
      if (typeof patch.title === 'string') { changes.title = patch.title; changes.titleSource = 'manual'; }
      if (typeof patch.modelId === 'string') changes.modelId = patch.modelId;
      if (patch.pinned !== undefined) changes.pinned = patch.pinned;
      if (patch.archivedAt !== undefined) changes.archivedAt = patch.archivedAt;
      if (patch.rememberSelection !== undefined) changes.rememberSelection = patch.rememberSelection;
      if (patch.mode !== undefined) {
        if (!isAgentMode(patch.mode)) throw new Error('Неизвестный режим работы агента.');
        changes.mode = patch.mode;
      }
      let finish: (() => void) | undefined;
      if (configurationChange) sessionUpdates.set(id, new Promise<void>(resolve => { finish = resolve; }));
      try { if (configurationChange) await workspace.commands.stopSession(id); const result = await workspace.updateSession(id, changes); emit({ type: 'refresh' }); return result; }
      finally { if (configurationChange) { sessionUpdates.delete(id); finish?.(); } }
    },
    getMessages: id => workspace.getMessages(id),
    sendMessage: async (sessionId, text, attachmentIds) => {
      if (mcp.isTesting()) throw new Error('Дождитесь завершения проверки MCP перед запуском задачи.');
      if (sessionUpdates.has(sessionId)) throw new Error('Дождитесь сохранения модели и режима перед запуском задачи.');
      if (active.has(sessionId)) throw new Error('Этот разговор уже выполняется. Остановите задачу перед новым сообщением.');
      if (!text.trim() && !attachmentIds.length) throw new Error('Введите задачу или добавьте изображение.');
      active.add(sessionId);
      try {
        const session = await workspace.getSession(sessionId);
        if (session.archivedAt) throw new Error('Восстановите чат из архива перед отправкой сообщения.');
        if (shuttingDown) throw new Error('Приложение закрывается; новая задача не запущена.');
        workspace.files.clearReads(sessionId);
        const signal = coordinator.begin(sessionId);
        const running = runtime.run({ sessionId, text: text.trim(), attachmentIds }).then(() => coordinator.afterRun(sessionId, signal)).catch(() => {
          emit({ type: 'error', sessionId, error: 'Не удалось выполнить задачу. Проверьте настройки модели и повторите.' });
        }).finally(() => { coordinator.end(sessionId); active.delete(sessionId); work.delete(sessionId); });
        work.set(sessionId, running);
      } catch (error) { active.delete(sessionId); throw error; }
    },
    stopRun: async id => { coordinator.stop(id); broker.cancelSession(id); await runtime.stop(id); await workspace.commands.stopSession(id); },
    importImages: async paths => {
      if (!paths) {
        const result = await openDialog({ title: 'Добавить изображения', properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
        if (result.canceled) return [];
        paths = result.filePaths;
      }
      return workspace.importImages(paths);
    },
    pasteImages: async () => {
      const items = await clipboard.read();
      const imageItems = items.flatMap(item => {
        const type = item.types.find(type => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type));
        return type ? [{ item, type }] : [];
      });
      if (!imageItems.length) return [];
      const directory = path.join(dataDir, 'clipboard-import');
      await fs.mkdir(directory, { recursive: true });
      const files: string[] = [];
      try {
        for (const { item, type } of imageItems) {
          const blob = await item.getType(type) as Blob;
          if (blob.size > 25 * 1024 * 1024) throw new Error('Изображение из буфера обмена превышает 25 МБ.');
          const extension = type.split('/')[1];
          const file = path.join(directory, `Clipboard-${randomUUID()}.${extension}`);
          files.push(file);
          await fs.writeFile(file, Buffer.from(await blob.arrayBuffer()), { mode: 0o600 });
        }
        return await workspace.importImages(files);
      } finally { await Promise.all(files.map(file => fs.rm(file, { force: true }))); }
    },
    resolveAttachment: async id => {
      const image = await workspace.resolveImage(id);
      return `data:${image.mimeType};base64,${image.base64}`;
    },
    listFiles: (id, folder) => workspace.listFiles(id, folder),
    readFile: (id, file) => workspace.readFile(id, file),
    writeFile: async (id, file, content, version) => { const result = await workspace.writeFile(id, file, content, version); if (result.ok) emit({ type: 'changes', projectId: id }); return result; },
    getChanges: id => workspace.getChanges(id),
    revertChange: async (id, changeId) => { await workspace.revertChange(id, changeId); emit({ type: 'changes', projectId: id }); },
    getRules: id => workspace.getRules(id),
    saveRule: async (id, file, content, version) => {
      const result = await workspace.saveRule(id, file, content, version);
      emit({ type: 'refresh', projectId: id });
      return result;
    },
    listSkills: id => workspace.listSkills(id),
    createSkill: async input => { const result = await workspace.createSkill(input); emit({ type: 'refresh' }); return result; },
    saveSkill: async (id, content) => { const result = await workspace.saveSkill(id, content); emit({ type: 'refresh' }); return result; },
    installSkill: async (source, projectId) => {
      if (source.kind === 'folder' && !source.location) {
        const result = await openDialog({ title: 'Папка со SKILL.md', properties: ['openDirectory'] });
        if (result.canceled) return [];
        source = { ...source, location: result.filePaths[0] };
      }
      const result = await workspace.installSkill(source, projectId); emit({ type: 'refresh' }); return result;
    },
    setSkillEnabled: async (id, enabled) => { await workspace.setSkillEnabled(id, enabled); emit({ type: 'refresh' }); },
    removeSkill: async id => { await workspace.removeSkill(id); emit({ type: 'refresh' }); },
    readSkill: id => workspace.readSkill(id),
    exportSkill: async id => {
      const zip = await workspace.exportSkill(id);
      if (!zip) return undefined;
      try {
        const window = getWindow();
        const options = { title: 'Сохранить skill', defaultPath: path.basename(zip), filters: [{ name: 'ZIP', extensions: ['zip'] }] };
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return undefined;
        await fs.copyFile(zip, result.filePath); return result.filePath;
      } finally { await fs.rm(zip, { force: true }); }
    },
    saveModel: async (model, apiKey) => {
      if (active.size || probes.size) throw new Error('Остановите активные задачи и дождитесь проверки API перед изменением настроек моделей.');
      const { hasKey: _hasKey, ...configuration } = model;
      const result = await workspace.saveModel(configuration);
      if (apiKey?.trim()) await vault.save(model.id, apiKey.trim());
      emit({ type: 'refresh' }); return { ...result, hasKey: vault.hasModel(result, await workspace.listModels()) };
    },
    testModel: async id => {
      if (active.size || probes.size) throw new Error('Дождитесь завершения активных задач и проверок API.');
      const controller = new AbortController();
      let resolve!: () => void;
      const done = new Promise<void>(completed => { resolve = completed; });
      probes.set(id, { controller, done });
      try {
        const model = await workspace.getModel(id);
        return await testModelConnection(model, await vault.resolve(model, await workspace.listModels()), undefined, controller.signal);
      } finally { probes.delete(id); resolve(); }
    },
    deleteModel: async id => {
      if (active.size || probes.size) throw new Error('Остановите активные задачи и дождитесь проверки API перед удалением модели.');
      await workspace.deleteModel(id); await vault.remove(id); emit({ type: 'refresh' });
    },
    respondApproval: async (id, approved) => { broker.respond(id, approved); },
    getContext: async id => reports.get(id),
    getSettings: () => workspace.getSettings(),
    saveSettings: async settings => { if (active.size || probes.size) throw new Error('Дождитесь завершения активных задач перед изменением настроек.'); const result = await workspace.saveSettings(settings); emit({ type: 'refresh' }); return result; },
    listRuns: (projectId, sessionId) => workspace.listRuns(projectId, sessionId),
    continueRun: async (id, runId) => {
      if (shuttingDown || active.has(id) || sessionUpdates.has(id) || mcp.isTesting()) throw new Error('Дождитесь завершения активных операций этого чата.');
      active.add(id); const signal = coordinator.begin(id);
      try {
        const session = await workspace.getSession(id);
        if (session.archivedAt) throw new Error('Восстановите чат из архива перед продолжением.');
        const parent = runId ? await workspace.getRun(runId) : (await workspace.listRuns(session.projectId, id)).find(run => run.kind !== 'title');
        if (!parent || parent.sessionId !== id || !parent.canContinue) throw new Error('Этот запуск нельзя продолжить.');
        if (parent.engine === 'pi') throw new Error('Этот запуск использовал несовместимый движок. Отправьте новую задачу; журнал предыдущего запуска сохранён.');
        workspace.files.clearReads(id);
        const running = runtime.resume(id, parent.id).then(() => coordinator.afterRun(id, signal)).catch(() => emit({ type: 'error', sessionId: id, error: 'Не удалось продолжить задачу.' })).finally(() => { coordinator.end(id); active.delete(id); work.delete(id); });
        work.set(id, running);
      } catch (error) { coordinator.end(id); active.delete(id); throw error; }
    },
    verifyRun: async (id, runId) => {
      if (shuttingDown || active.has(id) || sessionUpdates.has(id) || mcp.isTesting()) throw new Error('Дождитесь завершения активных операций этого чата.');
      active.add(id); const signal = coordinator.begin(id);
      const verifying = (async () => { if ((await workspace.getSession(id)).archivedAt) throw new Error('Восстановите чат из архива перед запуском проверки.'); return coordinator.verify(id, runId, signal); })();
      work.set(id, verifying.then(() => undefined, () => undefined));
      try { return await verifying; } finally { coordinator.end(id); active.delete(id); work.delete(id); }
    },
    getGitStatus: id => workspace.getGitStatus(id), getGitDiff: (id, root, file, staged) => workspace.getGitDiff(id, root, file, staged),
    listCheckpoints: (id, sessionId) => workspace.listCheckpoints(id, sessionId),
    revertCheckpoint: async (id, checkpointId) => { if ((await workspace.listSessions(id)).some(session => active.has(session.id)) || (await workspace.listProcesses(id)).some(process => process.status === 'running')) throw new Error('Остановите задачи и процессы проекта перед откатом.'); await workspace.revertCheckpoint(id, checkpointId); emit({ type: 'changes', projectId: id }); },
    listProcesses: (id, sessionId) => workspace.listProcesses(id, sessionId), stopProcess: (id, processId) => workspace.stopProcess(id, processId),
    getProjectMap: id => workspace.getProjectMap(id), setContextPins: (id, pins) => workspace.setContextPins(id, pins), saveProjectMemory: (id, content) => workspace.saveProjectMemory(id, content),
  };
  ipcMain.handle('workbench:invoke', async (event, method: unknown, args: unknown) => {
    if (shuttingDown) throw new Error('Приложение закрывается.');
    const window = getWindow();
    if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Недопустимый источник запроса.');
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method) || !Array.isArray(args))
      throw new Error('Неизвестная операция.');
    const handler = handlers[method as keyof WorkbenchAPI] as (...arguments_: unknown[]) => Promise<unknown>;
    return handler(...args);
  });
  // A crash must not leave an apparently running session forever.
  for (const session of await workspace.listSessions())
    if (session.status === 'running' || session.status === 'approval') await workspace.updateSession(session.id, { status: 'stopped' });
  return {
    workspace,
    async stopAll() {
      shuttingDown = true;
      broker.cancelAll(); coordinator.stopAll();
      const pending = [...probes.values()];
      for (const probe of pending) probe.controller.abort();
      await Promise.all([...active].map(id => runtime.stop(id)).concat(pending.map(probe => probe.done)));
      await Promise.all([...sessionUpdates.values()]);
      await Promise.all([...work.values()]);
      await workspace.commands.close();
      await mcp.stop();
    },
  };
}
