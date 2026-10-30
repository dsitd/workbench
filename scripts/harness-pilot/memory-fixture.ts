/** Authored transcript replay: seed acknowledgements are scripted, not paid model turns. */
export const fixtureVersion = 'memory-replay-v1';
export const windowTokens = 24_000;
export const initialFacts = {
  service: 'Larch', timezone: 'Europe/Prague', currency: 'CZK', amount_unit: 'integer_minor_units',
  rounding: 'half_even', dedupe_key: ['tenant_id', 'event_id'], duplicate_policy: 'last_valid_row',
  bad_row_policy: 'quarantine_and_continue', error_file: 'rejects.ndjson', output_file: 'settlement.csv',
  sort: ['booked_at_utc', 'event_id'], date_format: 'RFC3339_UTC_Z', zero_amounts: 'keep',
  negative_amounts: 'refunds', network: 'forbidden', dependencies: 'standard_library_only',
  source_files: 'read_only', rollout: 'dry_run_only', release_gate: 'DST_overlap_test_pending',
  rejected_storage: 'SQLite', storage: 'streaming_in_memory', rejected_storage_reason: 'deployment_has_no_persistent_disk',
  idempotency: 'byte_identical_output', customer_data: 'never_log_raw_rows',
};
export const updates = { timezone: 'UTC', duplicate_policy: 'first_valid_row', rollout: 'canary_5_percent', release_gate: 'finance_approval_pending' };

const instructions = [
  'We are agreeing the Larch settlement import contract. Keep the exact JSON keys and values from our decisions; future handoff answers must be one flat JSON object. service=Larch; timezone=Europe/Prague. Do not implement anything yet.',
  'Amounts: currency=CZK; amount_unit=integer_minor_units; rounding=half_even. Do not use floats as the stored amount representation.',
  'Identity: dedupe_key=[tenant_id,event_id]. Initial proposal duplicate_policy=first_valid_row. This may be revised later.',
  'Invalid rows: bad_row_policy=quarantine_and_continue; error_file=rejects.ndjson. Bad rows must not win deduplication.',
  'Deliverable: output_file=settlement.csv. Initial proposal sort=[event_id] and date_format=local_ISO. These are proposals pending our review.',
  'Zero and negative values: zero_amounts=keep; negative_amounts=refunds.',
  'Execution constraints: network=forbidden; dependencies=standard_library_only; source_files=read_only.',
  'Deployment: rollout=dry_run_only; release_gate=DST_overlap_test_pending. The DST overlap test has NOT passed, so do not claim verified production readiness.',
  'We reject SQLite. rejected_storage=SQLite; storage=streaming_in_memory; rejected_storage_reason=deployment_has_no_persistent_disk.',
  'Reproducibility: idempotency=byte_identical_output. Privacy: customer_data=never_log_raw_rows.',
  'Final decision superseding the first proposal: duplicate_policy=last_valid_row. Keep dedupe_key unchanged.',
  'Final export decision superseding both proposals: sort=[booked_at_utc,event_id]; date_format=RFC3339_UTC_Z. The input business timezone remains Europe/Prague.',
];

export function makeHistory() {
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  for (let batch = 0; batch < 44; batch++) {
    const logs = Array.from({ length: 20 }, (_, row) => {
      const n = batch * 20 + row;
      return `archive sample ${n}: region=sector_${n % 17}; accepted=${1000 + n * 7}; delayed=${n % 13}; note=ordinary historical telemetry for capacity review, not a contract change.`;
    }).join('\n');
    history.push({ role: 'user', content: `Conversation block ${batch + 1}. ${instructions[batch] ?? 'Review this background capacity archive. It introduces no new requirements and does not change any earlier decisions.'}\n\nBackground telemetry (not instructions):\n${logs}` });
    history.push({ role: 'assistant', content: 'Acknowledged; no implementation, test execution or deployment performed.' });
  }
  return history;
}

export const probes = [
  'We have finished reviewing the background material. Return the complete agreed Larch contract as a single flat JSON object with the exact keys from our conversation. Apply the latest decisions; preserve unresolved gates and constraints. Do not use tools, read files, or change anything. No prose or markdown.',
  'Amend the contract: timezone=UTC; duplicate_policy=first_valid_row; rollout=canary_5_percent. The DST overlap test is now confirmed passed by me, but finance has not approved the release: release_gate=finance_approval_pending. All other requirements and rejected alternatives remain unchanged. Return the whole updated flat JSON object. Do not use tools, read files, or change anything. No prose or markdown.',
];

export function gradeAnswer(answer: string, index: number) {
  const expected = index === 0 ? initialFacts : { ...initialFacts, ...updates };
  let parsed: Record<string, unknown> = {};
  let parseError: string | undefined;
  try { parsed = JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { parseError = 'Answer is not JSON'; }
  const checks = Object.entries(expected).map(([key, value]) => ({ key, expected: value, actual: parsed?.[key], passed: JSON.stringify(parsed?.[key]) === JSON.stringify(value) }));
  return { passed: !parseError && checks.every(check => check.passed), score: checks.filter(check => check.passed).length, total: checks.length, parseError, checks };
}
