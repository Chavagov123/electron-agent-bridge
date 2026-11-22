/** Bounds for one state read (the runtime redacts and bounds again with the same limits). */
export interface ValueLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringChars: number;
  readonly maxNodes: number;
}

export const DEFAULT_LIMITS: ValueLimits = {
  maxDepth: 6,
  maxKeys: 50,
  maxArrayItems: 50,
  maxStringChars: 1_000,
  maxNodes: 5_000,
};

export interface JsonResult {
  readonly value: unknown;
  readonly truncated: boolean;
}

/**
 * A JSON-safe, bounded copy of an app value: cycles, functions, Maps, Sets, Dates, errors, DOM nodes
 * and getters that throw are all described instead of breaking the read. Store state may be proxies
 * (MobX, Immer); only ordinary property reads are used.
 */
export function toJson(input: unknown, limits: ValueLimits = DEFAULT_LIMITS): JsonResult {
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > limits.maxNodes) {
      truncated = true;
      return '[…]';
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
    }
    if (typeof value === 'string') {
      if (value.length <= limits.maxStringChars) return value;
      truncated = true;
      return `${value.slice(0, limits.maxStringChars)}…`;
    }
    if (typeof value === 'undefined') return null;
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    return walkObject(value, depth);
  };

  // Exotic objects (revoked proxies) can throw on any inspection: describe them instead of failing.
  const walkObject = (value: object, depth: number): unknown => {
    try {
      return walkObjectUnsafe(value, depth);
    } catch {
      return '[unreadable]';
    }
  };

  const walkObjectUnsafe = (value: object, depth: number): unknown => {
    if (seen.has(value)) return '[circular]';
    const special = describeSpecial(value);
    if (special !== undefined) return special;
    if (depth >= limits.maxDepth) {
      truncated = true;
      return Array.isArray(value) ? `[array(${value.length})]` : '[object]';
    }
    seen.add(value);
    try {
      if (value instanceof Map) return { '[Map]': walkList([...value.entries()], depth) };
      if (value instanceof Set) return { '[Set]': walkList([...value.values()], depth) };
      if (Array.isArray(value)) return walkList(value, depth);
      const out: Record<string, unknown> = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, limits.maxKeys)) {
        let property: unknown;
        try {
          property = (value as Record<string, unknown>)[key];
        } catch {
          property = '[unreadable]';
        }
        if (property !== undefined) out[key] = walk(property, depth + 1);
      }
      if (keys.length > limits.maxKeys) {
        truncated = true;
        out['…'] = `${keys.length - limits.maxKeys} more keys`;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const walkList = (list: readonly unknown[], depth: number): unknown[] => {
    const out = list.slice(0, limits.maxArrayItems).map((item) => walk(item, depth + 1));
    if (list.length > limits.maxArrayItems) {
      truncated = true;
      out.push(`… ${list.length - limits.maxArrayItems} more`);
    }
    return out;
  };

  const value = walk(input, 0);
  return { value, truncated };
}

function describeSpecial(value: object): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof RegExp) return value.toString();
  if (typeof Node !== 'undefined' && value instanceof Node) return `[node ${value.nodeName}]`;
  if (typeof Window !== 'undefined' && value instanceof Window) return '[window]';
  if (value instanceof Promise) return '[promise]';
  return undefined;
}
