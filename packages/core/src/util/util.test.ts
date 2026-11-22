import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { anyGlobMatcher, globMatcher } from './glob.js';
import { jsonByteSize, utf8Length } from './utf8.js';

/** Node's Buffer as the reference implementation (core itself must not depend on it). */
const reference = (globalThis as unknown as { Buffer: { byteLength(text: string): number } }).Buffer;

describe('utf8Length', () => {
  it('counts 1-4 bytes per code point', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('日')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('counts a lone surrogate as 3 bytes without swallowing the next character', () => {
    expect(utf8Length('\uD800中')).toBe(6);
    expect(utf8Length('\uD800')).toBe(3);
    expect(utf8Length('\uDC00a')).toBe(4);
  });

  it('property: agrees with Buffer.byteLength, including malformed UTF-16', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(utf8Length(text)).toBe(reference.byteLength(text));
      }),
    );
  });
});

describe('jsonByteSize', () => {
  it('measures JSON text and falls back for unserialisable values', () => {
    expect(jsonByteSize({ a: 'é' })).toBe(10);
    expect(jsonByteSize(undefined)).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(jsonByteSize(cyclic, 7)).toBe(7);
    expect(jsonByteSize(1n)).toBe(1024);
  });
});

/** Reference semantics for the property test: the obvious (exponential) recursive matcher. */
function slowGlob(pattern: string, text: string): boolean {
  const p = Array.from(pattern);
  const t = Array.from(text);
  const go = (i: number, j: number): boolean => {
    if (i === p.length) return j === t.length;
    if (p[i] === '*') return go(i + 1, j) || (j < t.length && go(i, j + 1));
    return j < t.length && (p[i] === '?' || p[i] === t[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

describe('glob', () => {
  it.each([
    ['orders:*', 'orders:create', true],
    ['orders:*', 'orders:', true],
    ['orders:*', 'users:create', false],
    ['*:save', 'doc:save', true],
    ['file?', 'file1', true],
    ['file?', 'file12', false],
    ['a.b', 'axb', false],
    ['(x)+[y]', '(x)+[y]', true],
    ['*', 'multi\nline', true],
    ['*', '', true],
    ['?', '😀', true],
    ['a**b', 'ab', true],
    ['*a*b', 'xxaxxbx', false],
  ])('%j matches %j: %s', (pattern, text, expected) => {
    expect(globMatcher(pattern)(text)).toBe(expected);
  });

  it('matches any of several patterns; none for an empty list', () => {
    expect(anyGlobMatcher(['a:*', 'b:*'])('b:x')).toBe(true);
    expect(anyGlobMatcher([])('anything')).toBe(false);
  });

  it('stays fast on adversarial many-star patterns', () => {
    const matches = globMatcher(`${'*a'.repeat(30)}*b`);
    const started = Date.now();
    expect(matches('a'.repeat(5_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('property: agrees with the reference matcher', () => {
    const alphabet = fc.constantFrom('a', 'b', '*', '?');
    fc.assert(
      fc.property(
        fc.string({ unit: alphabet, maxLength: 8 }),
        fc.string({ unit: fc.constantFrom('a', 'b'), maxLength: 10 }),
        (pattern, text) => {
          expect(globMatcher(pattern)(text)).toBe(slowGlob(pattern, text));
        },
      ),
    );
  });
});
