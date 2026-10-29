import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Project, ProjectMap, ProjectMapFile } from '../shared/types';
import { FileService, readTextFile } from './files';
import { isWithin } from './access';
import { connectFiles, sourceFacts, type SourceFacts } from './code-graph';

const keyFiles = /^(?:README(?:\..*)?|AGENTS\.md|package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile|Dockerfile|requirements\.txt|vite\.config\..*)$/i;
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.rb', '.php', '.c', '.h', '.cpp', '.vue', '.svelte']);
function kind(file: string): string {
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|\.)|\.(?:test|spec)\./i.test(file)) return 'test';
  if (keyFiles.test(path.basename(file))) return 'key';
  if (/\.(?:md|mdx|rst|txt)$/i.test(file)) return 'documentation';
  if (sourceExtensions.has(path.extname(file))) return 'source';
  return 'other';
}
/** A bounded navigation index, not a language parser or exhaustive call graph. */
export function sourceSymbols(content: string): string[] {
  const result: string[] = [];
  const pattern = /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|declare|pub|open|internal|final)\s+)*(?:function\s*\*?|class|interface|type|enum|struct|trait|def|fn|fun|module|const|let|var|func(?:\s+\([^)]*\))?)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of content.matchAll(pattern)) {
    if (!result.includes(match[1])) result.push(match[1]);
    if (result.length >= 40) break;
  }
  return result;
}
export class ProjectIndexService {
  private symbols = new Map<string, { signature: string; facts: SourceFacts }>();
  constructor(private files: FileService, private readSource: typeof readTextFile = readTextFile) {}
  async build(project: Project, priorityPaths: readonly string[] = []): Promise<ProjectMap> {
    const scan = await this.files.walkDetailed(project, undefined, 5000);
    const priorities = new Set<string>();
    for (const hint of priorityPaths.slice(-24)) {
      try {
        const canonical = await this.files.resolvePath(project, hint);
        if ((await stat(canonical)).isFile()) { priorities.add(canonical); if (!scan.files.includes(canonical)) scan.files.push(canonical); }
      } catch { /* Hints grant no access; blocked or missing paths stay out of the index. */ }
    }
    const ordered = scan.files.sort((a, b) => Number(priorities.has(b)) - Number(priorities.has(a)) || Number(keyFiles.test(path.basename(b))) - Number(keyFiles.test(path.basename(a))) || a.localeCompare(b));
    const entries: ProjectMapFile[] = [];
    const facts = new Map<string, SourceFacts>();
    let contentBytes = 0;
    let truncated = scan.truncated || ordered.length > 1500;
    for (const file of ordered.slice(0, 1500)) {
      const root = project.folders.filter(folder => isWithin(folder.path, file)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!root) continue;
      const entry: ProjectMapFile = { path: file, relativePath: path.relative(root.path, file), kind: kind(file), symbols: [] };
      if (entry.kind === 'source' || entry.kind === 'test') {
        try {
          await this.files.resolvePath(project, file);
          const info = await stat(file), size = info.size;
          if (size > 128 * 1024 || contentBytes + size > 4 * 1024 * 1024) truncated = true;
          else {
            contentBytes += size;
            const signature = JSON.stringify([info.dev, info.ino, info.mode, size, info.mtimeMs, info.ctimeMs]);
            const cached = this.symbols.get(file);
            if (cached?.signature === signature) facts.set(file, cached.facts);
            else {
              const content = await this.readSource(file, 128 * 1024);
              const parsed = sourceFacts(file, content, sourceSymbols);
              facts.set(file, parsed); this.symbols.set(file, { signature, facts: parsed });
            }
            const parsed = facts.get(file)!;
            entry.symbols = [...parsed.symbols];
            if (parsed.signatures.length) entry.signatures = [...parsed.signatures];
          }
        } catch { /* Binary and inaccessible files retain only permitted metadata. */ }
      }
      entries.push(entry);
    }
    const allowed = new Set(entries.map(entry => entry.path));
    for (const file of this.symbols.keys()) if (!allowed.has(file)) this.symbols.delete(file);
    connectFiles(entries, facts);
    return { files: entries, truncated, scanned: scan.files.length, generatedAt: new Date().toISOString() };
  }
}
