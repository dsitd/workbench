import type { WorkbenchAPI } from '../shared/types';

declare global { interface Window { workbench: WorkbenchAPI } }
export const api = window.workbench;
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() || path;
export const sizeLabel = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
export const statusLabels = { idle: 'Готов', running: 'Работает', approval: 'Нужно разрешение', completed: 'Готово', error: 'Ошибка', stopped: 'Остановлен' };
