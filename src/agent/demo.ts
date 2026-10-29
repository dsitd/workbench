import { randomUUID } from 'node:crypto';
import type { ModelRequest, ModelResponse } from '../shared/agent';
import { checkAbort } from './errors';

/** Offline walkthrough deliberately performs only safe, read-only project exploration. */
export async function demoResponse(request: ModelRequest): Promise<ModelResponse> {
  checkAbort(request.signal);
  const userIndex = request.messages.map(message => message.role).lastIndexOf('user');
  const turn = request.messages.slice(userIndex + 1);
  const results = turn.filter(message => message.role === 'tool');
  let content: string;
  const tool = (name: string, arguments_: Record<string, unknown>, text: string): ModelResponse => {
    request.onDelta?.(text);
    return { content: text, toolCalls: [{ id: randomUUID(), name, arguments: arguments_ }] };
  };
  if (!results.length && request.tools.some(definition => definition.name === 'list_files'))
    return tool('list_files', {}, 'Демо-режим · без модели и API. Покажу работу локальных инструментов: сначала посмотрю файлы проекта.\n');
  if (results.length >= 1 && results.length <= 2 && results.at(-1)?.toolName === 'list_files') {
    let entries: unknown;
    try { entries = JSON.parse(results.at(-1)!.content); } catch { /* Human-readable output also supported. */ }
    const files = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? (entries as Record<string, unknown>).entries : undefined;
    const readme = Array.isArray(files) ? files.find(file => file && typeof file === 'object' && /^readme\.(md|txt)$/i.test(String(file.name))) : undefined;
    if (readme?.path && request.tools.some(definition => definition.name === 'read_file')) return tool('read_file', { path: readme.path }, 'Найден README. Прочитаю его и покажу результат в истории инструментов.\n');
    const firstDirectory = Array.isArray(files) ? files.find(file => file?.kind === 'directory' && file.path) : undefined;
    if (firstDirectory && results.length === 1) return tool('list_files', { path: firstDirectory.path }, 'Открою первый разрешённый каталог проекта и покажу его файлы.\n');
  }
  content = 'Демо-режим · это локальный сценарий, а не ответ языковой модели.\n\n';
  if (results.length) content += 'Инструменты выполнили чтение выбранного проекта. Их реальные результаты доступны выше. История, контекст и события этого запуска сохранены.\n\n';
  content += 'Для выполнения своей задачи добавьте модель и API-ключ в настройках, затем создайте или продолжите чат с этой моделью. Демо не выполняет редактирование, команды и интернет-запросы.';
  for (const delta of content.match(/.{1,90}(?:\n|$)?/gs) ?? [content]) { checkAbort(request.signal); request.onDelta?.(delta); }
  return { content, toolCalls: [] };
}
