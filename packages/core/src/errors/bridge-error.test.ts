import { describe, expect, it } from 'vitest';

import { BridgeError } from './bridge-error.js';

describe('BridgeError', () => {
  it('serializes code and hint only', () => {
    const error = new BridgeError('TIMEOUT', 'too slow', {
      hint: 'raise timeoutMs',
      cause: new Error('inner'),
    });
    expect(error.toData()).toEqual({ code: 'TIMEOUT', hint: 'raise timeoutMs' });
    expect(new BridgeError('NOT_FOUND', 'x').toData()).toEqual({ code: 'NOT_FOUND' });
  });

  it('keeps bridge errors and wraps anything else as INTERNAL', () => {
    const original = new BridgeError('DETACHED', 'gone');
    expect(BridgeError.from(original)).toBe(original);
    const wrapped = BridgeError.from(new TypeError('boom'));
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toBe('boom');
    expect(BridgeError.from('text').message).toBe('text');
  });
});
