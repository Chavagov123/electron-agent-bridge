import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, isProtocolCompatible, parseVersion } from './version.js';

describe('parseVersion', () => {
  it('parses x.y.z and ignores pre-release suffixes', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it.each(['', '1', '1.2', 'a.b.c', '1.2.3.4'])('rejects %j', (input) => {
    expect(parseVersion(input)).toBeUndefined();
  });
});

describe('isProtocolCompatible', () => {
  it.each([
    ['1.0.0', '1.4.2', true],
    ['1.0.0', '2.0.0', false],
    ['0.1.0', '0.1.9', true],
    ['0.1.0', '0.2.0', false],
    ['0.1.0', 'garbage', false],
  ])('%s vs %s -> %s', (a, b, expected) => {
    expect(isProtocolCompatible(a, b)).toBe(expected);
    expect(isProtocolCompatible(b, a)).toBe(expected);
  });

  it('accepts its own version', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(true);
  });
});
