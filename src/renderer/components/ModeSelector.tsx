import { BookOpen, Pencil, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { AgentMode } from '../../shared/modes';
import { ComposerSelect } from './ComposerSelect';

const modes: Record<AgentMode, { label: string; description: string; Icon: LucideIcon }> = {
  plan: { label: 'План', description: 'Чтение файлов и планирование. Команды, правки и MCP отключены.', Icon: BookOpen },
  'auto-edit': { label: 'Автопринятие правок', description: 'Правки без запросов; команды по настройкам проекта, MCP с подтверждением.', Icon: Pencil },
  ask: { label: 'Каждое действие', description: 'Каждый инструмент запускается после вашего подтверждения.', Icon: ShieldCheck },
  bypass: { label: 'Без подтверждений', description: 'Действия без запросов. Права папок, режим «только чтение» и настройки доступа в интернет сохраняются.', Icon: Zap },
};

export function ModeSelector({ mode, disabled, saving, onChange }: {
  mode: AgentMode; disabled: boolean; saving: boolean; onChange: (mode: AgentMode) => void;
}) {
  const Icon = modes[mode].Icon;
  return <ComposerSelect className={`mode-choice mode-${mode}`} testId="agent-mode"
    ariaLabel="Режим работы агента" describedBy="agent-mode-help" value={mode}
    options={Object.entries(modes).map(([value, item]) => ({ value, label: item.label, description: item.description }))}
    disabled={disabled} busy={saving} icon={<Icon size={13} aria-hidden="true" />}
    onChange={(value) => onChange(value as AgentMode)} />;
}

export function ModeHelp({ mode, saving }: { mode: AgentMode; saving: boolean }) {
  return <p className={`agent-mode-help agent-mode-help-${mode}`} id="agent-mode-help" data-testid="agent-mode-help" aria-live="polite">
    {saving ? 'Сохраняем режим работы…' : modes[mode].description}
  </p>;
}
