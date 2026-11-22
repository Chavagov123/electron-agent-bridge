import { describe, expect, it } from 'vitest';

import { AgentPool } from '../page/agent-pool.js';
import { FakeClock } from '../testing/fake-clock.js';
import { ActionEngine } from './action-engine.js';
import { agentWith, bundle, run, targetInfo } from '../testing/action-fixtures.js';
import { AgentCode, FakeAgentPage } from '../testing/fake-agent-page.js';

describe('ActionEngine resilience', () => {
  it('keeps the step results when the page is gone afterwards, with a note instead of the delta', async () => {
    let snapshots = 0;
    const page = new FakeAgentPage(
      agentWith({
        snapshot: () => {
          snapshots++;
          if (snapshots > 1) throw new AgentCode('INTERNAL', 'the window closed');
          return { kind: 'full', cursor: 'c1', text: '', lineCount: 0 };
        },
      }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e1' } }]);
    expect(result.data.steps.map((step) => step.ok)).toEqual([true]);
    expect(result.data.delta).toBeUndefined();
    expect(result.limitations[0]?.message).toMatch(/Page changes unavailable: .*the window closed.*did run/);
  });

  it('subscribes to page events only after reading the page, so replayed console messages are ignored', async () => {
    let reads = 0;
    const page = new FakeAgentPage(
      agentWith({
        live: () => {
          // What Runtime.enable replays during the agent bootstrap (the first call on the page).
          if (reads++ === 0)
            page.emit({
              method: 'Runtime.consoleAPICalled',
              params: { type: 'error', args: [{ value: 'old' }] },
            });
          return { regions: {}, dialogs: [] };
        },
      }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e1' } }], { delta: false });
    expect(result.data.observations.consoleErrors).toEqual([]);
  });

  it('fails at once with the reason when the page itself detaches, instead of waiting out the timeout', async () => {
    let calls = 0;
    const page = new FakeAgentPage(
      agentWith({
        actionTarget: () => {
          calls++;
          page.detach('host-debugger');
          throw new AgentCode('DETACHED', 'debugger not attached');
        },
      }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e1' } }], { delta: false });
    expect(calls).toBe(1);
    expect(result.data.steps[0]?.error).toMatchObject({
      code: 'DETACHED',
      message: expect.stringContaining('host-debugger') as unknown,
      hint: expect.stringContaining('webContents.debugger') as unknown,
    });
  });

  it('uploads to hidden file inputs: only presence and enabled are required', async () => {
    const seen: unknown[] = [];
    const page = new FakeAgentPage(
      agentWith({
        actionTarget: (...args: never[]) => {
          seen.push(args[1]);
          return targetInfo({ inputType: 'file', x: 0, y: 0 });
        },
      }),
    );
    await run(page, [{ type: 'upload', locator: { css: '#file' }, files: ['/tmp/a.txt'] }]);
    expect(seen).toEqual([{ enabled: true, hitTest: false, visible: false }]);
    expect(page.sent('DOM.setFileInputFiles')).toEqual([{ files: ['/tmp/a.txt'], objectId: 'obj-1' }]);
  });

  it('emulates focus while automating and restores it on release', async () => {
    const page = new FakeAgentPage(agentWith());
    const pool = new AgentPool(bundle);
    const focus = () => page.sent('Emulation.setFocusEmulationEnabled');
    await run(page, [{ type: 'click', locator: { ref: 'e1' } }], {}, pool);
    await run(page, [{ type: 'click', locator: { ref: 'e1' } }], {}, pool);
    expect(focus()).toEqual([{ enabled: true }]);
    pool.release();
    pool.release();
    expect(focus()).toEqual([{ enabled: true }, { enabled: false }]);
    // Automating again turns it back on.
    await run(page, [{ type: 'click', locator: { ref: 'e1' } }], {}, pool);
    expect(focus()).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]);
    page.detach('target-closed');
    pool.release();
    expect(focus()).toHaveLength(3);
  });

  it('reports the IPC the actions caused, from the feed position taken at the start', async () => {
    const messages = [{ seq: 4, channel: 'math:add', kind: 'invoke' }];
    // The position moves on while the action runs; the observer must read from where it started.
    const positions = [3, 9];
    const reads: number[] = [];
    const feed = {
      lastSeq: () => positions.shift() ?? 9,
      since: (seq: number) => {
        reads.push(seq);
        return { items: messages, nextSeq: 4 };
      },
    };
    const page = new FakeAgentPage(agentWith());
    const engine = new ActionEngine({ pool: new AgentPool(bundle), clock: new FakeClock(), ipc: feed });
    const target = { id: 'wc1', kind: 'window' as const, title: '', url: '', focused: true, transport: page };
    const result = await engine.run(target, {
      actions: [{ type: 'click', locator: { ref: 'e1' } }],
      delta: false,
    });
    expect(reads).toEqual([3]);
    expect(result.data.observations.ipc).toEqual(messages);
  });
});
