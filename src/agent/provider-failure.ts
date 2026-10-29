import type { ModelResponse } from '../shared/agent';
import { AgentError } from './errors';

/** Safe transport diagnostics may carry billing metadata, never server bodies or opaque blocks. */
export class ModelGenerationFailure extends AgentError {
  constructor(message: string, readonly usage?: ModelResponse['usage']) { super(message); }
}

/** An explicit payment/budget rejection is resumable, not a transient rate limit. */
export class ModelBudgetError extends AgentError {
  constructor() { super('API вернул HTTP 402: запрос отклонён из-за оплаты или денежного лимита. Проверьте баланс и применяемые лимиты; автоматический повтор не выполнен.'); }
}
