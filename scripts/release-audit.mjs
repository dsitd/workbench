import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This tool records a completed local release; it never builds, runs acceptance,
// accesses credentials, scans profiles, signs, publishes, or calls a model.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const exactSources = new Set(['AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'assets/icon.icns', 'assets/icon.png', 'assets/icon.svg', 'docs/architecture.md', 'docs/linux.md', 'docs/context-caching.md',
  'docs/deepinfra.md', 'docs/harness-architecture.md', 'docs/mcp.md', 'docs/openrouter.md',
  'docs/diagrams/harness-components.mmd', 'docs/diagrams/harness-run.mmd']);
const sourceExtensions = { src: new Set(['.ts', '.tsx', '.css', '.html', '.svg']), scripts: new Set(['.mjs', '.ts']), tests: new Set(['.ts']) };
const requiredRuntimeSources = ['src/main/index.ts', 'src/main/bridge.ts', 'src/agent/index.ts', 'src/agent/context.ts',
  'src/agent/cache-policy.ts', 'src/agent/mappings.ts', 'src/agent/providers.ts', 'src/backend/project-context.ts'];
const acceptanceCommands = {
  desktop: 'node scripts/smoke.mjs', features: 'node scripts/features-smoke.mjs',
  chats: 'node scripts/chat-management-smoke.mjs', modelsCost: 'node scripts/models-cost-smoke.mjs',
  lifecycle: 'node scripts/lifecycle-smoke.mjs', sandbox: 'npm run sandbox:check',
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
class AuditError extends Error {}
const fail = message => { throw new AuditError(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const natural = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
const ownKeys = (value, keys, description) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Unexpected ${description} fields.`);
};

function cleanRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function publicSourcePath(value) {
  if (!cleanRelative(value) || value.split('/').some(part => part.startsWith('.') || /(?:^|\.)env(?:\.|$)/i.test(part)
    || /^(?:profiles?|secrets|vault)$/i.test(part))) return false;
  if (exactSources.has(value)) return true;
  const category = value.split('/')[0];
  return value.includes('/') && Boolean(sourceExtensions[category]?.has(path.posix.extname(value)));
}

async function checkedFile(base, relative) {
  if (!cleanRelative(relative)) fail('Invalid relative audit path.');
  let current = base;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('Audit paths must not traverse symbolic links.');
    if (index < relative.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('Audit input must be a regular file.');
  }
  return current;
}

async function hashFile(base, relative) {
  const file = await checkedFile(base, relative);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(), hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('Audit input changed while being hashed.');
    return { path: relative, bytes: before.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function readPublicJson(base, relative, maxBytes = 2_000_000) {
  const file = await checkedFile(base, relative);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > maxBytes) fail('Audit JSON exceeds its size limit.');
    try { return JSON.parse(await handle.readFile('utf8')); }
    catch { fail('Audit input contains invalid JSON.'); }
  } finally { await handle.close(); }
}

export async function collectPublicSources(base) {
  const names = [];
  for (const name of exactSources) {
    try { await checkedFile(base, name); names.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function walk(relative) {
    const directory = path.join(base, relative), stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Public source roots must be ordinary directories.');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Never enter hidden directories or inspect excluded file contents.
      if (entry.name.startsWith('.') || /^(?:profiles?|secrets|vault)$/i.test(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('Public source roots contain a symbolic link.');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && publicSourcePath(name)) names.push(name);
    }
  }
  for (const category of Object.keys(sourceExtensions)) await walk(category);
  const manifest = [];
  for (const name of names.sort()) {
    const entry = await hashFile(base, name);
    manifest.push({ path: entry.path, sha256: entry.sha256 });
  }
  return manifest;
}

export const sourceDigest = manifest => sha256(JSON.stringify(manifest));

export function validateEvidence(value, version) {
  ownKeys(value, ['version', 'sourceCanonicalSha256', 'canonicalCheck', 'packagedAcceptance', 'integrity'], 'release evidence');
  if (value.version !== version || !shaPattern.test(value.sourceCanonicalSha256 ?? '')) fail('Evidence version/source digest mismatch.');
  const check = value.canonicalCheck;
  ownKeys(check, ['command', 'exitCode', 'typecheck', 'build', 'unitTests'], 'canonical check');
  if (check.command !== 'npm run check' || check.exitCode !== 0 || check.typecheck !== true || check.build !== true) fail('A successful canonical check is required.');
  const tests = check.unitTests;
  ownKeys(tests, ['total', 'passed', 'failed', 'skipped', 'cancelled'], 'unit test');
  if (![tests.total, tests.passed, tests.failed, tests.skipped, tests.cancelled ?? 0].every(natural)
    || tests.total < 1 || tests.passed < 1 || tests.failed !== 0 || (tests.cancelled ?? 0) !== 0 || tests.total !== tests.passed + tests.skipped)
    fail('Unit test counts do not describe a successful completed run.');
  const acceptance = value.packagedAcceptance;
  ownKeys(acceptance, ['asarSha256', 'reports'], 'packaged acceptance');
  if (!shaPattern.test(acceptance.asarSha256 ?? '') || !Array.isArray(acceptance.reports) || acceptance.reports.length > 6) fail('Invalid packaged acceptance evidence.');
  const seen = new Set();
  for (const report of acceptance.reports) {
    ownKeys(report, ['name', 'command', 'exitCode', 'checks', 'paidRequests'], 'acceptance report');
    if (!Object.hasOwn(acceptanceCommands, report.name) || seen.has(report.name) || report.command !== acceptanceCommands[report.name]
      || report.exitCode !== 0 || !natural(report.checks) || report.checks < 1 || report.paidRequests !== 0) fail('Acceptance reports must contain successful unpaid checks only.');
    seen.add(report.name);
  }
  if (!['desktop', 'features', 'chats', 'modelsCost'].every(name => seen.has(name))) fail('The four packaged acceptance reports are required.');
  if (value.integrity !== undefined) {
    ownKeys(value.integrity, ['dmg', 'zip'], 'artifact integrity');
    for (const [name, command] of [['dmg', 'hdiutil verify'], ['zip', 'unzip -t']]) {
      if (value.integrity[name] === undefined) continue;
      ownKeys(value.integrity[name], ['command', 'exitCode'], 'integrity check');
      if (value.integrity[name].command !== command || value.integrity[name].exitCode !== 0) fail('Provided artifact integrity checks must have passed.');
    }
  }
  return structuredClone(value);
}

export function publicAsarPath(value) {
  if (!cleanRelative(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|id_rsa|.*\.(?:pem|key|p12|pfx)|\.git|\.cache|\.workbench|\.codex|\.agents|profile|profiles|vault|secrets|credentials\.json|state\.json|runs\.json|messages\.json|sessions\.json|models\.json|mcp\.json)$/i.test(part))) return false;
  return value === 'package.json' || parts[0] === 'dist' || parts[0] === 'node_modules';
}

export function validateArchiveEntries(entries) {
  for (const entry of entries) {
    if (!publicAsarPath(entry.path)) fail('ASAR contains a path outside the public runtime allowlist.');
    if (entry.link !== undefined) fail('ASAR contains a symbolic link.');
  }
}

async function auditAsar(base, version, manifest, expectedSha) {
  const relative = 'release/mac-arm64/Workbench.app/Contents/Resources/app.asar';
  const archive = await checkedFile(base, relative), initial = await hashFile(base, relative);
  if (initial.sha256 !== expectedSha) fail('The packaged acceptance ASAR differs from the audited ASAR.');
  const asar = await import('@electron/asar');
  const entries = asar.listPackage(archive).map(name => {
    const relative = name.replace(/^\//, '');
    if (!publicAsarPath(relative)) fail('ASAR contains a path outside the public runtime allowlist.');
    return { path: relative, ...asar.statFile(archive, relative, false) };
  });
  validateArchiveEntries(entries);
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json', false).toString('utf8'));
  if (packaged.version !== version || packaged.name !== 'local-code-workbench') fail('ASAR package metadata does not match the release.');
  const files = [];
  for (const entry of entries.filter(entry => !entry.files)) {
    let bytes;
    if (entry.unpacked) {
      const unpacked = await hashFile(base, `${relative}.unpacked/${entry.path}`);
      files.push({ path: entry.path, bytes: unpacked.bytes, sha256: unpacked.sha256, unpacked: true });
    } else {
      bytes = asar.extractFile(archive, entry.path, false);
      files.push({ path: entry.path, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  let distVerified = 0;
  for (const file of files.filter(file => file.path.startsWith('dist/'))) {
    const current = await hashFile(base, file.path);
    if (current.sha256 !== file.sha256) fail('Packaged runtime differs from the current canonical build.');
    distVerified++;
  }
  const sourceMap = JSON.parse(asar.extractFile(archive, 'dist/main/index.js.map', false).toString('utf8'));
  if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent)) fail('The packaged main source map is incomplete.');
  const sourceHashes = new Map(manifest.map(entry => [entry.path, entry.sha256])), matched = new Set();
  for (const [index, source] of sourceMap.sources.entries()) {
    if (typeof source !== 'string') fail('Invalid source map entry.');
    const name = path.posix.normalize(path.posix.join('dist/main', source));
    if (!name.startsWith('src/')) continue;
    if (!publicSourcePath(name) || typeof sourceMap.sourcesContent[index] !== 'string'
      || sourceHashes.get(name) !== sha256(sourceMap.sourcesContent[index])) fail('Packaged runtime source map differs from the public source manifest.');
    matched.add(name);
  }
  if (!requiredRuntimeSources.every(name => matched.has(name)) || distVerified === 0) fail('Required public runtime modules were not verified in ASAR.');
  const final = await hashFile(base, relative);
  if (final.sha256 !== initial.sha256) fail('ASAR changed during the audit.');
  return { summary: { path: relative, sha256: initial.sha256, version, containerEntries: entries.length, files: files.length,
    publicRuntimeModulesVerified: matched.size, distFilesVerified: distVerified, forbiddenProfileAndCredentialPaths: false,
    unsafeLinks: false, sourceMapMatchesManifest: true }, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function writeNew(base, relative, contents) {
  const directory = path.dirname(relative);
  const stat = await fs.lstat(path.join(base, directory));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Audit output directory must be an ordinary directory.');
  await fs.writeFile(path.join(base, relative), contents, { flag: 'wx', mode: 0o644 });
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--source-digest') options.digestOnly = true;
    else if (args[index] === '--version') options.version = args[++index];
    else if (args[index] === '--evidence') options.evidence = args[++index];
    else fail('Usage: release-audit.mjs --version X.Y.Z --source-digest | --evidence .cache/release-evidence-X.Y.Z.json');
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version ?? '')) fail('An explicit release version is required.');
  const version = options.version, packageJson = await readPublicJson(root, 'package.json');
  if (packageJson.version !== version) fail('The current package version does not match the requested release.');
  const manifest = await collectPublicSources(root), digest = sourceDigest(manifest);
  if (options.digestOnly) {
    if (options.evidence) fail('Source digest mode does not accept evidence.');
    console.log(JSON.stringify({ version, entries: manifest.length, sourceCanonicalSha256: digest })); return;
  }
  const evidencePath = `.cache/release-evidence-${version}.json`;
  if (options.evidence !== evidencePath) fail('Evidence must be the explicit versioned aggregate-facts JSON in .cache.');
  const evidence = validateEvidence(await readPublicJson(root, evidencePath), version);
  if (evidence.sourceCanonicalSha256 !== digest) fail('Public sources changed after the frozen canonical check snapshot.');
  const archive = await auditAsar(root, version, manifest, evidence.packagedAcceptance.asarSha256);
  const artifacts = [];
  for (const suffix of ['arm64.dmg', 'arm64-mac.zip', 'arm64.dmg.blockmap', 'arm64-mac.zip.blockmap']) {
    const name = `Workbench-${version}-${suffix}`;
    try { const file = await hashFile(root, `release/${name}`); artifacts.push({ name, bytes: file.bytes, sha256: file.sha256 }); }
    catch (error) { if (!suffix.endsWith('.blockmap') || error.code !== 'ENOENT') throw error; }
  }
  const sourceText = `${JSON.stringify(manifest, null, 2)}\n`, asarText = `${JSON.stringify(archive.files, null, 2)}\n`;
  const sourceFile = `source-manifest-${version}.json`, asarFile = `asar-manifest-${version}.json`;
  const validation = { version, verifiedAt: new Date().toISOString(), platform: 'macOS', architecture: 'arm64', artifacts,
    sourceManifest: { file: sourceFile, entries: manifest.length, fileSha256: sha256(sourceText), canonicalJsonSha256: digest },
    canonicalCheck: { ...evidence.canonicalCheck, evidence: 'Caller-provided completed command facts; public source snapshot digest verified',
      unitTests: { ...evidence.canonicalCheck.unitTests, cancelled: evidence.canonicalCheck.unitTests.cancelled ?? 0 } },
    packagedAcceptance: { ...evidence.packagedAcceptance, checks: evidence.packagedAcceptance.reports.reduce((sum, report) => sum + report.checks, 0),
      paidRequests: 0, evidence: 'Caller-provided completed packaged checks; exact ASAR SHA256 verified' },
    asarAudit: { ...archive.summary, manifest: { file: asarFile, entries: archive.files.length, fileSha256: sha256(asarText) } },
    integrity: evidence.integrity ?? { status: 'not supplied' },
    publication: { localArtifactsOnly: true, publishingPerformedByAudit: false, signingPerformedByAudit: false, notarizationPerformedByAudit: false } };
  // Validate every input before writing. The validation report is the final marker;
  // versioned proof is never silently overwritten by a later run.
  const outputs = [`release/${sourceFile}`, `release/${asarFile}`, `release/SHA256SUMS-${version}.txt`, `release/validation-${version}.json`];
  for (const output of outputs) {
    try { await fs.lstat(path.join(root, output)); fail('A versioned audit report already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sums = `${artifacts.map(artifact => `${artifact.sha256}  release/${artifact.name}`).join('\n')}\n`;
  await writeNew(root, outputs[0], sourceText); await writeNew(root, outputs[1], asarText); await writeNew(root, outputs[2], sums);
  await writeNew(root, outputs[3], `${JSON.stringify(validation, null, 2)}\n`);
  const temporary = path.join(root, `release/SHA256SUMS.tmp-${randomUUID()}`);
  await fs.writeFile(temporary, sums, { flag: 'wx', mode: 0o644 });
  await fs.rename(temporary, path.join(root, 'release/SHA256SUMS'));
  console.log(JSON.stringify({ version, sourceEntries: manifest.length, asarFiles: archive.files.length, reports: outputs, artifacts: artifacts.map(artifact => artifact.name) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof AuditError ? error.message : 'Release audit input could not be read or decoded. Check public paths and regular-file permissions.');
    process.exitCode = 1;
  });
}
