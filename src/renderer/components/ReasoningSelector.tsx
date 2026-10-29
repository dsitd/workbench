import { BrainCircuit } from 'lucide-react';
import { ComposerSelect } from './ComposerSelect';

export interface ReasoningOption { value: string; label: string; disabled?: boolean }

export function ReasoningSelector({ value, options, disabled, saving, onChange }: {
  value: string; options: readonly ReasoningOption[]; disabled: boolean; saving: boolean;
  onChange: (value: string) => void;
}) {
  return <ComposerSelect className="reasoning-choice" testId="agent-reasoning" ariaLabel="Уровень рассуждения"
    value={value} options={options} disabled={disabled} busy={saving}
    icon={<BrainCircuit size={13} aria-hidden="true" />} onChange={onChange} />;
}
