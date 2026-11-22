import { describe, expect, it } from 'vitest';

import { evaluateGate } from './gate.js';

describe('evaluateGate', () => {
  it('is off unless EAB_ENABLE=1', () => {
    expect(evaluateGate({ env: {}, isPackaged: false, allowPackaged: false }).enabled).toBe(false);
    expect(
      evaluateGate({ env: { EAB_ENABLE: 'true' }, isPackaged: false, allowPackaged: false }).enabled,
    ).toBe(false);
    expect(evaluateGate({ env: { EAB_ENABLE: '1' }, isPackaged: false, allowPackaged: false }).enabled).toBe(
      true,
    );
  });

  it('stays off in packaged apps unless the app opted in through code', () => {
    const env = { EAB_ENABLE: '1' };
    expect(evaluateGate({ env, isPackaged: true, allowPackaged: false })).toMatchObject({ enabled: false });
    expect(evaluateGate({ env, isPackaged: true, allowPackaged: true }).enabled).toBe(true);
  });

  it('honours the kill switch', () => {
    const env = { EAB_ENABLE: '1', EAB_DISABLE: '1' };
    expect(evaluateGate({ env, isPackaged: false, allowPackaged: true }).enabled).toBe(false);
  });
});
