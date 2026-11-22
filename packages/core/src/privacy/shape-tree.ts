/**
 * Structural types inferred from values, merged across samples (IPC schema inference, protocol 1.1).
 * Like {@link shapeOf} they never hold contents, only types; unlike it they merge: a key missing from
 * some samples becomes optional, differing types become a union. Everything is bounded.
 */
export type ShapeNode =
  | { readonly t: 'type'; readonly name: string }
  | { readonly t: 'array'; readonly of?: ShapeNode }
  | { readonly t: 'tuple'; readonly items: readonly ShapeField[] }
  | {
      readonly t: 'object';
      readonly name?: string;
      readonly keys: Readonly<Record<string, ShapeField>>;
      /** Keys beyond the cap were left out. */
      readonly more?: boolean;
    }
  | { readonly t: 'union'; readonly of: readonly ShapeNode[] }
  | { readonly t: 'unknown' };

/** A key or tuple item: its type, and whether some samples lacked it. */
export interface ShapeField {
  readonly node: ShapeNode;
  readonly optional: boolean;
}

const MAX_DEPTH = 4;
const MAX_KEYS = 30;
const MAX_UNION = 6;
const MAX_ITEMS = 10;
const ARRAY_SAMPLE = 10;
/** Most nodes one inference visits (shared references and wide values stop here). */
const MAX_NODES = 500;
/** Rendered types are clipped to this many characters. */
export const MAX_SCHEMA_CHARS = 1_000;

const UNKNOWN: ShapeNode = { t: 'unknown' };

/** The structural type of one value. Never throws; hostile getters and proxies become `unknown`. */
export function shapeTreeOf(value: unknown): ShapeNode {
  const budget = { nodes: MAX_NODES };
  return infer(value, 0, new Set(), budget);
}

/** A call's arguments (or `[result]`) as a tuple: one field per position. */
export function tupleShapeOf(args: readonly unknown[]): ShapeNode {
  const budget = { nodes: MAX_NODES };
  return {
    t: 'tuple',
    items: args
      .slice(0, MAX_ITEMS)
      .map((item) => ({ node: infer(item, 1, new Set(), budget), optional: false })),
  };
}

function infer(value: unknown, depth: number, seen: Set<object>, budget: { nodes: number }): ShapeNode {
  if (budget.nodes-- <= 0) return UNKNOWN;
  if (value === null) return { t: 'type', name: 'null' };
  if (typeof value !== 'object') return { t: 'type', name: typeof value };
  if (seen.has(value)) return UNKNOWN;
  seen.add(value);
  try {
    const builtin = builtinName(value);
    if (builtin !== undefined) return { t: 'type', name: builtin };
    if (depth >= MAX_DEPTH) return UNKNOWN;
    if (Array.isArray(value)) {
      let of: ShapeNode | undefined;
      for (const item of value.slice(0, ARRAY_SAMPLE)) {
        const node = infer(item, depth + 1, seen, budget);
        of = of === undefined ? node : mergeShape(of, node);
      }
      return of === undefined ? { t: 'array' } : { t: 'array', of };
    }
    const keys: Record<string, ShapeField> = {};
    const names = Object.keys(value);
    for (const key of names.slice(0, MAX_KEYS)) {
      keys[key] = {
        node: infer((value as Record<string, unknown>)[key], depth + 1, seen, budget),
        optional: false,
      };
    }
    const name = className(value);
    return {
      t: 'object',
      ...(name === undefined ? {} : { name }),
      keys,
      ...(names.length > MAX_KEYS ? { more: true } : {}),
    };
  } catch {
    return UNKNOWN;
  } finally {
    seen.delete(value);
  }
}

/** Merge two inferred types: keys absent on one side become optional; different types become a union. */
export function mergeShape(a: ShapeNode, b: ShapeNode): ShapeNode {
  if (a.t === 'unknown' || b.t === 'unknown') return UNKNOWN;
  if (a.t === 'union' || b.t === 'union') return union([...members(a), ...members(b)]);
  if (a.t === 'type' && b.t === 'type') return a.name === b.name ? a : union([a, b]);
  if (a.t === 'array' && b.t === 'array') return mergeArrays(a, b);
  if (a.t === 'tuple' && b.t === 'tuple') return mergeTuples(a, b);
  if (a.t === 'object' && b.t === 'object' && a.name === b.name) return mergeObjects(a, b);
  return union([a, b]);
}

type Of<T extends ShapeNode['t']> = Extract<ShapeNode, { t: T }>;

function mergeArrays(a: Of<'array'>, b: Of<'array'>): ShapeNode {
  if (a.of === undefined) return b;
  if (b.of === undefined) return a;
  return { t: 'array', of: mergeShape(a.of, b.of) };
}

function mergeTuples(a: Of<'tuple'>, b: Of<'tuple'>): ShapeNode {
  const items: ShapeField[] = [];
  for (let index = 0; index < Math.max(a.items.length, b.items.length); index++) {
    items.push(mergeField(a.items[index], b.items[index]));
  }
  return { t: 'tuple', items };
}

function mergeObjects(a: Of<'object'>, b: Of<'object'>): ShapeNode {
  const keys: Record<string, ShapeField> = {};
  const all = [...new Set([...Object.keys(a.keys), ...Object.keys(b.keys)])];
  for (const key of all.slice(0, MAX_KEYS)) keys[key] = mergeField(a.keys[key], b.keys[key]);
  const more = a.more === true || b.more === true || all.length > MAX_KEYS;
  return {
    t: 'object',
    ...(a.name === undefined ? {} : { name: a.name }),
    keys,
    ...(more ? { more: true } : {}),
  };
}

function mergeField(a: ShapeField | undefined, b: ShapeField | undefined): ShapeField {
  if (a === undefined) return { node: b?.node ?? UNKNOWN, optional: true };
  if (b === undefined) return { node: a.node, optional: true };
  return { node: mergeShape(a.node, b.node), optional: a.optional || b.optional };
}

function members(node: ShapeNode): readonly ShapeNode[] {
  return node.t === 'union' ? node.of : [node];
}

/** A union of distinct members; members of one structural kind are merged into one. */
function union(nodes: readonly ShapeNode[]): ShapeNode {
  const merged: ShapeNode[] = [];
  for (const node of nodes) {
    const index = merged.findIndex((other) => sameKind(other, node));
    const existing = merged[index];
    if (existing === undefined) merged.push(node);
    else merged[index] = mergeShape(existing, node);
  }
  if (merged.length > MAX_UNION) return UNKNOWN;
  const [only] = merged;
  return merged.length === 1 && only !== undefined ? only : { t: 'union', of: merged };
}

function sameKind(a: ShapeNode, b: ShapeNode): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'type' && b.t === 'type') return a.name === b.name;
  if (a.t === 'object' && b.t === 'object') return a.name === b.name;
  return true;
}

/** A TypeScript-like rendering: `{id: number, tags?: string[]}`, `(a: string, b?: number)` for tuples. */
export function renderShape(node: ShapeNode): string {
  const text = render(node);
  return text.length > MAX_SCHEMA_CHARS ? `${text.slice(0, MAX_SCHEMA_CHARS - 1)}…` : text;
}

function render(node: ShapeNode): string {
  switch (node.t) {
    case 'type':
      return node.name;
    case 'unknown':
      return 'unknown';
    case 'array':
      if (node.of === undefined) return 'never[]';
      return node.of.t === 'union' ? `(${render(node.of)})[]` : `${render(node.of)}[]`;
    case 'union':
      return node.of.map(render).join(' | ');
    case 'tuple':
      return `(${node.items.map((item, index) => `${String.fromCharCode(97 + (index % 26))}${item.optional ? '?' : ''}: ${render(item.node)}`).join(', ')})`;
    case 'object': {
      const fields = Object.entries(node.keys).map(
        ([key, field]) => `${safeKey(key)}${field.optional ? '?' : ''}: ${render(field.node)}`,
      );
      if (node.more === true) fields.push('…');
      return `${node.name ?? ''}{${fields.join(', ')}}`;
    }
  }
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function builtinName(value: object): string | undefined {
  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  if (value instanceof Error) return value.name || 'Error';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  if (value instanceof Promise) return 'Promise';
  return undefined;
}

function className(value: object): string | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return undefined;
  const ctor: unknown = (prototype as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name !== '' && ctor.name !== 'Object' ? ctor.name : undefined;
}
