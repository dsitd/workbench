import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentEvent, WorkbenchAPI } from '../shared/types';

const methods = [
  'bootstrap', 'chooseFolders', 'createProject', 'saveProject', 'deleteProject',
  'listSessions', 'createSession', 'updateSession', 'getMessages', 'sendMessage', 'queueMessage', 'stopRun',
  'importImages', 'pasteImages', 'resolveAttachment', 'listFiles', 'readFile', 'writeFile', 'getChanges',
  'revertChange', 'getRules', 'saveRule', 'listSkills', 'createSkill', 'saveSkill', 'installSkill', 'setSkillEnabled',
  'removeSkill', 'readSkill', 'exportSkill', 'saveModel', 'testModel', 'deleteModel', 'respondApproval', 'getContext',
  'getSettings', 'saveSettings', 'listRuns', 'continueRun', 'verifyRun', 'getGitStatus', 'getGitDiff',
  'listCheckpoints', 'revertCheckpoint', 'listProcesses', 'stopProcess', 'getProjectMap', 'setContextPins', 'saveProjectMemory',
  'listMcpServers', 'saveMcpServer', 'deleteMcpServer', 'testMcpServer', 'getMcpStatus', 'disconnectMcpServer',
] as const;
const bridge: Record<string, unknown> = {};
for (const method of methods) bridge[method] = (...args: unknown[]) => ipcRenderer.invoke('workbench:invoke', method, args);
bridge.getFilePath = (file: File) => webUtils.getPathForFile(file);
bridge.onEvent = (listener: (event: AgentEvent) => void) => {
  const receive = (_event: Electron.IpcRendererEvent, event: AgentEvent) => listener(event);
  ipcRenderer.on('workbench:event', receive);
  return () => ipcRenderer.removeListener('workbench:event', receive);
};
contextBridge.exposeInMainWorld('workbench', bridge as unknown as WorkbenchAPI);
