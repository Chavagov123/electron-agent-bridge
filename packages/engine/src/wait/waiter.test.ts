import type { WaitCondition } from '@eab/core';
import { describe, expect, it } from 'vitest';

import { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { FakeAgentPage } from '../testing/fake-agent-page.js';
import { FakeClock } from '../testing/fake-clock.js';
import { Waiter } from './waiter.js';

const bundle = { source: 'install()', version: 'test' };

function setup(check: () => unknown) {
  const page = new FakeAgentPage({ check });
  const clock = new FakeClock();
  const waiter = new Waiter({ pool: new AgentPool(bundle), clock });
  const target: TargetDescriptor = {
    id: 'wc1',
    kind: 'window',
    title: '',
    url: '',
    focused: true,
    transport: page,
  };
  return {
    page,
    clock,
    wait: (condition: WaitCondition, timeoutMs?: number) =>
      waiter.waitFor(target, { condition, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
  };
}

describe('Waiter', () => {
  it('returns as soon as the condition holds, with what was observed', async () => {
    let polls = 0;
    const { wait } = setup(() => {
      polls++;
      return { met: polls >= 3, observed: `poll ${polls}` };
    });
    const result = await wait({ kind: 'element', locator: { role: 'dialog' } });
    expect(result.data).toEqual({ elapsedMs: 200, observed: 'poll 3' });
  });

  it('times out with the last observation and a hint', async () => {
    const { wait } = setup(() => ({ met: false, observed: '2 match(es), 0 visible, 0 enabled' }));
    await expect(
      wait({ kind: 'element', locator: { text: 'Saved' }, state: 'visible' }, 500),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('(last: 2 match(es), 0 visible, 0 enabled)') as unknown,
      hint: expect.stringContaining('raise timeoutMs') as unknown,
    });
  });

  it('keeps polling through agent failures (navigation) until the deadline', async () => {
    let polls = 0;
    const { wait } = setup(() => {
      polls++;
      if (polls < 3) throw new Error('context gone');
      return { met: true, observed: 'url is file:///next' };
    });
    expect((await wait({ kind: 'url', contains: 'next' })).data.observed).toBe('url is file:///next');
  });

  it('waits for the network to be idle', async () => {
    const { page, wait, clock } = setup(() => ({ met: false, observed: '' }));
    const pending = wait({ kind: 'networkIdle', idleMs: 300 }, 5_000);
    page.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'r1' } });
    clock.advance(1);
    page.emit({ method: 'Network.loadingFinished', params: { requestId: 'r1' } });
    const result = await pending;
    expect(result.data.observed).toMatch(/^0 request\(s\) in flight, quiet for \d+ ms$/);
    expect(page.calls.some((call) => call.method === 'Network.enable')).toBe(true);
  });

  it('reports network activity on timeout and leaves no listener behind', async () => {
    const { page, wait } = setup(() => ({ met: false, observed: '' }));
    const pending = wait({ kind: 'networkIdle' }, 300);
    page.emit({ method: 'Network.requestWillBeSent', params: { requestId: 'r1' } });
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('1 request(s) in flight') as unknown,
    });
  });

  it('says when network monitoring only started with the wait, and not once it was already on', async () => {
    const { page, wait } = setup(() => ({ met: false, observed: '' }));
    const first = wait({ kind: 'networkIdle', idleMs: 0 });
    // Neither progress events nor malformed ones count as activity.
    page.emit({ method: 'Network.dataReceived', params: { requestId: 'r9' } });
    page.emit({ method: 'Network.requestWillBeSent', params: {} });
    const result = await first;
    expect(result.data.observed).toMatch(/^0 request\(s\) in flight/);
    expect(result.limitations[0]?.message).toContain('requests already running before it were not seen');
    const second = await wait({ kind: 'networkIdle', idleMs: 0 });
    expect(second.limitations).toEqual([]);
  });

  it('describes each condition kind in its timeout', async () => {
    const { wait } = setup(() => ({ met: false, observed: 'x' }));
    const timeouts: [Parameters<typeof wait>[0], string][] = [
      [{ kind: 'text', text: 'Saved', present: false }, 'text "Saved" absent'],
      [{ kind: 'text', text: 'Saved' }, 'text "Saved" present'],
      [{ kind: 'url', contains: '/done' }, 'url containing "/done"'],
      [{ kind: 'element', locator: { role: 'dialog' } }, 'element {"role":"dialog"} visible'],
    ];
    for (const [condition, described] of timeouts) {
      await expect(wait(condition, 0)).rejects.toMatchObject({
        message: expect.stringContaining(`${described} not met within 0 ms`) as unknown,
      });
    }
    await expect(wait({ kind: 'networkIdle' }, 0)).rejects.toMatchObject({
      message: expect.stringContaining('network idle for 500 ms') as unknown,
    });
  });

  it('waits for an IPC message on a channel glob, advancing past skipped messages', async () => {
    const page = new FakeAgentPage({});
    const clock = new FakeClock();
    const reads: number[] = [];
    const pages = [
      // Only internal traffic: nothing returned, but the cursor moves on.
      { items: [], nextSeq: 6 },
      { items: [{ seq: 7, channel: 'other', kind: 'send' }], nextSeq: 7 },
      { items: [{ seq: 8, channel: 'late:handler', kind: 'invoke' }], nextSeq: 8 },
    ];
    const feed = {
      lastSeq: () => 1,
      since: (seq: number) => {
        reads.push(seq);
        return pages.shift() ?? { items: [], nextSeq: seq };
      },
    };
    const waiter = new Waiter({ pool: new AgentPool(bundle), clock, ipc: feed });
    const target: TargetDescriptor = {
      id: 'wc1',
      kind: 'window',
      title: '',
      url: '',
      focused: true,
      transport: page,
    };
    const result = await waiter.waitFor(target, { condition: { kind: 'ipc', channel: 'late:*' } });
    expect(result.data.observed).toBe('invoke on "late:handler" (#8)');
    expect(reads).toEqual([1, 6, 7]);
    const never = new Waiter({
      pool: new AgentPool(bundle),
      clock,
      ipc: { lastSeq: () => 0, since: (seq: number) => ({ items: [], nextSeq: seq }) },
    });
    await expect(
      never.waitFor(target, { condition: { kind: 'ipc', channel: 'x' }, timeoutMs: 0 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining(
        'an IPC message on "x" not met within 0 ms (last: 0 other message(s), none on "x")',
      ) as unknown,
    });
  });

  it('answers UNSUPPORTED for state, and for ipc when the runtime records no IPC', async () => {
    const { wait } = setup(() => ({ met: true, observed: '' }));
    await expect(wait({ kind: 'ipc', channel: 'save' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: 'this runtime does not record IPC',
    });
    await expect(wait({ kind: 'state', path: 'a', equals: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});
