import type { ChatMessage, RunRecord, ToolCall, ToolDefinition, ToolResult } from '../shared/types';
import type { TaskCriterion, ToolObservation } from '../shared/task-evidence';
import { AgentError } from './errors';
import { recordTaskMemory, taskMemoryTool } from './task-memory';
import { nonEvidenceTools as claims } from '../shared/evidence-policy';
import { behaviorCheckState } from './behavior-verification';
import { counterexampleState } from './counterexamples';

const text = { type: 'string', minLength: 3, maxLength: 1000 };
const id = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const taskTools: ToolDefinition[] = [
  { name: 'set_task_criteria', permission: 'read', description: 'Register explicit acceptance checks beyond ordinary project verification, quoting exact user text. Existing criteria cannot be removed or rewritten. Both toolName and expectedText are required before a criterion can be satisfied; matching fresh observations attach evidence automatically. Tests prove only their scope; avoid redundant criteria for small edits.', parameters: schema({ criteria: { type: 'array', minItems: 1, maxItems: 32, items: schema({ id, text, sourceQuote: text, toolName: { type: 'string', minLength: 1, maxLength: 64 }, expectedText: { type: 'string', minLength: 1, maxLength: 1000 } }, ['id', 'text', 'sourceQuote']) } }, ['criteria']) },
  { name: 'record_task_evidence', permission: 'read', description: 'Attach an existing fresh observation to one criterionId or several criterionIds in one call. Copy toolCallId from task-state availableObservations; do not invent IDs or reread unchanged files just to obtain evidence. Every criterion must have toolName and expectedText bindings and match; batch updates are atomic. Claims and archives cannot prove completion.', parameters: schema({ criterionId: id, criterionIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: id }, toolCallId: { type: 'string', minLength: 1, maxLength: 256 } }, ['toolCallId']) },
  taskMemoryTool,
];
export const completionTool: ToolDefinition = { name: 'check_completion', permission: 'read', description: 'Runtime checks acceptance evidence and uncertain operations before completion.', parameters: schema({}, []) };
export const taskDiscoveryTool: ToolDefinition = { name: 'load_task_tools', permission: 'read', description: 'Load acceptance-check and sourced-note tools for the next request. Metadata only.', parameters: schema({ names: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: taskTools.map(tool => tool.name) } } }, ['names']) };

/** Explicit headings seed a canonical contract independently of bounded context excerpts. */
export function initialCriteria(user: ChatMessage): TaskCriterion[] {
  const criteria: TaskCriterion[] = []; let active = false;
  for (const line of user.content.split('\n')) {
    const trimmed = line.trim();
    if (/^(?:#{1,6}\s*)?(?:acceptance criteria|definition of done|completion criteria|критерии (?:при[её]мки|готовности|завершения)|ожидаемый результат)\s*:\s*$/i.test(trimmed)) { active = true; continue; }
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) { active = false; continue; }
    if (active) {
      if (trimmed.length > 1000 || criteria.length >= 32) throw new AgentError('Явные критерии завершения превышают лимит контракта задачи. Разбейте задачу на этапы.');
      criteria.push({ id: `criterion_${criteria.length + 1}`, text: trimmed, sourceQuote: trimmed, sourceMessageId: user.id });
    }
  }
  return criteria;
}

export function executeTaskTool(call: ToolCall, run: RunRecord, history: ChatMessage[]): ToolResult {
  const source = history.find(message => message.id === run.checkpoint?.userMessageId && message.role === 'user');
  if (!source) throw new AgentError('Исходная задача отсутствует. Контракт завершения не изменён.');
  if (call.name === 'set_task_criteria') {
    const additions = call.arguments.criteria as Omit<TaskCriterion, 'sourceMessageId' | 'evidence'>[];
    const next = structuredClone(run.acceptanceCriteria ?? []);
    for (const criterion of additions) {
      if (!source.content.includes(criterion.sourceQuote)) throw new AgentError('Критерий должен ссылаться на точную цитату исходной задачи.');
      if (criterion.toolName && claims.has(criterion.toolName)) throw new AgentError('toolName должен указывать на наблюдение состояния; служебные ответы и заявления не доказывают критерий.');
      const existing = next.find(item => item.id === criterion.id);
      if (existing) {
        if (existing.text !== criterion.text || existing.sourceQuote !== criterion.sourceQuote
          || existing.toolName && existing.toolName !== criterion.toolName || existing.expectedText && existing.expectedText !== criterion.expectedText)
          throw new AgentError('Принятый критерий нельзя переписать или ослабить. Добавьте отдельный критерий.');
        if (criterion.toolName && !existing.toolName || criterion.expectedText && !existing.expectedText) {
          existing.toolName ??= criterion.toolName; existing.expectedText ??= criterion.expectedText; delete existing.evidence;
        }
      } else next.push({ ...criterion, sourceMessageId: source.id });
    }
    if (next.length > 32) throw new AgentError('Можно зарегистрировать до 32 критериев задачи.');
    run.acceptanceCriteria = next;
    return { text: JSON.stringify({ criteria: next, note: 'Registered checks are a task contract. Each criterion still needs matching, fresh observed evidence.' }) };
  }
  if (call.name === 'record_task_evidence') {
    const ids = call.arguments.criterionId !== undefined ? [call.arguments.criterionId] : call.arguments.criterionIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 32 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length
      || call.arguments.criterionId !== undefined && call.arguments.criterionIds !== undefined) throw new AgentError('Укажите один criterionId или список criterionIds и существующий toolCallId из availableObservations.');
    const observation = run.toolObservations?.find(item => item.toolCallId === call.arguments.toolCallId);
    const message = observation && history.find(item => item.id === observation.messageId && item.role === 'tool');
    const criteria = ids.map(id => run.acceptanceCriteria?.find(item => item.id === id));
    if (criteria.some(item => !item) || !observation || !message || observation.error || message.error || claims.has(observation.toolName)) throw new AgentError('Для критерия нужен успешный результат инструмента текущей задачи; заявления и сводки не подходят. Используйте ID из availableObservations.');
    if (observation.revision !== (run.mutationRevision ?? 0) || observation.scope !== run.evidenceScope) throw new AgentError('После наблюдения были возможные изменения или сменились права проекта. Проверьте актуальное состояние.');
    if (criteria.some(criterion => !criterion!.toolName || !criterion!.expectedText || claims.has(criterion!.toolName))) throw new AgentError('Сначала задайте проверку критерия через set_task_criteria: toolName и expectedText обязательны для доказательства.');
    if (criteria.some(criterion => criterion!.toolName && criterion!.toolName !== observation.toolName || criterion!.expectedText && !message.content.includes(criterion!.expectedText))) throw new AgentError('Наблюдение не соответствует объявленному способу проверки критерия.');
    if (observation.toolName === 'verify_project' && (run.verification?.status !== 'passed' || run.verifiedRevision !== (run.mutationRevision ?? 0))) throw new AgentError('Проверка проекта не пройдена или устарела.');
    const evidence = { toolCallId: observation.toolCallId, messageId: message.id, revision: observation.revision, recordedAt: new Date().toISOString(), scope: observation.scope };
    for (const criterion of criteria) criterion!.evidence = { ...evidence };
    return { text: JSON.stringify({ ...(ids.length === 1 ? { criterionId: ids[0] } : { criterionIds: ids }), evidence, note: 'Evidence proves only the registered check; report its scope accurately.' }) };
  }
  if (call.name !== taskMemoryTool.name) throw new AgentError('Неизвестный инструмент контракта задачи.');
  return recordTaskMemory(call, run, history);
}

export function observeTaskTool(run: RunRecord, message: ChatMessage): void {
  if (!message.toolCallId || !message.toolName || claims.has(message.toolName)) return;
  const observation: ToolObservation = { toolCallId: message.toolCallId, messageId: message.id, toolName: message.toolName, revision: run.mutationRevision ?? 0, error: Boolean(message.error), scope: run.evidenceScope };
  run.toolObservations = [...(run.toolObservations ?? []).filter(item => item.toolCallId !== observation.toolCallId), observation];
  // Exact declarative contracts only: no semantic inference and no blanket test-success acceptance.
  if (!observation.error && (message.toolName !== 'verify_project' || run.verification?.status === 'passed' && run.verifiedRevision === observation.revision)) {
    for (const criterion of run.acceptanceCriteria ?? []) {
      if (criterion.toolName === message.toolName && criterion.expectedText && message.content.includes(criterion.expectedText)) {
        criterion.evidence = { toolCallId: observation.toolCallId, messageId: message.id, revision: observation.revision, recordedAt: new Date().toISOString(), scope: observation.scope };
      }
    }
  }
  // Keep evidence-bearing observations plus the recent working set.
  const referenced = new Set(run.acceptanceCriteria?.flatMap(item => item.evidence ? [item.evidence.toolCallId] : []) ?? []);
  run.toolObservations = run.toolObservations.filter((item, index, all) => referenced.has(item.toolCallId) || index >= all.length - 256);
}

export function completionResult(run: RunRecord): ToolResult {
  const revision = run.mutationRevision ?? 0;
  const missing = (run.acceptanceCriteria ?? []).filter(item => !item.toolName || !item.expectedText || claims.has(item.toolName) || !item.evidence || item.evidence.revision !== revision || item.evidence.scope !== run.evidenceScope).map(item => ({ id: item.id, text: item.text, ...(!item.toolName || !item.expectedText ? { needsBinding: 'Use set_task_criteria with toolName and expectedText before attaching evidence.' } : {}) }));
  const uncertain = (run.operations ?? []).filter(item => ['running', 'uncertain'].includes(item.status)).map(item => ({ operationId: item.id, toolName: item.toolName }));
  const behavior = behaviorCheckState(run), behaviorMissing = behavior && behavior.status !== 'passed';
  const counterexample = counterexampleState(run), counterexampleMissing = counterexample && counterexample.status !== 'passed';
  return { text: JSON.stringify({ status: missing.length || uncertain.length || behaviorMissing || counterexampleMissing ? 'unverified' : 'passed', missingCriteria: missing, uncertainOperations: uncertain, behaviorCheck: behavior, counterexampleReview: counterexample, availableObservations: availableEvidence(run),
    instruction: 'Reuse matching availableObservations in record_task_evidence; criterionIds can attach one observation to several checks. Only obtain new evidence when missing or stale. For an unresolved behaviorCheck, repair then rerun its exact command/cwd with behaviorCheck phase regression and the same description, after other mutations. For counterexampleReview, run its exact probe.command/cwd after other mutations, or request a second review with a concrete reason if the test is wrong. Use operationId (not toolCallId) for uncertain effects. Do not remove criteria, invent evidence or repeat uncertain effects. A passed contract proves only its checks.' }), error: Boolean(missing.length || uncertain.length || behaviorMissing || counterexampleMissing) };
}

export function availableEvidence(run: Pick<RunRecord, 'toolObservations' | 'mutationRevision' | 'evidenceScope'>) {
  return (run.toolObservations ?? []).filter(item => !item.error && !claims.has(item.toolName) && item.revision === (run.mutationRevision ?? 0) && item.scope === run.evidenceScope)
    .slice(-12).map(({ toolCallId, messageId, toolName }) => ({ toolCallId, messageId, toolName }));
}
