import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Render our vector in an empty native Electron surface, without opening browser profiles.
const assets = path.resolve('assets');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-icon-'));
const fixture = path.join(temporary, 'icon-host.cjs');
await fs.writeFile(fixture, `
const { app, BrowserWindow } = require('electron');
app.setName('Workbench Icon Renderer');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html><body></body></html>');
});
`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ args: [fixture], env: environment, timeout: 30_000 });
  const page = await desktop.firstWindow();
  const svg = await fs.readFile(path.join(assets, 'icon.svg'), 'utf8');
  const data = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(source)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png').split(',')[1];
  }, svg);
  await fs.writeFile(path.join(assets, 'icon.png'), Buffer.from(data, 'base64'));
  const iconset = path.join(temporary, 'Workbench.iconset');
  await fs.mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const output = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      execFileSync('/usr/bin/sips', ['-z', String(pixels), String(pixels), path.join(assets, 'icon.png'), '--out', output], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], { stdio: 'ignore' });
  console.log('Created assets/icon.svg, assets/icon.png (1024×1024), and assets/icon.icns.');
} finally {
  if (desktop) await desktop.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
