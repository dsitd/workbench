// Safe, structured summary of a failed OpenRouter response. Only a closed set of
// derived fields is returned: never the body, headers, or free-form messages.
export interface UpstreamFailure { status: number; code?: number | string; classification: string; provider?: string }

const token = /^[A-Za-z0-9_.:-]{1,64}$/;

function classify(status: number, text: string): string {
  const m = text.toLowerCase();
  if (status === 401) return 'auth';
  if (status === 402) return 'insufficient-credits';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'upstream-server-error';
  if (/data policy|guardrail|zero.?data|privacy/.test(m)) return 'data-policy';
  if (/require_parameters|requested parameters|support(s|ed)? (all|the) |tool use|tool_choice|structured output/.test(m)) return 'unsupported-parameters';
  if (/max_price|price/.test(m)) return 'price-constraint';
  if (/no endpoints?|provider/.test(m)) return 'no-endpoint';
  if (/model.*(not found|does not exist)|not a valid model|no such model|invalid model/.test(m)) return 'model-not-found';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found-unclassified';
  if (status === 400) return 'bad-request-unclassified';
  return 'http-error';
}

export function summarizeUpstreamFailure(status: number, body: string): UpstreamFailure {
  let error: any;
  try { error = JSON.parse(body.slice(0, 65_536))?.error; } catch { /* non-JSON body */ }
  const message = typeof error?.message === 'string' ? error.message : '';
  const raw = error?.code;
  const summary: UpstreamFailure = { status, classification: classify(status, message) };
  if (typeof raw === 'number' && Number.isFinite(raw)) summary.code = raw;
  else if (typeof raw === 'string' && token.test(raw)) summary.code = raw;
  const provider = error?.metadata?.provider_name;
  if (typeof provider === 'string' && token.test(provider.replace(/\s/g, '-'))) summary.provider = provider;
  return summary;
}
