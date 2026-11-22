import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { REDACTED, isSensitiveKey, redact } from './redact.js';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'Password',
    'newPassword',
    'user_password',
    'passwd',
    'token',
    'refreshToken',
    'access_token',
    'Authorization',
    'x-api-key',
    'apiKey',
    'api_key',
    'privateKey',
    'sessionId',
    'Cookie',
    'cookies',
    'clientSecret',
    'otp',
    'cardCvv',
  ])('treats %j as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['author', 'authorName', 'spinner', 'shipping', 'tokenizer', 'passage', 'id', 'name', 'keyboard'])(
    'treats %j as ordinary',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redact', () => {
  it('replaces sensitive values at any depth and counts them', () => {
    const result = redact({ user: { name: 'ann', password: 'hunter2' }, list: [{ token: 't' }] });
    expect(result.value).toEqual({ user: { name: 'ann', password: REDACTED }, list: [{ token: REDACTED }] });
    expect(result.redactions).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('produces JSON-safe values for every JavaScript type', () => {
    const value = redact({
      n: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      big: 10n,
      u: undefined,
      sym: Symbol('s'),
      fn: () => 1,
      date: new Date(0),
      bad: new Date(Number.NaN),
      re: /x/g,
      err: new RangeError('r'),
      map: new Map([[1, 1]]),
      set: new Set([1]),
      buf: new Uint8Array(3),
      ab: new ArrayBuffer(2),
      promise: Promise.resolve(),
      arr: [undefined],
    }).value;
    expect(value).toEqual({
      n: 'NaN',
      inf: 'Infinity',
      big: '10n',
      sym: '[symbol]',
      fn: '[function]',
      date: '1970-01-01T00:00:00.000Z',
      bad: 'Invalid Date',
      re: '/x/g',
      err: { $type: 'RangeError', message: 'r' },
      map: { $type: 'Map', size: 1 },
      set: { $type: 'Set', size: 1 },
      buf: { $type: 'Uint8Array', byteLength: 3 },
      ab: { $type: 'ArrayBuffer', byteLength: 2 },
      promise: '[promise]',
      arr: [null],
    });
  });

  it('bounds depth, keys, items and strings and reports truncation', () => {
    expect(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toMatchObject({
      value: { a: { b: '[depth]' } },
      truncated: true,
    });
    expect(redact({ a: 1, b: 2, c: 3 }, { maxKeys: 2 }).value).toEqual({ a: 1, b: 2, '…': '+1 keys' });
    expect(redact([1, 2, 3], { maxArrayItems: 2 }).value).toEqual([1, 2, '[…+1 items]']);
    expect(redact('abcdef', { maxStringChars: 3 })).toEqual({
      value: 'abc…(+3 chars)',
      redactions: 0,
      truncated: true,
    });
  });

  it('handles cycles, shared references and hostile objects', () => {
    const shared = { x: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic['self'] = cyclic;
    expect(redact(cyclic).value).toEqual({ shared: { x: 1 }, again: { x: 1 }, self: '[circular]' });
    const hostile = {
      get boom(): never {
        throw new Error('nope');
      },
    };
    expect(redact({ hostile }).value).toEqual({ hostile: '[unreadable]' });
  });

  it('accepts a custom sensitive-word pattern', () => {
    expect(redact({ iban: 'DE00', name: 'x' }, { sensitiveKeys: /^iban$/i }).value).toEqual({
      iban: REDACTED,
      name: 'x',
    });
  });

  it('is not fooled by a global or sticky custom pattern (RegExp lastIndex state)', () => {
    for (const sensitiveKeys of [/^(password|token)$/gi, /^(password|token)$/y]) {
      expect(redact({ password: 'a', token: 'b', other: 'c' }, { sensitiveKeys }).value).toEqual({
        password: REDACTED,
        token: REDACTED,
        other: 'c',
      });
    }
    expect([isSensitiveKey('token', /^token$/g), isSensitiveKey('token', /^token$/g)]).toEqual([true, true]);
  });

  it('bounds total work on heavily shared structures', () => {
    // 50^6 paths through 6 shared levels: exponential if every path were expanded.
    let level: Record<string, unknown> = { leaf: 1 };
    for (let depth = 0; depth < 6; depth++) {
      const next: Record<string, unknown> = {};
      for (let key = 0; key < 50; key++) next[`k${key}`] = level;
      level = next;
    }
    const started = Date.now();
    const result = redact(level, { maxDepth: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.value)).toContain('[budget]');
  });

  it('property: never throws, always JSON-serialisable', () => {
    fc.assert(
      fc.property(
        fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true }),
        (value) => {
          const result = redact(value);
          expect(() => JSON.stringify(result.value)).not.toThrow();
        },
      ),
    );
  });

  it('property: a value stored under a sensitive key never survives', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('password', 'apiKey', 'sessionToken', 'Authorization'),
        fc.stringMatching(/^[A-Za-z0-9]{8,30}$/),
        fc.integer({ min: 0, max: 4 }),
        (key, secret, depth) => {
          let value: unknown = { [key]: secret };
          for (let level = 0; level < depth; level++) value = { level: [value] };
          expect(JSON.stringify(redact(value).value)).not.toContain(secret);
        },
      ),
    );
  });
});
