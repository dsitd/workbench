import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import process from 'node:process';

const bundle = spawn(process.execPath, ['scripts/build-main.mjs'], { stdio: 'inherit' });
await new Promise((resolve, reject) => bundle.on('exit', code => code === 0 ? resolve() : reject(new Error('Main build failed'))));
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let desktop;
const stop = () => { desktop?.kill('SIGTERM'); vite.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch('http://127.0.0.1:5173'); if (response.ok) break; }
    catch { /* wait for local dev server */ }
    if (attempt === 99) throw new Error('Dev server did not start');
    await setTimeout(200);
  }
  const env = { ...process.env, WORKBENCH_DEV_URL: 'http://127.0.0.1:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn('node_modules/.bin/electron', ['.'], { stdio: 'inherit', env });
  await new Promise(resolve => desktop.on('exit', resolve));
} finally { stop(); }
