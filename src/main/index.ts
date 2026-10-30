import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createBridge } from './bridge';
import { importOpenRouterEnvironment, openRouterImportSource } from './openrouter-import';

app.setName('Workbench');
if (process.env.WORKBENCH_DATA_DIR) {
  const directory = path.resolve(process.env.WORKBENCH_DATA_DIR);
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}
let window: BrowserWindow | undefined;
let bridge: Awaited<ReturnType<typeof createBridge>> | undefined;
let exiting = false;
if (!app.requestSingleInstanceLock()) {
  const importing = process.argv.includes('--import-openrouter-env');
  if (importing) console.error('Workbench: закройте запущенное приложение перед импортом ключа.');
  app.exit(importing ? 1 : 0);
}
app.on('second-instance', () => {
  if (exiting || !window) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
});

function createWindow() {
  window = new BrowserWindow({
    title: 'Workbench', width: 1460, height: 960, minWidth: 1060, minHeight: 700,
    backgroundColor: '#faf9f5',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const development = process.env.WORKBENCH_DEV_URL;
  if (development && development !== 'http://127.0.0.1:5173') throw new Error('Недопустимый адрес сервера разработки.');
  if (development) void window.loadURL(development);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  window.webContents.on('will-navigate', (event, target) => {
    const current = window?.webContents.getURL();
    if (target !== current) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) void shell.openExternal(url); }
    catch { /* refuse malformed links */ }
    return { action: 'deny' };
  });
  // The renderer only copies text; camera, microphone, notifications and other browser permissions stay denied.
  const allowed = (permission: string) => permission === 'clipboard-sanitized-write';
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
  window.webContents.session.setPermissionCheckHandler((_contents, permission) => allowed(permission));
  window.on('closed', () => { window = undefined; });
}

void app.whenReady().then(async () => {
  const dataDir = process.env.WORKBENCH_DATA_DIR || app.getPath('userData');
  const importSource = openRouterImportSource(process.argv);
  if (importSource) await importOpenRouterEnvironment(dataDir, importSource);
  bridge = await createBridge(dataDir, () => window, app.getVersion());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Workbench', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Вид', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Окно', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!exiting && !window) createWindow(); });
}).catch(() => {
  // Do not print configuration or credential-bearing error payloads.
  console.error('Workbench: не удалось запустить приложение. Проверьте доступ к каталогу данных.');
  app.exit(1);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (exiting || !bridge) return;
  event.preventDefault(); exiting = true;
  // Resume quitting on a new turn after macOS has completed the cancelled
  // native terminate action. Re-entering it from a microtask can leave no
  // windows but a still-running application.
  void bridge.stopAll().finally(() => setImmediate(() => app.quit()));
});
