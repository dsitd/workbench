import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ContextPin, Project, ProjectMap } from '../shared/types';
import type { FileService } from './files';
import type { ProjectIndexService } from './project-index';
import { rankConnectedFiles } from './code-graph';

export function checkedPins(pins: ContextPin[]): ContextPin[] {
  if (!Array.isArray(pins) || pins.length > 32) throw new Error('Можно закрепить до 32 файлов или фрагментов.');
  return pins.map(pin => {
    if (!pin || typeof pin.path !== 'string' || !pin.path.trim() || pin.path.length > 2000) throw new Error('Некорректный путь закреплённого файла.');
    const start = pin.startLine, end = pin.endLine;
    if ((start !== undefined && (!Number.isInteger(start) || start < 1)) || (end !== undefined && (!Number.isInteger(end) || end < (start ?? 1)))) throw new Error('Некорректные строки фрагмента.');
    return { id: /^[a-zA-Z0-9_-]{1,100}$/.test(pin.id ?? '') ? pin.id : randomUUID(), path: pin.path, startLine: start, endLine: end };
  });
}
export function mentionedFiles(query: string): ContextPin[] {
  const results: ContextPin[] = [];
  const pattern = /@file:(?:"([^"]+)"|([^\s]+))|@file\((?:"([^"]+)"|'([^']+)'|([^)]{1,2000}))\)/g;
  for (const match of query.matchAll(pattern)) {
    const reference = (match[1] || match[2] || match[3] || match[4] || match[5]).trim();
    const fragment = reference.match(/^(.*?)(?:#L?(\d+)(?:-L?(\d+))?)?$/)!;
    results.push({ id: randomUUID(), path: fragment[1], startLine: fragment[2] ? Number(fragment[2]) : undefined, endLine: fragment[3] ? Number(fragment[3]) : fragment[2] ? Number(fragment[2]) : undefined });
    if (results.length === 16) break;
  }
  return results;
}
export async function projectContext(files: FileService, index: ProjectIndexService, project: Project, query: string, signal: AbortSignal, sessionId?: string, navigationPaths: readonly string[] = []): Promise<{ pins: { source: string; content: string }[]; map?: ProjectMap }> {
  const pins: { source: string; content: string }[] = [];
  const selected = [...(project.pins ?? []), ...mentionedFiles(query)];
  const seen = new Set<string>();
  for (const pin of selected) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const file = await files.read(project, pin.path, sessionId);
    const lines = (file.content ?? '').split('\n');
    const start = pin.startLine ?? 1, end = Math.min(pin.endLine ?? start + 299, lines.length);
    if (start > lines.length) throw new Error('Фрагмент начинается за пределами файла.');
    const key = JSON.stringify([file.path, start, end]);
    if (seen.has(key)) continue; seen.add(key);
    const content = lines.slice(start - 1, end).join('\n');
    pins.push({ source: `${file.path}:${start}-${end} [${file.version}]`, content: content.slice(0, 18_000) + (content.length > 18_000 ? '\n[Фрагмент сокращён; прочитайте нужные строки инструментом.]' : '') });
  }
  const hints = [...selected.map(pin => pin.path), ...navigationPaths].slice(-32);
  const map = await index.build(project, hints);
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  const hintPaths = hints.flatMap(hint => path.isAbsolute(hint) ? [path.resolve(hint)] : project.folders.map(folder => path.resolve(folder.path, hint)));
  const roots = new Set(project.folders.map(folder => path.resolve(folder.path)));
  const overview = /структур|архитект|structure|architecture|project overview|entry.?point/i.test(query);
  const scores = new Map(map.files.map(file => [file.path, (hintPaths.some(hint => hint === file.path) ? 50 : hintPaths.some(hint => !roots.has(hint) && file.path.startsWith(hint + path.sep)) ? 8 : 0)
    + (overview && file.kind === 'key' ? 3 : 0)
    + [...words].reduce((sum, word) => sum + (file.relativePath.toLowerCase().includes(word) ? 3 : file.symbols.some(symbol => symbol.toLowerCase().includes(word)) ? 1 : 0), 0)]));
  const ranked = rankConnectedFiles(map.files, scores);
  return { pins, map: { ...map, files: ranked, truncated: map.truncated || ranked.length < map.files.length } };
}
