/** Limits for {@link shapeOf}. */
export interface ShapeLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  /** The rendered shape is clipped to this many characters. */
  readonly maxChars: number;
}

const DEFAULT_LIMITS: ShapeLimits = { maxDepth: 4, maxKeys: 20, maxChars: 500 };
/** Array elements sampled to describe the element type. */
const SAMPLE = 10;

interface Walk {
  readonly limits: ShapeLimits;
  readonly seen: Set<object>;
  /**
   * Values still allowed to be visited. Every visited value adds at least one character, so once
   * `maxChars` values are described the result would be clipped anyway: stop walking instead of
   * expanding shared references (which are walked once per path) without bound.
   */
  nodesLeft: number;
}

/**
 * Describe the *type* of a value without any of its contents, e.g. `{id: number, tags: string[2]}`.
 * This is what the bridge records by default for IPC arguments: enough to understand traffic,
 * nothing that leaks data. Cycle-safe, bounded in work and size, never throws (hostile getters included).
 */
export function shapeOf(value: unknown, limits: Partial<ShapeLimits> = {}): string {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const walk: Walk = { limits: effective, seen: new Set(), nodesLeft: effective.maxChars };
  const text = describe(value, walk, 0);
  return text.length > effective.maxChars ? `${text.slice(0, Math.max(0, effective.maxChars - 1))}…` : text;
}

function describe(value: unknown, walk: Walk, depth: number): string {
  if (walk.nodesLeft <= 0) return '…';
  walk.nodesLeft--;
  if (value === null) return 'null';
  // Primitives and functions are described by their type name alone.
  return typeof value === 'object' ? describeObject(value, walk, depth) : typeof value;
}

function describeObject(value: object, walk: Walk, depth: number): string {
  if (walk.seen.has(value)) return '[circular]';
  walk.seen.add(value);
  // Everything that touches the object is guarded: revoked proxies throw even on `instanceof`.
  try {
    const special = describeBuiltin(value);
    if (special !== undefined) return special;
    if (depth >= walk.limits.maxDepth) return Array.isArray(value) ? `[…${value.length}]` : '{…}';
    return Array.isArray(value) ? describeArray(value, walk, depth) : describeRecord(value, walk, depth);
  } catch {
    return '[unreadable]';
  } finally {
    walk.seen.delete(value);
  }
}

function describeBuiltin(value: object): string | undefined {
  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  if (value instanceof Error) return value.name || 'Error';
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (value instanceof Promise) return 'Promise';
  return undefined;
}

function describeArray(value: unknown[], walk: Walk, depth: number): string {
  if (value.length === 0) return '[]';
  const types = new Set<string>();
  for (const item of value.slice(0, SAMPLE)) types.add(describe(item, walk, depth + 1));
  const union = [...types].join(' | ');
  const element = types.size > 1 ? `(${union})` : union;
  return `${element}[${value.length}]`;
}

function describeRecord(value: object, walk: Walk, depth: number): string {
  const keys = Object.keys(value);
  const shown: string[] = [];
  for (const key of keys.slice(0, walk.limits.maxKeys)) {
    if (walk.nodesLeft <= 0) break;
    shown.push(`${key}: ${describe((value as Record<string, unknown>)[key], walk, depth + 1)}`);
  }
  if (keys.length > shown.length) shown.push(`…+${keys.length - shown.length}`);
  const prototype: unknown = Object.getPrototypeOf(value);
  const name = prototype === Object.prototype || prototype === null ? '' : constructorName(prototype);
  return `${name}{${shown.join(', ')}}`;
}

function constructorName(prototype: unknown): string {
  const ctor: unknown = (prototype as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name !== 'Object' ? ctor.name : '';
}
