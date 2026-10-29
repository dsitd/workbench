import { build } from 'esbuild';

await build({
  entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', '@vscode/ripgrep'], sourcemap: true,
});
await build({
  entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'],
});
