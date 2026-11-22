import { describe, expect, it } from 'vitest';

import { MAX_SCHEMA_CHARS, mergeShape, renderShape, shapeTreeOf, tupleShapeOf } from './shape-tree.js';

const merged = (...values: unknown[]): string =>
  renderShape(values.map(shapeTreeOf).reduce((a, b) => mergeShape(a, b)));

describe('shape trees', () => {
  it('describes types only, never contents', () => {
    expect(
      renderShape(shapeTreeOf({ id: 1, name: 'secret', tags: ['a'], at: new Date(), nested: { ok: true } })),
    ).toBe('{id: number, name: string, tags: string[], at: Date, nested: {ok: boolean}}');
    expect(renderShape(shapeTreeOf(null))).toBe('null');
    expect(renderShape(shapeTreeOf([]))).toBe('never[]');
    expect(renderShape(shapeTreeOf([1, 'a']))).toBe('(number | string)[]');
    expect(JSON.stringify(shapeTreeOf({ password: 'hunter2' }))).not.toContain('hunter2');
  });

  it('marks keys missing from some samples optional and merges differing types into unions', () => {
    expect(merged({ id: 1, note: 'x' }, { id: 2 })).toBe('{id: number, note?: string}');
    expect(merged({ id: 1 }, { id: 'a' }, { id: null })).toBe('{id: number | string | null}');
    expect(merged([{ a: 1 }], [{ b: 'x' }])).toBe('{a?: number, b?: string}[]');
    expect(merged([], [1])).toBe('number[]');
    expect(merged(1, 'a', true, null, undefined, 1n, Symbol('s'))).toBe('unknown');
  });

  it('renders argument lists as tuples, with positions missing in some calls optional', () => {
    const calls = [tupleShapeOf(['a', 1]), tupleShapeOf(['b'])];
    expect(renderShape(mergeShape(calls[0]!, calls[1]!))).toBe('(a: string, b?: number)');
  });

  it('is bounded and safe on cycles, deep values, hostile objects and class instances', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(renderShape(shapeTreeOf(cycle))).toBe('{self: unknown}');
    expect(renderShape(shapeTreeOf({ a: { b: { c: { d: { e: 1 } } } } }))).toBe(
      '{a: {b: {c: {d: unknown}}}}',
    );
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('no');
        },
      },
    );
    expect(renderShape(shapeTreeOf(hostile))).toBe('unknown');
    class Order {
      id = 1;
    }
    expect(renderShape(shapeTreeOf(new Order()))).toBe('Order{id: number}');
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    expect(renderShape(shapeTreeOf(wide))).toMatch(/k29: number, …}$/);
    const huge = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`key-${'x'.repeat(60)}-${index}`, 1]),
    );
    expect(renderShape(shapeTreeOf(huge)).length).toBeLessThanOrEqual(MAX_SCHEMA_CHARS);
  });

  it('names built-ins, quotes odd keys and keeps classes apart', () => {
    const value = {
      re: /x/,
      error: new TypeError('t'),
      map: new Map(),
      set: new Set(),
      buffer: new ArrayBuffer(2),
      bytes: new Uint8Array(2),
      promise: Promise.resolve(),
      'odd key': 1,
      fn: () => undefined,
    };
    expect(renderShape(shapeTreeOf(value))).toBe(
      '{re: RegExp, error: TypeError, map: Map, set: Set, buffer: ArrayBuffer, bytes: Uint8Array, promise: Promise, "odd key": number, fn: function}',
    );
    class A {
      x = 1;
    }
    class B {
      x = 1;
    }
    expect(merged(new A(), new B(), new A())).toBe('A{x: number} | B{x: number}');
    expect(merged([1], { a: 1 }, 'x')).toBe('number[] | {a: number} | string');
    expect(merged([], [])).toBe('never[]');
    expect(merged([1, 'a'], [true])).toBe('(number | string | boolean)[]');
  });

  it('merges unions, wide objects and tuples of different lengths', () => {
    const union = mergeShape(shapeTreeOf(1), shapeTreeOf('a'));
    expect(renderShape(mergeShape(union, shapeTreeOf({ a: 1 })))).toBe('number | string | {a: number}');
    expect(renderShape(mergeShape(shapeTreeOf(true), union))).toBe('boolean | number | string');
    const wide = (offset: number) =>
      Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`k${index + offset}`, index]));
    expect(renderShape(mergeShape(shapeTreeOf(wide(0)), shapeTreeOf(wide(5))))).toMatch(/…}$/);
    const merged3 = [tupleShapeOf([]), tupleShapeOf([1, 'a']), tupleShapeOf([2])].reduce((a, b) =>
      mergeShape(a, b),
    );
    expect(renderShape(merged3)).toBe('(a?: number, b?: string)');
    expect(renderShape(mergeShape(shapeTreeOf({ a: 1 }), shapeTreeOf(cycleFree())))).toBe(
      '{a: number | string}',
    );
  });
});

describe('shape tree limits', () => {
  it('merges arrays inside unions, caps tuples and node visits, and names odd classes', () => {
    expect(merged('x', [1], [true])).toBe('string | (number | boolean)[]');
    expect(renderShape(tupleShapeOf(Array.from({ length: 12 }, () => 1)))).toBe(
      '(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number)',
    );
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `k${index}`,
        Object.fromEntries(Array.from({ length: 30 }, (__, inner) => [`n${inner}`, inner])),
      ]),
    );
    expect(JSON.stringify(shapeTreeOf(wide))).toContain('"t":"unknown"');
    const anonymous: object = Object.create({ constructor: undefined }) as object;
    expect(renderShape(shapeTreeOf(anonymous))).toBe('{}');
    const nameless = new Error('x');
    nameless.name = '';
    expect(renderShape(shapeTreeOf(nameless))).toBe('Error');
    expect(renderShape(shapeTreeOf(Object.create(null) as object))).toBe('{}');
  });
});

function cycleFree(): { a: string } {
  return { a: 'x' };
}
