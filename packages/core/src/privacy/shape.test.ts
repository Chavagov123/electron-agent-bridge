import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { shapeOf } from './shape.js';

class Order {
  constructor(
    readonly id: number,
    readonly note: string,
  ) {}
}

describe('shapeOf', () => {
  it('describes types without contents', () => {
    expect(shapeOf({ id: 7, name: 'secret-name', tags: ['a', 'b'], ok: true, at: new Date() })).toBe(
      '{id: number, name: string, tags: string[2], ok: boolean, at: Date}',
    );
    expect(shapeOf([1, 'x', null])).toBe('(number | string | null)[3]');
    expect(shapeOf([])).toBe('[]');
    expect(shapeOf(undefined)).toBe('undefined');
    expect(shapeOf(() => 1)).toBe('function');
    expect(shapeOf(10n)).toBe('bigint');
  });

  it('names builtins and class instances', () => {
    expect(shapeOf(new Map([[1, 2]]))).toBe('Map(1)');
    expect(shapeOf(new Set())).toBe('Set(0)');
    expect(shapeOf(new Uint8Array(4))).toBe('Uint8Array(4)');
    expect(shapeOf(new ArrayBuffer(8))).toBe('ArrayBuffer(8)');
    expect(shapeOf(new TypeError('x'))).toBe('TypeError');
    expect(shapeOf(/x/)).toBe('RegExp');
    expect(shapeOf(Promise.resolve())).toBe('Promise');
    expect(shapeOf(new Order(1, 'n'))).toBe('Order{id: number, note: string}');
    expect(shapeOf(Object.create(null) as object)).toBe('{}');
  });

  it('is cycle-safe and bounded in depth, keys and length', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(shapeOf(cyclic)).toBe('{a: number, self: [circular]}');
    expect(shapeOf({ a: { b: { c: [1] } } }, { maxDepth: 2 })).toBe('{a: {b: {…}}}');
    expect(shapeOf([[1]], { maxDepth: 1 })).toBe('[…1][1]');
    expect(shapeOf({ a: 1, b: 2, c: 3 }, { maxKeys: 2 })).toBe('{a: number, b: number, …+1}');
    expect(shapeOf({ long: 'x' }, { maxChars: 5 })).toBe('{lon…');
  });

  it('survives hostile objects', () => {
    const throwing = {
      get boom(): never {
        throw new Error('nope');
      },
    };
    expect(shapeOf(throwing)).toBe('[unreadable]');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(shapeOf(proxy)).toBe('[unreadable]');
  });

  it('bounds work on heavily shared structures instead of expanding every path', () => {
    let level: Record<string, unknown> = { leaf: 1 };
    for (let depth = 0; depth < 6; depth++) {
      const next: Record<string, unknown> = {};
      for (let key = 0; key < 50; key++) next[`k${key}`] = level;
      level = next;
    }
    const started = Date.now();
    const shape = shapeOf(level, { maxDepth: 10, maxKeys: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(shape.length).toBeLessThanOrEqual(500);
  });

  it('property: never throws and never exceeds maxChars', () => {
    fc.assert(
      fc.property(fc.anything(), fc.integer({ min: 1, max: 200 }), (value, maxChars) => {
        expect(shapeOf(value, { maxChars }).length).toBeLessThanOrEqual(maxChars);
      }),
    );
  });

  it('property: string contents never appear in the shape', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{12,30}$/), (secret) => {
        expect(shapeOf({ field: secret, list: [secret], nested: { deep: secret } })).not.toContain(secret);
      }),
    );
  });
});
