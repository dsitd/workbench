import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { StateStore } from '../backend/storage';
import type { ModelConfig } from '../shared/types';

const argument = '--import-openrouter-env';
const modelId = 'openrouter-claude-sonnet-55';

export function validateOpenRouterImportTarget(model: ModelConfig | undefined): void {
  if (!model || model.id !== modelId || model.kind !== 'openai-compatible'
    || model.baseUrl.replace(/\/$/, '') !== 'https://openrouter.ai/api/v1' || model.model !== 'anthropic/claude-sonnet-5.5')
    throw new Error('Перед импортом сохраните штатный профиль Claude Sonnet 5.5 через OpenRouter.');
}

/** Only an explicit maintenance command imports a credential; normal startup never scans .env files. */
export function openRouterImportSource(argv: string[]): string | undefined {
  const indices = argv.flatMap((value, index) => value === argument ? [index] : []);
  if (indices.length === 0) return;
  const source = argv[indices[0] + 1];
  if (indices.length !== 1 || !source || !path.isAbsolute(source) || !path.basename(source).startsWith('.env'))
    throw new Error('Для импорта OpenRouter укажите один абсолютный путь к файлу .env.');
  return source;
}

export function parseOpenRouterCredential(text: string): string {
  const entries = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/);
    return match ? [match[1].trim()] : [];
  });
  if (entries.length !== 1) throw new Error('В файле должен быть ровно один OPENROUTER_API_KEY.');
  let value = entries[0];
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error('Некорректное значение OPENROUTER_API_KEY.');
    value = value.slice(1, end);
  } else value = value.replace(/#.*$/, '').trim();
  if (!value || value.length > 8192 || /[\s\x00-\x1f"'\\]/.test(value) || value.includes('${')
    || /^(?:your[_-]?.*|replace[_-]?.*|placeholder|changeme|example|\.{3})$/i.test(value))
    throw new Error('В OPENROUTER_API_KEY отсутствует действующий ключ.');
  return value;
}

/** Values stay in this process and encrypted storage. Never return them to the UI or logs. */
export async function importOpenRouterEnvironment(dataDir: string, source: string): Promise<void> {
  const state = await new StateStore(dataDir).read();
  validateOpenRouterImportTarget(state.models.find(model => model.id === modelId));
  let text: string;
  try {
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) throw new Error();
    text = await readFile(source, 'utf8');
  } catch { throw new Error('Не удалось прочитать выбранный файл для импорта OpenRouter.'); }
  const key = parseOpenRouterCredential(text);
  const { CredentialVault } = await import('./credentials');
  const vault = new CredentialVault(dataDir);
  await vault.initialize();
  await vault.save(modelId, key);
}
