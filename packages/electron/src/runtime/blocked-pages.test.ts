import { BridgeError, ok } from '@eab/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncWaits } from '../ipc/sync-waits.js';
import { BLOCKED_AFTER_MS, BLOCKED_ANYWAY_MS, guardBlockedPages } from './blocked-pages.js';

type Loose = Record<string, ((input: unknown) => unknown) | undefined>;

/** A page whose renderer answers a probe, or hangs like one blocked on sendSync. */
function page(id: string, name: string, kind = 'window') {
  const state = { answers: false, detached: false, probes: 0 };
  const transport = {
    send: () => {
      state.probes++;
      if (state.detached) return Promise.reject(new Error('Debugger is not attached'));
      return state.answers ? Promise.resolve({}) : new Promise(() => undefined);
    },
  };
  return { target: { id, name, kind: kind as 'window', transport }, state };
}

function setup(handlers: Loose) {
  let clock = 0;
  const main = page('wc1', 'main');
  const confirm = page('wc2', 'confirm');
  const pages = [main.target, confirm.target, { id: 'sw1', name: 'sw', kind: 'serviceWorker' as const }];
  const targets = {
    resolve: vi.fn((selector?: string) => {
      const found =
        selector === undefined ? pages[0] : pages.find((p) => p.id === selector || p.name === selector);
      if (!found) throw new Error('not found');
      return found;
    }),
    list: () => pages,
  };
  const waits = new SyncWaits(() => clock);
  const guarded = guardBlockedPages(handlers, { waits, targets, now: () => clock }) as Loose;
  return {
    waits,
    main: main.state,
    targets,
    /** The guarded handler's outcome: its value, or the error it failed with. */
    call: async (method: string, input: unknown = {}): Promise<unknown> => {
      const handler = guarded[method];
      if (handler === undefined) throw new Error(`no ${method}`);
      try {
        return await handler(input);
      } catch (error) {
        return error;
      }
    },
    advance: async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

function blocked(outcome: unknown): BridgeError {
  expect(outcome).toBeInstanceOf(BridgeError);
  const error = outcome as BridgeError;
  expect(error.code).toBe('TIMEOUT');
  return error;
}

const hang = () => new Promise(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('guardBlockedPages', () => {
  it('passes calls through while the page is responsive, and leaves other methods alone', async () => {
    const { call, waits } = setup({
      'snapshot.take': () => ok({ text: 'x' }),
      'ipc.query': () => ok({ items: [] }),
    });
    // A quick sendSync in flight is not a block.
    waits.begin('wc1', 'settings:get');
    expect(await call('snapshot.take')).toEqual(ok({ text: 'x' }));
    expect(await call('ipc.query')).toEqual(ok({ items: [] }));
  });

  it('refuses a page blocked while a dialog window is open, without running, naming the channel', async () => {
    const run = vi.fn(() => ok({}));
    const { call, waits, advance } = setup({ 'action.run': run });
    waits.begin('wc1', 'dialog:confirm');
    waits.noteOpened();
    await advance(BLOCKED_AFTER_MS + 500);
    const pending = call('action.run', { target: 'main' });
    await advance(400);
    const error = blocked(await pending);
    expect(run).not.toHaveBeenCalled();
    expect(error.message).toContain(
      'ipcRenderer.sendSync("dialog:confirm") (1.9 s so far). action.run was not run.',
    );
    expect(error.hint).toContain('Other targets: confirm (wc2).');
  });

  it('fails a call that the page stops answering partway, saying it may have taken effect', async () => {
    const { call, waits, advance } = setup({ 'action.run': hang });
    const pending = call('action.run');
    // The click opened a dialog: the page now waits on the app's reply.
    waits.begin('wc1', 'dialog:confirm');
    waits.noteOpened();
    await advance(BLOCKED_AFTER_MS + 500);
    expect(blocked(await pending).message).toMatch(
      /"main" \(wc1\) stopped responding: .* may already have taken effect/,
    );
  });

  it('lets a slow sync handler without a dialog finish, and only gives up after the long limit', async () => {
    let answer: (() => void) | undefined;
    const { call, waits, advance } = setup({
      'snapshot.take': () =>
        new Promise((resolve) => {
          answer = () => {
            resolve(ok({ text: 'late' }));
          };
        }),
      'action.run': hang,
    });
    const end = waits.begin('wc1', 'db:read');
    const slow = call('snapshot.take');
    await advance(BLOCKED_AFTER_MS * 2);
    end();
    answer?.();
    expect(await slow).toEqual(ok({ text: 'late' }));
    waits.begin('wc1', 'db:read');
    const stuck = call('action.run');
    await advance(BLOCKED_ANYWAY_MS + 500);
    expect(blocked(await stuck).message).toContain('sendSync("db:read")');
  });

  it('drops waits of a page that still answers (a reply the wrappers did not see) and runs the call', async () => {
    const { call, waits, main, advance } = setup({ 'snapshot.take': () => ok({ text: 'x' }) });
    waits.begin('wc1', 'never:answered');
    waits.noteOpened();
    await advance(BLOCKED_ANYWAY_MS);
    main.answers = true;
    expect(await call('snapshot.take')).toEqual(ok({ text: 'x' }));
    expect(waits.oldest('wc1')).toBeUndefined();
    expect(main.probes).toBe(1);
  });

  it('stands aside when the probe cannot be sent (debugger detached): no evidence the page is stuck', async () => {
    const { call, waits, main, advance } = setup({ 'snapshot.take': () => ok({ text: 'x' }) });
    waits.begin('wc1', 'stale');
    await advance(BLOCKED_ANYWAY_MS);
    main.detached = true;
    expect(await call('snapshot.take')).toEqual(ok({ text: 'x' }));
  });

  it('looks a named target up only once some page waits', async () => {
    const { call, waits, targets, advance } = setup({ 'action.run': hang });
    const pending = call('action.run', { target: 'main' });
    await advance(500);
    expect(targets.resolve).not.toHaveBeenCalled();
    waits.begin('wc1', 'dialog:confirm');
    waits.noteOpened();
    await advance(BLOCKED_AFTER_MS + 500);
    expect(blocked(await pending).message).toContain('"main" (wc1) stopped responding');
    expect(targets.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps errors and results of the handler, and lets an ipc wait.for through', async () => {
    const { call, waits, advance } = setup({
      'dom.find': () => Promise.reject(new Error('boom')),
      'wait.for': () => ok({ met: true }),
    });
    expect(await call('dom.find')).toEqual(new Error('boom'));
    waits.begin('wc1', 'dialog:confirm');
    await advance(BLOCKED_ANYWAY_MS * 2);
    expect(await call('wait.for', { condition: { kind: 'ipc', channel: 'x' } })).toEqual(ok({ met: true }));
    // An unknown target is the handler's to report.
    expect(await call('wait.for', { target: 'nope', condition: { kind: 'text' } })).toEqual(
      ok({ met: true }),
    );
  });
});
