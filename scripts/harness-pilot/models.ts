/** Frozen short-context rates verified against provider metadata on 2026-10-09. */
export interface PilotModel {
  id: string; name: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  api: 'chat' | 'responses'; reasoning: 'none' | 'medium';
  provider?: string;
  /** Hard gateway ceiling on the incoming request body, in UTF-8 bytes. */
  maxRequestBytes: number;
}
/** Historical GPT ceiling: keeps requests below the 272K-token long-context tier. */
const GPT_MAX_REQUEST_BYTES = 200_000;
/** DeepSeek Flash bills fixed peak rates at any length; 1 MB leaves headroom over its 96K-token window. */
const FLASH_MAX_REQUEST_BYTES = 1_000_000;
const models: Readonly<Record<string, Readonly<Omit<PilotModel, 'maxRequestBytes'> & Partial<Pick<PilotModel, 'maxRequestBytes'>>>>> = {
  'deepseek/deepseek-v4.1-flash-1017': { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3, api: 'chat', reasoning: 'none', provider: 'together', maxRequestBytes: FLASH_MAX_REQUEST_BYTES },
  'openai/gpt-6-luna': { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, api: 'chat', reasoning: 'none' },
  'openai/gpt-6-sol': { id: 'openai/gpt-6-sol', name: 'GPT-6 Sol', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, api: 'chat', reasoning: 'none' },
  'openai/gpt-6.1-sol': { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, api: 'responses', reasoning: 'medium' },
};
export function resolvePilotModel(id = 'openai/gpt-6-luna'): PilotModel {
  const model = Object.hasOwn(models, id) ? models[id] : undefined;
  if (!model) throw new Error('Unsupported pilot model; select an explicitly priced canonical model ID');
  return { ...model, maxRequestBytes: model.maxRequestBytes ?? GPT_MAX_REQUEST_BYTES };
}
export function reserveRequestCost(model: PilotModel, payloadBytes: number, maxOutputTokens = 6000): number {
  // The gateway caps payloads at model.maxRequestBytes (200 KB for GPT, below the 272K-token
  // long-context tier; 1 MB for Flash, whose peak rates are fixed). Reserve cache writes (the
  // highest input rate), with UTF-8 bytes as a token upper bound; never a guessed token count,
  // so large requests stay fail-closed against the task and campaign dollar caps.
  return ((payloadBytes + 8192) * Math.max(model.input, model.cacheWrite) + maxOutputTokens * model.output) / 1_000_000;
}
