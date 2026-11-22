import { PROTOCOL_VERSION } from '@electron-agent-bridge/core';
import { describe, expect, it } from 'vitest';

import { Authenticator } from './authenticator.js';

const TOKEN = 'secret-token-123456';
const authenticator = new Authenticator({ token: TOKEN, capabilities: ['observe', 'interact'] });
const client = { name: 'test', version: '0' };

describe('Authenticator', () => {
  it('grants the app ceiling by default', () => {
    expect(authenticator.authenticate({ token: TOKEN, protocolVersion: PROTOCOL_VERSION, client })).toEqual([
      'observe',
      'interact',
    ]);
  });

  it('narrows to what the client asked for, never beyond the ceiling', () => {
    const params = { token: TOKEN, protocolVersion: PROTOCOL_VERSION, client };
    expect(authenticator.authenticate({ ...params, capabilities: ['observe'] })).toEqual(['observe']);
    expect(authenticator.authenticate({ ...params, capabilities: ['observe', 'eval'] })).toEqual(['observe']);
  });

  it.each(['wrong', 'secret-token-123457', 'secret-token-1234567'])('rejects token %j', (token) => {
    expect(() => authenticator.authenticate({ token, protocolVersion: PROTOCOL_VERSION, client })).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });

  it('rejects incompatible protocol versions', () => {
    expect(() => authenticator.authenticate({ token: TOKEN, protocolVersion: '99.0.0', client })).toThrow(
      expect.objectContaining({ code: 'VERSION_MISMATCH' }),
    );
  });
});
