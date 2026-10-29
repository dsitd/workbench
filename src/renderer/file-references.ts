import type { ContextPin } from '../shared/types';

/** The backend accepts the range inside the quoted @file reference. */
export function fileReference(pin: ContextPin): string | undefined {
  const range = pin.startLine ? `#L${pin.startLine}${pin.endLine && pin.endLine !== pin.startLine ? `-L${pin.endLine}` : ''}` : '';
  const reference = `${pin.path}${range}`;
  if (!reference.includes('"')) return `@file:"${reference}"`;
  if (!reference.includes("'")) return `@file('${reference}')`;
  return undefined;
}
