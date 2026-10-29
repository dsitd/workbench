import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from './access';
import { redactCommandOutput } from './commands';
import type { CommandService } from './commands';
import type { FileService } from './files';
import type { ToolContext, ToolResult } from '../shared/types';

export interface CodeDiagnostic {
  file?: string; line?: number; column?: number;
  code: string; severity: 'error' | 'warning'; message: string;
}
export interface TypeScriptDiagnostics {
  status: 'passed' | 'diagnostics' | 'failed' | 'stopped';
  configPath: string; diagnostics: CodeDiagnostic[]; total: number; truncated: boolean;
  exitCode?: number; output?: string;
}

/** Quote as one shell argument without expanding $, backticks, or newlines. */
function shellArgument(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function boundedInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value as number;
}

export function parseTypeScriptDiagnostics(output: string, cwd: string): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  let current: CodeDiagnostic | undefined;
  for (const line of redactCommandOutput(output).split(/\r?\n/)) {
    const match = /^(?:(.+)\((\d+),(\d+)\):\s*)?(error|warning) (TS\d+):\s*(.*)$/.exec(line);
    if (match) {
      current = { code: match[5], severity: match[4] as 'error' | 'warning', message: match[6] };
      if (match[1]) { current.file = path.resolve(cwd, match[1]); current.line = Number(match[2]); current.column = Number(match[3]); }
      diagnostics.push(current);
    } else if (current && /^\s+\S/.test(line)) current.message += `\n${line}`;
    else current = undefined;
  }
  return diagnostics;
}

/** Uses only a project-installed compiler and the existing approved command sandbox. */
export class DiagnosticService {
  constructor(private files: Pick<FileService, 'resolvePath'>, private commands: Pick<CommandService, 'runDetailed'>) {}

  async typescript(context: ToolContext, arguments_: Record<string, unknown>): Promise<ToolResult> {
    const timeout = boundedInteger(arguments_.timeoutMs, 'timeoutMs', 60_000, 1000, 120_000);
    const limit = boundedInteger(arguments_.maxDiagnostics, 'maxDiagnostics', 100, 1, 200);
    if (arguments_.path !== undefined && typeof arguments_.path !== 'string') throw new Error('path must be a string.');
    const requested = await this.files.resolvePath(context.project, (arguments_.path as string | undefined) ?? context.project.folders[0].path);
    const info = await stat(requested);
    const config = info.isDirectory() ? await this.files.resolvePath(context.project, path.join(requested, 'tsconfig.json')) : requested;
    if (!config.endsWith('.json') || !(await stat(config)).isFile()) throw new Error('Choose a TypeScript .json configuration or a directory containing tsconfig.json.');
    const cwd = path.dirname(config);
    const compiler = await this.findCompiler(context, cwd);
    // Preserve composite/declaration constraints while keeping compiler output out of the project.
    // CommandService owns TMPDIR inside disposable sandbox scratch, never inherited from the user's environment.
    const command = `node ${shellArgument(compiler)} --project ${shellArgument(config)} --noEmit --incremental true --tsBuildInfoFile "$TMPDIR/typescript-diagnostics.tsbuildinfo" --pretty false`;
    const process = await this.commands.runDetailed(context, command, cwd, timeout);
    const diagnostics = parseTypeScriptDiagnostics(process.output, cwd);
    const outputTruncated = /\[Output truncated|\[Oversized output line omitted/.test(process.output);
    const status: TypeScriptDiagnostics['status'] = process.status === 'stopped' ? 'stopped'
      : process.status === 'completed' && !diagnostics.length && !outputTruncated ? 'passed'
      : diagnostics.length && (process.exitCode === 1 || process.exitCode === 2) && /^Exit [12]\r?\n/.test(process.output) ? 'diagnostics' : 'failed';
    const report: TypeScriptDiagnostics = {
      status, configPath: config, diagnostics: diagnostics.slice(0, limit), total: diagnostics.length,
      truncated: diagnostics.length > limit || outputTruncated, exitCode: process.exitCode,
    };
    if (status === 'failed' || status === 'stopped') report.output = redactCommandOutput(process.output).slice(0, 4000);
    return { text: JSON.stringify(report, null, 2), ...(status === 'failed' || status === 'stopped' ? { error: true } : {}) };
  }

  private async findCompiler(context: ToolContext, cwd: string): Promise<string> {
    let directory = cwd;
    while (context.project.folders.some(folder => isWithin(folder.path, directory))) {
      try {
        const compiler = await this.files.resolvePath(context.project, path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc'));
        if ((await stat(compiler)).isFile()) return compiler;
      } catch (error) {
        // Missing installations can fall back to an enclosing permitted workspace.
        // Escaping or protected symlinks must fail closed, even when another compiler exists.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
    throw new Error('A local TypeScript compiler was not found inside permitted project folders. Install TypeScript in the project before running diagnostics.');
  }
}
