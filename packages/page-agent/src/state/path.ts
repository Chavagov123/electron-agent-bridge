/**
 * Split a state path into keys: `orders.items[0].id` → `orders`, `items`, `0`, `id`; quoted brackets
 * keep dots and brackets in a key: `byId["a.b"]`. Returns `undefined` for a malformed path.
 */
export function parsePath(path: string): string[] | undefined {
  const keys: string[] = [];
  const pattern = /\.?([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/gy;
  let index = 0;
  while (index < path.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(path);
    if (!match) return undefined;
    const key = match[1] ?? match[2] ?? (match[3] ?? match[4] ?? '').replace(/\\(.)/g, '$1');
    keys.push(key);
    index = pattern.lastIndex;
  }
  return keys;
}

export type PathLookup =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly at: string; readonly keys: string[] };

/** Follow `keys` from `root`; on a miss, says where and which keys exist there. */
export function lookup(root: unknown, keys: readonly string[]): PathLookup {
  let current = root;
  for (const [depth, key] of keys.entries()) {
    const container = current as Record<string, unknown> | null | undefined;
    let next: unknown;
    let has = false;
    try {
      if (container !== null && container !== undefined && typeof container === 'object') {
        if (container instanceof Map) {
          has = container.has(key);
          next = container.get(key);
        } else {
          has = key in container;
          next = container[key];
        }
      }
    } catch {
      has = false;
    }
    if (!has) {
      const at = keys.slice(0, depth).join('.') || '(root)';
      return { found: false, at, keys: keysOf(container) };
    }
    current = next;
  }
  return { found: true, value: current };
}

function keysOf(value: unknown): string[] {
  try {
    if (value instanceof Map) return [...value.keys()].map(String).slice(0, 20);
    return value !== null && typeof value === 'object' ? Object.keys(value).slice(0, 20) : [];
  } catch {
    return [];
  }
}
