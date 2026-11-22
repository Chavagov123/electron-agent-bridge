import { afterEach, describe, expect, it } from 'vitest';

import { registerState } from './renderer.js';

const STATE = Symbol.for('electron-agent-bridge.v1.state');
const PENDING = Symbol.for('electron-agent-bridge.v1.state-pending');
const page = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  Reflect.deleteProperty(page, STATE);
  Reflect.deleteProperty(page, PENDING);
});

describe('registerState', () => {
  it('registers with the hook when it is there', () => {
    const registered: string[] = [];
    page[STATE] = {
      register: (name: string) => {
        registered.push(name);
        return () => registered.splice(registered.indexOf(name), 1);
      },
    };
    const undo = registerState('cart', { getState: () => ({}) });
    expect(registered).toEqual(['cart']);
    undo();
    expect(registered).toEqual([]);
  });

  it('queues stores until the hook runs (bounded), and unregistering removes them from the queue', () => {
    const undo = registerState('early', {});
    registerState('kept', {});
    const queue = page[PENDING] as { name: string }[];
    expect(queue.map((entry) => entry.name)).toEqual(['early', 'kept']);
    undo();
    expect(queue.map((entry) => entry.name)).toEqual(['kept']);
    for (let index = 0; index < 60; index++) registerState(`s${index}`, {});
    expect(queue).toHaveLength(50);
  });

  it('never throws, whatever the hook does', () => {
    page[STATE] = {
      register: () => {
        throw new Error('broken');
      },
    };
    expect(() => {
      registerState('x', {})();
    }).not.toThrow();
  });
});
