import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';

export interface SearchOptions { regex?: boolean; ignoreCase?: boolean; glob?: string; signal?: AbortSignal }

/** rg never traverses the workspace: its input is a private, bounded snapshot of authorized text. */
export async function ripgrepSearch(files: string[], roots: string[], query: string, maximum: number, contextLines: number | undefined,
  options: SearchOptions, read: (file: string) => Promise<string>): Promise<string> {
  if (!query || query.length > 1000 || query.includes('\0')) throw new Error('Supply a nonempty query up to 1000 characters.');
  if (options.glob !== undefined && (typeof options.glob !== 'string' || options.glob.length > 1000 || options.glob.includes('\0'))) throw new Error('Invalid search glob.');
  if (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20)) throw new Error('contextLines must be 0–20.');
  const scratch = await mkdtemp(path.join(tmpdir(), 'workbench-search-'));
  const mapping = new Map<string, string>();
  let size = 0, scanLimited = false;
  try {
    for (const file of files) {
      options.signal?.throwIfAborted();
      let content: string;
      try { content = await read(file); } catch { continue; }
      size += Buffer.byteLength(content);
      if (size > 64 * 1024 * 1024) { scanLimited = true; break; }
      const rootIndex = roots.findIndex(root => file === root || file.startsWith(root + path.sep));
      if (rootIndex < 0) continue;
      const relative = path.relative(roots[rootIndex], file) || path.basename(file);
      const name = (roots.length === 1 ? relative : path.join(`root-${rootIndex}`, relative)).split(path.sep).join('/');
      const target = path.join(scratch, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
      mapping.set(name, file);
    }
    const args = ['--no-config', '--json', '--hidden', '--no-ignore', '--color=never', '--threads', '1', '--context', String(contextLines ?? 0)];
    if (options.regex !== true) args.push('--fixed-strings');
    if (options.ignoreCase !== false) args.push('--ignore-case');
    if (options.glob !== undefined) args.push('--glob', roots.length > 1 ? options.glob.replace(/^(!?)\//, '$1/root-*/') : options.glob);
    args.push('--', query, '.');
    const output = await new Promise<string>((resolve, reject) => {
      options.signal?.throwIfAborted();
      // Electron cannot execute binaries inside asar archives.
      const binary = rgPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
      const child = spawn(binary, args, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
      const lines: string[] = [];
      let pending = '', stderr = '', count = 0, chars = 0, limited = false, malformed = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
      const stop = () => { limited = true; child.kill(); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(0, 4000); });
      child.stdout.on('data', (data: string) => {
        if (limited || malformed) return;
        pending += data;
        for (;;) {
          const end = pending.indexOf('\n');
          if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'match' && entry.type !== 'context') continue;
            const hit = entry.type === 'match';
            if (hit && ++count > maximum) { stop(); break; }
            const name = (entry.data.path.text ?? Buffer.from(entry.data.path.bytes, 'base64').toString()).replace(/^\.\//, '');
            const source = mapping.get(name);
            if (!source) throw new Error('Unknown search snapshot.');
            const text: string = (entry.data.lines.text ?? Buffer.from(entry.data.lines.bytes, 'base64').toString()).replace(/\r?\n$/, '');
            const rendered = `${source}${hit ? ':' : '-'}${entry.data.line_number}${hit ? ':' : '-'} ${text.slice(0, 500)}${text.length > 500 ? ' [line truncated; use read_file]' : ''}`;
            if (chars + rendered.length > 120_000) { stop(); break; }
            lines.push(rendered); chars += rendered.length + 1;
          } catch { malformed = true; child.kill(); break; }
        }
        if (pending.length > 4 * 1024 * 1024) { malformed = true; child.kill(); }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (options.signal?.aborted) return reject(options.signal.reason ?? new Error('Search cancelled.'));
        if (timedOut) return reject(new Error('Search exceeded 30 seconds; narrow the query/path.'));
        if (malformed) return reject(new Error('Invalid or oversized ripgrep output.'));
        if (!limited && code !== 0 && code !== 1) return reject(new Error(`ripgrep failed: ${stderr.replaceAll(scratch, '[search snapshot]')}`));
        resolve((lines.join('\n') || 'No matching text found in permitted files.') + (limited ? '\n[Result/output limit reached; narrow query/path.]' : ''));
      });
    });
    return output + (scanLimited ? '\n[64 MiB search snapshot limit reached; narrow path. Results are incomplete.]' : '');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
