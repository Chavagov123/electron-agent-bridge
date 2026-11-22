import { CAPS } from '../budget/caps.js';

/** JSON-safe value produced by {@link redact}. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RedactOptions {
  /** Keys whose values are replaced by `[redacted]` at any depth. */
  readonly sensitiveKeys?: RegExp;
  readonly maxDepth?: number;
  readonly maxKeys?: number;
  readonly maxArrayItems?: number;
  readonly maxStringChars?: number;
  /**
   * Total values visited. Shared references are walked once per path, so without this a small,
   * heavily shared structure could expand exponentially.
   */
  readonly maxNodes?: number;
}

export interface Redacted {
  readonly value: JsonValue;
  /** Number of values replaced because their key looked sensitive. */
  readonly redactions: number;
  /** Whether any depth, key, item or string limit cut the value. */
  readonly truncated: boolean;
}

/**
 * Words that conventionally name secrets. Tested against each word of a key and each pair of adjacent
 * words joined (`x-api-key` → `api`, `key`, `apikey`), so `author` or `spinner` are not caught but
 * `refreshToken`, `api_key` and `Authorization` are.
 */
export const DEFAULT_SENSITIVE_KEYS =
  /^(pass(word|wd|phrase)?|pwd|secret|token|auth(orization)?|cookies?|session(id)?|apikey|credentials?|privatekey|otp|pin|cvv|ssn)$/i;

/** Whether a key names a secret according to `pattern` (see {@link DEFAULT_SENSITIVE_KEYS}). */
export function isSensitiveKey(key: string, pattern: RegExp = DEFAULT_SENSITIVE_KEYS): boolean {
  return isSensitiveWith(key, stateless(pattern));
}

/** A `g`/`y` RegExp keeps `lastIndex` between `test()` calls; strip those flags so every test starts fresh. */
function stateless(pattern: RegExp): RegExp {
  return pattern.global || pattern.sticky
    ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    : pattern;
}

function isSensitiveWith(key: string, pattern: RegExp): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '');
  for (const [index, word] of words.entries()) {
    if (pattern.test(word)) return true;
    const next = words[index + 1];
    if (next !== undefined && pattern.test(`${word}${next}`)) return true;
  }
  return false;
}

export const REDACTED = '[redacted]';

interface Context {
  readonly options: Required<RedactOptions>;
  readonly seen: Set<object>;
  nodesLeft: number;
  redactions: number;
  truncated: boolean;
}

/**
 * Turn any value into bounded, JSON-safe data with secrets removed. Used before captured values
 * (IPC args, state, eval results) leave the app. Cycle-safe and never throws.
 */
export function redact(value: unknown, options: RedactOptions = {}): Redacted {
  const context: Context = {
    options: {
      sensitiveKeys: stateless(options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS),
      maxDepth: options.maxDepth ?? CAPS.value.maxDepth,
      maxKeys: options.maxKeys ?? CAPS.value.maxKeys,
      maxArrayItems: options.maxArrayItems ?? CAPS.value.maxArrayItems,
      maxStringChars: options.maxStringChars ?? CAPS.value.maxStringChars,
      maxNodes: options.maxNodes ?? CAPS.value.maxNodes,
    },
    seen: new Set(),
    nodesLeft: options.maxNodes ?? CAPS.value.maxNodes,
    redactions: 0,
    truncated: false,
  };
  const result = convert(value, context, 0);
  return { value: result, redactions: context.redactions, truncated: context.truncated };
}

function convert(value: unknown, context: Context, depth: number): JsonValue {
  if (context.nodesLeft <= 0) {
    context.truncated = true;
    return '[budget]';
  }
  context.nodesLeft--;
  switch (typeof value) {
    case 'string':
      return clipString(value, context);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'undefined':
      return null;
    case 'symbol':
      return '[symbol]';
    case 'function':
      return '[function]';
    case 'object':
      return value === null ? null : convertObject(value, context, depth);
  }
}

function convertObject(value: object, context: Context, depth: number): JsonValue {
  if (context.seen.has(value)) return '[circular]';
  context.seen.add(value);
  try {
    const builtin = convertBuiltin(value, context);
    if (builtin !== undefined) return builtin;
    if (depth >= context.options.maxDepth) {
      context.truncated = true;
      return '[depth]';
    }
    return Array.isArray(value) ? convertArray(value, context, depth) : convertRecord(value, context, depth);
  } catch {
    return '[unreadable]';
  } finally {
    context.seen.delete(value);
  }
}

function convertBuiltin(value: object, context: Context): JsonValue | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error)
    return { $type: value.name || 'Error', message: clipString(value.message, context) };
  if (value instanceof Map) return { $type: 'Map', size: value.size };
  if (value instanceof Set) return { $type: 'Set', size: value.size };
  if (value instanceof ArrayBuffer) return { $type: 'ArrayBuffer', byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) return { $type: value.constructor.name, byteLength: value.byteLength };
  if (value instanceof Promise) return '[promise]';
  return undefined;
}

function convertArray(value: unknown[], context: Context, depth: number): JsonValue {
  const limit = context.options.maxArrayItems;
  const items = value.slice(0, limit).map((item) => convert(item, context, depth + 1));
  if (value.length > limit) {
    context.truncated = true;
    items.push(`[…+${value.length - limit} items]`);
  }
  return items;
}

function convertRecord(value: object, context: Context, depth: number): JsonValue {
  const keys = Object.keys(value);
  const limit = context.options.maxKeys;
  const result: Record<string, JsonValue> = {};
  for (const key of keys.slice(0, limit)) {
    if (isSensitiveWith(key, context.options.sensitiveKeys)) {
      context.redactions++;
      result[key] = REDACTED;
      continue;
    }
    const field: unknown = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    result[key] = convert(field, context, depth + 1);
  }
  if (keys.length > limit) {
    context.truncated = true;
    result['…'] = `+${keys.length - limit} keys`;
  }
  return result;
}

function clipString(text: string, context: Context): string {
  const limit = context.options.maxStringChars;
  if (text.length <= limit) return text;
  context.truncated = true;
  return `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
}
