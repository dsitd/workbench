import { useState } from 'react';
import { Check, ChevronRight, LoaderCircle, Terminal, X } from 'lucide-react';
import type { ChatMessage, RunRecord, RunStep, ToolCall } from '../../shared/types';
import { activityCounts } from '../conversation-activity';
import { AttachmentImage, Markdown } from './Common';
import { runStatusLabel } from './RunSummary';

const plural = (value: number, forms: [string, string, string]) => {
  const last = value % 10, hundreds = value % 100;
  return `${value.toLocaleString('ru')} ${forms[hundreds >= 11 && hundreds <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2]}`;
};

/** One disclosure contains only public activity text, tool arguments and tool results. */
export function ActivityDisclosure({ messages, active, activeLabel, run }: { messages: ChatMessage[]; active: boolean; activeLabel?: string; run?: RunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const counts = activityCounts(messages);
  const toolResults = new Map(messages.filter(message => message.role === 'tool' && message.toolCallId).map(message => [message.toolCallId!, message]));
  const callIds = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
  const stepsMessages = messages.filter(message => message.role === 'assistant' || message.role === 'tool' && (!message.toolCallId || !callIds.has(message.toolCallId)));
  const modelSteps = run?.stepLog.filter(step => step.kind !== 'explore' && step.kind !== 'compaction' && step.kind !== 'counterexample' && step.kind !== 'action-review') ?? [];
  const indexed = modelSteps.some(step => step.assistantMessageId);
  const byMessage = new Map(modelSteps.filter(step => step.assistantMessageId).map(step => [step.assistantMessageId!, step]));
  const matched = new Set<number>();
  let assistantIndex = 0, legacyIndex = 0;
  const publicSteps = stepsMessages.map(message => {
    const verification = message.runtimeKind === 'verification';
    const ordinal = message.role === 'assistant' && !verification ? ++assistantIndex : undefined;
    let step = message.role === 'assistant' ? byMessage.get(message.id) : undefined;
    if (!step && ordinal && !indexed) step = modelSteps[legacyIndex++];
    if (step && matched.has(step.index)) step = undefined;
    if (step) matched.add(step.index);
    return { kind: 'public' as const, message, verification, ordinal: !run || !indexed ? ordinal : step?.index, step };
  });
  const journalOnlySteps = run?.stepLog.filter(step => !matched.has(step.index)).sort((a, b) => a.index - b.index) ?? [];
  type Entry = typeof publicSteps[number] | { kind: 'journal'; step: RunStep };
  const entries: Entry[] = [], remaining = [...journalOnlySteps];
  for (const entry of publicSteps) {
    // Child requests appear between the parent requests that surround them.
    // A synthetic verification has no request step; timestamps place any final
    // request metadata before that separate action without assigning it twice.
    while (remaining.length && (entry.step ? remaining[0].index < entry.step.index : entry.verification && Date.parse(remaining[0].startedAt) <= Date.parse(entry.message.createdAt))) entries.push({ kind: 'journal', step: remaining.shift()! });
    entries.push(entry);
  }
  entries.push(...remaining.map(step => ({ kind: 'journal' as const, step })));
  const steps = Math.max(assistantIndex, run?.steps ?? 0);
  if (!messages.length && !active && !entries.length) return null;
  const state = active ? activeLabel || 'Работает над задачей…' : counts.errors ? 'Есть ошибки инструментов' : run ? runStatusLabel[run.status] : 'Действия завершены';
  return <details className={`activity-disclosure ${active ? 'activity-active' : ''}`} data-testid="activity-disclosure" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary data-testid="activity-toggle"><ChevronRight className="activity-chevron" size={13} aria-hidden="true" />{active ? <LoaderCircle className="spin activity-status-icon" size={13} aria-hidden="true" /> : <Terminal className="activity-status-icon" size={13} aria-hidden="true" />}<span className="activity-title">{active ? state : 'Ход работы'}</span><span className="activity-count">{[steps ? plural(steps, ['шаг', 'шага', 'шагов']) : '', counts.tools ? plural(counts.tools, ['инструмент', 'инструмента', 'инструментов']) : ''].filter(Boolean).join(' · ')}</span>{!active && <span className={`activity-state ${counts.errors ? 'activity-has-error' : ''}`}>{state}</span>}</summary>
    <div className="activity-content">{entries.map(entry => {
      if (entry.kind === 'public') {
        const { message, ordinal, step, verification } = entry;
        return <section className="activity-step" key={message.id} data-testid={ordinal ? 'activity-step' : undefined} data-step-index={step?.index ?? ordinal}><div className="activity-step-heading">{verification ? 'Проверка проекта' : ordinal ? `Шаг ${step?.index ?? ordinal}` : message.role === 'assistant' ? 'Сообщение агента' : 'Результат инструмента'}</div>{step && <StepMetadata step={step} run={run!} active={active && step === run?.stepLog.at(-1)} />}{message.role === 'assistant' ? <>{message.content && <Markdown text={message.content} />}{message.attachmentIds?.length ? <div className="message-attachments">{message.attachmentIds.map(id => <AttachmentImage key={id} id={id} />)}</div> : null}{message.toolCalls?.map(call => <ActivityTool key={call.id} call={call} result={toolResults.get(call.id)} active={active} />)}</> : <ActivityTool result={message} active={active} />}</section>;
      }
      const { step } = entry;
      const finalAnswer = step.kind !== 'explore' && step.kind !== 'compaction' && step.kind !== 'counterexample' && step.kind !== 'action-review' && !active && run?.status === 'completed' && !step.toolNames.length && step === modelSteps.at(-1);
      return <section className="activity-step" data-testid="activity-step" data-step-index={step.index} key={`journal-step-${step.index}`}><div data-testid={finalAnswer ? 'activity-final-step' : undefined}><div className="activity-step-heading">Шаг {step.index} · {step.kind === 'compaction' ? 'Суммаризация истории' : step.kind === 'action-review' ? 'Проверка действия' : step.kind === 'counterexample' ? 'Поиск контрпримеров' : step.kind === 'explore' ? 'Исследование кода' : finalAnswer ? 'Итоговый ответ' : step.errors.length ? 'Ошибка запроса' : step.toolNames.length ? 'Инструменты' : 'Запрос модели'}</div><StepMetadata step={step} run={run!} active={active && step === run?.stepLog.at(-1)} />{step.toolNames.length ? <p className="activity-journal-tools">{step.toolNames.join(' · ')}</p> : null}</div></section>;
    })}{!entries.length && <p className="activity-waiting">{activeLabel || 'Подготавливает следующий шаг…'}</p>}</div>
  </details>;
}

function StepMetadata({ step, run, active }: { step: RunStep; run: RunRecord; active: boolean }) {
  const finishLabels: Record<string, string> = { stop: 'Ответ завершён', end_turn: 'Ответ завершён', tool_calls: 'Вызов инструментов', tool_use: 'Вызов инструментов', length: 'Ответ обрезан', max_tokens: 'Ответ обрезан', content_filter: 'Ответ ограничен' };
  const status = step.errors.length ? 'Есть ошибки' : step.finishReason ? finishLabels[step.finishReason] ?? step.finishReason : active ? 'Выполняется' : runStatusLabel[run.status];
  const cost = step.costUsd;
  const validCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
  return <><div className="activity-step-metadata" data-testid="activity-step-metadata"><span>{active && !step.durationMs ? 'Время: выполняется' : `${(step.durationMs / 1000).toLocaleString('ru', { maximumFractionDigits: 1 })} с`}</span><span>Вход {step.inputTokens.toLocaleString('ru')} · выход {step.outputTokens.toLocaleString('ru')}</span>{validCost && <span title={run.usage.costSource === 'api' ? 'Стоимость по данным API' : 'Стоимость из журнала запуска'}>{run.usage.costSource === 'estimated' || run.usage.costSource === 'mixed' ? '≈ ' : ''}${cost.toFixed(cost > 0 && cost < 0.0001 ? 6 : 4)}</span>}<span className={step.errors.length ? 'activity-has-error' : ''} title={step.finishReason}>{status}</span>{step.retries > 0 && <span>Повторов: {step.retries}</span>}</div>{step.errors.length > 0 && <p className="activity-step-errors">{step.errors.join(' · ')}</p>}</>;
}

function ActivityTool({ call, result, active }: { call?: ToolCall; result?: ChatMessage; active: boolean }) {
  return <div className={`activity-tool ${result?.error ? 'activity-tool-error' : ''}`} data-testid="activity-tool"><div className="activity-tool-heading"><span className="activity-tool-icon">{result ? result.error ? <X size={12} /> : <Check size={12} /> : active ? <LoaderCircle className="spin" size={12} /> : <Terminal size={12} />}</span><strong>{call?.name || result?.toolName || 'Инструмент'}</strong><span>{result ? result.error ? 'Ошибка' : 'Выполнено' : active ? 'Выполняется' : 'Результат не получен'}</span></div>{call && <pre className="activity-arguments" aria-label="Аргументы инструмента">{JSON.stringify(call.arguments, null, 2)}</pre>}{result && <><pre className="activity-result" data-testid="activity-result">{result.content}</pre>{result.attachmentIds?.length ? <div className="message-attachments">{result.attachmentIds.map(id => <AttachmentImage key={id} id={id} />)}</div> : null}</>}</div>;
}
