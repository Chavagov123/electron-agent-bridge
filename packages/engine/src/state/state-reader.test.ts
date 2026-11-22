import { describe, expect, it } from 'vitest';

import { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { FakeClock } from '../testing/fake-clock.js';
import { Waiter } from '../wait/waiter.js';
import { StateHookInstaller } from './state-hook-installer.js';
import { StateReader } from './state-reader.js';

function pageAnswering(answer: (expression: string) => unknown) {
  const transport = new FakeCdpTransport().handle('Runtime.evaluate', (params) => {
    const { expression } = params as { expression: string };
    return answer(expression);
  });
  const target: TargetDescriptor = {
    id: 'wc1',
    kind: 'window',
    title: 't',
    url: 'u',
    focused: true,
    transport,
  };
  return { transport, target };
}

const value = (result: unknown) => ({ result: { value: result } });
const stores = [{ name: 'session', kind: 'redux', actions: 2 }];

describe('StateReader', () => {
  it('reads through the page registry, redacting what the page returned', async () => {
    let asked = '';
    const { target } = pageAnswering((expression) => {
      asked = expression;
      return value({ stores, store: 'session', value: { user: 'ann', token: 'abc' }, truncated: false });
    });
    const result = await new StateReader().read(target, { store: 'session', path: 'user' });
    expect(asked).toContain('Symbol.for("electron-agent-bridge.v1.state")');
    expect(asked).toContain('registry.read({"store":"session","path":"user"})');
    expect(result.data).toEqual({
      stores,
      store: 'session',
      value: { user: 'ann', token: '[redacted]' },
      truncated: false,
    });
    expect(result.limitations.map((limitation) => limitation.code)).toEqual(['redacted']);
  });

  it('reports a page without hook as empty with a limitation, and refuses to dispatch there', async () => {
    const { target } = pageAnswering(() => value(null));
    const reader = new StateReader();
    const read = await reader.read(target, {});
    expect(read.data).toEqual({ stores: [], value: null, truncated: false });
    expect(read.limitations[0]?.message).toContain('no state hook');
    await expect(reader.dispatch(target, { action: { type: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('turns failures the page reports, page exceptions and detached pages into BridgeErrors', async () => {
    const reader = new StateReader();
    const unsupported = pageAnswering(() =>
      value({ error: { code: 'UNSUPPORTED', message: 'no actions', hint: 'h' } }),
    );
    await expect(reader.dispatch(unsupported.target, { action: {} })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      hint: 'h',
    });
    const forged = pageAnswering(() =>
      value({ stores: new Array(51).fill({ name: 'x', kind: 'redux' }), value: 1, truncated: false }),
    );
    await expect(reader.read(forged.target, {})).rejects.toMatchObject({ code: 'INTERNAL' });
    const odd = pageAnswering(() => value({ error: { code: 'WHATEVER', message: 'odd' } }));
    await expect(reader.read(odd.target, {})).rejects.toMatchObject({ code: 'INTERNAL' });
    const thrown = pageAnswering(() => ({ result: {}, exceptionDetails: { text: 'Uncaught' } }));
    await expect(reader.read(thrown.target, {})).rejects.toMatchObject({ code: 'INTERNAL' });
    const ok = pageAnswering(() => value({ dispatched: true }));
    expect((await reader.dispatch(ok.target, { action: { type: 'go' } })).data).toEqual({ dispatched: true });
    ok.transport.detach('host-debugger');
    await expect(reader.read(ok.target, {})).rejects.toMatchObject({ code: 'DETACHED' });
  });
});

describe('state waits', () => {
  it('waits until the value at a path equals the expected one, ignoring key order', async () => {
    let reads = 0;
    const { target } = pageAnswering(() => {
      reads++;
      // First a page without stores (null would equal `equals: null`), then the store appears.
      if (reads === 1) return value(null);
      return value({ stores, store: 'cart', value: reads < 3 ? { a: 1 } : { b: 2, a: 1 }, truncated: false });
    });
    const waiter = new Waiter({
      pool: new AgentPool({ source: '', version: 'test' }),
      clock: new FakeClock(),
      state: new StateReader(),
    });
    const result = await waiter.waitFor(target, {
      condition: { kind: 'state', store: 'cart', path: 'x', equals: { a: 1, b: 2 } },
    });
    expect(result.data.observed).toBe('x = {"a":1,"b":2}');
    await expect(
      new Waiter({ pool: new AgentPool({ source: '', version: 'test' }), clock: new FakeClock() }).waitFor(
        target,
        {
          condition: { kind: 'state', path: 'x', equals: 1 },
        },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('StateHookInstaller', () => {
  it('registers the hook (with the Page domain) now and on every fresh session, never on a detached page', () => {
    const transport = new FakeCdpTransport();
    const installer = new StateHookInstaller('hook()');
    const watching = installer.watch(transport);
    transport.reattach();
    const posted = transport.calls.filter((call) => call.posted).map((call) => call.method);
    expect(posted).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    expect(transport.calls[1]?.params).toEqual({ source: 'hook()', runImmediately: true });
    watching.dispose();
    transport.detach('host-debugger');
    installer.install(transport);
    expect(transport.calls).toHaveLength(4);
  });
});
