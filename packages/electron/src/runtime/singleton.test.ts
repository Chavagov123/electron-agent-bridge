import { afterEach, describe, expect, it } from 'vitest';

import { claimRuntime, existingRuntime, releaseRuntime } from './singleton.js';

describe('runtime singleton', () => {
  const first = { name: 'first' };
  afterEach(() => {
    releaseRuntime(first);
  });

  it('lets exactly one copy claim the slot', () => {
    expect(claimRuntime(first)).toBe(true);
    expect(claimRuntime({ name: 'second' })).toBe(false);
    expect(existingRuntime()).toBe(first);
  });

  it('is shared through a global symbol and is not enumerable', () => {
    claimRuntime(first);
    const registry = globalThis as unknown as Record<symbol, unknown>;
    expect(registry[Symbol.for('electron-agent-bridge.v1.runtime')]).toBe(first);
    expect(Object.keys(globalThis)).not.toContain('electron-agent-bridge.v1.runtime');
  });

  it('only the owner can release', () => {
    claimRuntime(first);
    releaseRuntime({ name: 'other' });
    expect(existingRuntime()).toBe(first);
    releaseRuntime(first);
    expect(existingRuntime()).toBeUndefined();
  });
});
