import path from 'node:path';
import ts from 'typescript';
import type { ProjectMapFile } from '../shared/types';

export interface SourceFacts { symbols: string[]; signatures: string[]; imports: string[]; references: Record<string, number> }
/** Parse permitted source text only; no compiler host, module loading, config, or filesystem reads. */
export function sourceFacts(file: string, content: string, fallback: (content: string) => string[]): SourceFacts {
  const facts: SourceFacts = { symbols: [], signatures: [], imports: [], references: {} };
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return { ...facts, symbols: fallback(content) };
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/i.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const typeName = (node?: ts.TypeNode): string => {
    if (!node) return '';
    let literal = false;
    const inspect = (item: ts.Node) => { if (ts.isLiteralTypeNode(item)) literal = true; ts.forEachChild(item, inspect); }; inspect(node);
    return literal ? 'literal' : node.getText(source).replace(/\s+/g, ' ').slice(0, 120);
  };
  const add = (name: string, signature: string) => {
    if (!facts.symbols.includes(name) && facts.symbols.length < 40) facts.symbols.push(name);
    if (facts.signatures.length < 24) facts.signatures.push(signature.slice(0, 280));
  };
  const parameters = (node: ts.SignatureDeclaration) => node.parameters.map(parameter => `${parameter.dotDotDotToken ? '...' : ''}${ts.isIdentifier(parameter.name) ? parameter.name.text : 'destructured'}${parameter.questionToken ? '?' : ''}${parameter.type ? ': ' + typeName(parameter.type) : ''}`).join(', ');
  const functionSignature = (name: string, node: ts.SignatureDeclaration) => `${name}(${parameters(node)})${node.type ? ': ' + typeName(node.type) : ''}`;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) facts.references[node.text] = (facts.references[node.text] ?? 0) + 1;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && facts.imports.length < 64) facts.imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && facts.imports.length < 64) facts.imports.push(node.arguments[0].text);
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, `function ${functionSignature(node.name.text, node)}`);
    } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      add(node.name.text, `${ts.isClassDeclaration(node) ? 'class' : ts.isInterfaceDeclaration(node) ? 'interface' : ts.isEnumDeclaration(node) ? 'enum' : 'type'} ${node.name.text}`);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? functionSignature(node.name.text, node.initializer) : `${node.name.text}${node.type ? ': ' + typeName(node.type) : ''}`);
    } else if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && ts.isIdentifier(node.name)) {
      const owner = (ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent)) ? node.parent.name?.text : undefined;
      add(node.name.text, functionSignature(owner ? `${owner}.${node.name.text}` : node.name.text, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  facts.imports = [...new Set(facts.imports)];
  return facts;
}

/** Resolve imports only against already permitted map entries; hints never expand authority. */
export function connectFiles(files: ProjectMapFile[], facts: Map<string, SourceFacts>): void {
  const allowed = new Set(files.map(file => file.path));
  for (const file of files) {
    const imports = facts.get(file.path)?.imports ?? [];
    const dependencies = new Set<string>();
    for (const specifier of imports.filter(value => value.startsWith('.'))) {
      const base = path.resolve(path.dirname(file.path), specifier);
      const stem = base.replace(/\.[cm]?jsx?$/, '');
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(extension => stem + extension), ...['index.ts', 'index.tsx', 'index.js'].map(name => path.join(base, name))];
      const resolved = candidates.find(candidate => allowed.has(candidate));
      if (resolved && resolved !== file.path) dependencies.add(resolved);
    }
    if (dependencies.size) file.dependencies = [...dependencies].slice(0, 32).sort();
  }
}

export function rankConnectedFiles(files: ProjectMapFile[], seedScores: Map<string, number>, byteBudget = 9000): ProjectMapFile[] {
  const scores = new Map(seedScores);
  for (const file of files) {
    const seed = seedScores.get(file.path) ?? 0;
    if (seed > 0) for (const dependency of file.dependencies ?? []) scores.set(dependency, (scores.get(dependency) ?? 0) + seed * 0.4);
    for (const dependency of file.dependencies ?? []) if ((seedScores.get(dependency) ?? 0) > 0) scores.set(file.path, (scores.get(file.path) ?? 0) + seedScores.get(dependency)! * 0.2);
  }
  const selected: ProjectMapFile[] = [];
  let bytes = 0;
  for (const file of [...files].filter(file => (scores.get(file.path) ?? 0) > 0).sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || a.path.localeCompare(b.path)).slice(0, 18)) {
    const entry = { ...file, symbols: file.symbols.slice(0, 8), ...(file.signatures ? { signatures: file.signatures.slice(0, 6) } : {}) };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > byteBudget) continue;
    selected.push(entry); bytes += size;
  }
  return selected;
}
