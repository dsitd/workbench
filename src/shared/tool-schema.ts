import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import Ajv2019 from 'ajv/dist/2019';
import type { ValidateFunction } from 'ajv';
import type { ToolDefinition } from './types';

const options = { strict: false, strictNumbers: true, allErrors: false, validateFormats: false, ownProperties: true, addUsedSchema: false, logger: false as const };
const validators = { legacy: new Ajv(options), modern: new Ajv2020(options), draft2019: new Ajv2019(options) };
const cache = new Map<string, ValidateFunction>();

/** Validation never coerces arguments, removes fields, loads remote refs, or prints their values. */
export function toolValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  if (key.length > 64_000) throw new Error('Tool schema exceeds the local validation limit.');
  const existing = cache.get(key);
  if (existing) return existing;
  function inspect(value: unknown, depth = 0): void {
    if (depth > 32) throw new Error('Tool schema is too deeply nested.');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
    const object = value as Record<string, unknown>;
    if (object.$async || (typeof object.$ref === 'string' && !object.$ref.startsWith('#'))) throw new Error('Async schemas and external schema references are unsupported.');
    Object.values(object).forEach(item => inspect(item, depth + 1));
  }
  inspect(schema);
  try {
    const draft = String(schema.$schema ?? '');
    const validator = (draft.includes('2020-12') ? validators.modern : draft.includes('2019-09') ? validators.draft2019 : validators.legacy).compile(structuredClone(schema));
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, validator);
    return validator;
  } catch { throw new Error('Tool schema cannot be validated locally. Correct or rediscover the tool schema.'); }
}

export function validateToolArguments(tool: Pick<ToolDefinition, 'parameters'>, arguments_: unknown): void {
  const validate = toolValidator(tool.parameters);
  if (validate(arguments_)) return;
  const error = validate.errors?.[0];
  const field = error?.instancePath || '/';
  const missing = error?.keyword === 'required' ? ` (${String(error.params.missingProperty)})` : '';
  const choices = error?.keyword === 'enum' && Array.isArray(error.params.allowedValues)
    ? ` Allowed values: ${JSON.stringify(error.params.allowedValues.slice(0, 12)).slice(0, 400)}.` : '';
  throw new Error(`Invalid tool arguments at ${field}${missing}: ${error?.message ?? 'schema mismatch'}.${choices} No action was performed.`);
}

/** A conservative strict-wire representation; local schemas retain their optional-field semantics. */
export function strictToolSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  function convert(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    // Leave externally defined, open-ended and composed schemas in their original mode.
    if (source.$ref || source.patternProperties || source.oneOf || source.allOf || source.if || source.additionalProperties && source.additionalProperties !== false) throw new Error('Unsupported strict schema');
    const result = structuredClone(source);
    if (source.type === 'object') {
      if (!source.properties || typeof source.properties !== 'object' || source.additionalProperties !== false) throw new Error('Open object');
      const required = new Set(Array.isArray(source.required) ? source.required : []);
      result.properties = Object.fromEntries(Object.entries(source.properties).map(([name, child]) => {
        const converted = convert(child);
        return [name, required.has(name) ? converted : { anyOf: [converted, { type: 'null' }] }];
      }));
      result.required = Object.keys(source.properties);
      result.additionalProperties = false;
    }
    if (source.items) result.items = convert(source.items);
    if (Array.isArray(source.anyOf)) result.anyOf = source.anyOf.map(convert);
    return result;
  }
  try { return convert(schema) as Record<string, unknown>; } catch { return undefined; }
}

export function nativeStrictSchema(baseUrl: string, tool: ToolDefinition): Record<string, unknown> | undefined {
  return /^https:\/\/api\.openai\.com\/v1(?:\/|$)/.test(baseUrl) && !tool.source ? strictToolSchema(tool.parameters) : undefined;
}

/** Null is a wire placeholder only for originally optional, non-nullable native properties. */
export function normalizeToolArguments(tool: ToolDefinition, arguments_: Record<string, unknown>): Record<string, unknown> {
  if (tool.source) return arguments_;
  function normalize(value: unknown, schema: Record<string, unknown>): unknown {
    if (Array.isArray(value) && schema.items && typeof schema.items === 'object') return value.map(item => normalize(item, schema.items as Record<string, unknown>));
    if (!value || typeof value !== 'object' || Array.isArray(value) || schema.type !== 'object' || !schema.properties) return value;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const childSchema = properties[key];
      const nullable = childSchema?.type === 'null' || Array.isArray(childSchema?.type) && childSchema.type.includes('null')
        || Array.isArray(childSchema?.anyOf) && childSchema.anyOf.some(item => item && typeof item === 'object' && item.type === 'null');
      if (child === null && childSchema && !required.has(key) && !nullable) return [];
      return [[key, childSchema ? normalize(child, childSchema) : child]];
    }));
  }
  return normalize(arguments_, tool.parameters) as Record<string, unknown>;
}
