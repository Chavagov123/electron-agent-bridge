import type { Action } from '@electron-agent-bridge/core';
import { describe, expect, it } from 'vitest';

import { agentWith, run, targetInfo } from '../testing/action-fixtures.js';
import { AgentCode, FakeAgentPage, type ScriptedAgent } from '../testing/fake-agent-page.js';

const mouse = (page: FakeAgentPage): string[] =>
  page.sent('Input.dispatchMouseEvent').map((event) => (event as { type: string }).type);

describe('ActionEngine', () => {
  it('clicks with trusted mouse events and reports timings, observations and the delta', async () => {
    const page = new FakeAgentPage(agentWith());
    const result = await run(page, [
      { type: 'click', locator: { ref: 'e1' }, clickCount: 2, modifiers: ['Shift'] },
    ]);
    expect(mouse(page)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mousePressed',
      'mouseReleased',
    ]);
    expect(page.sent('Input.dispatchMouseEvent')[2]).toMatchObject({
      x: 100,
      y: 50,
      clickCount: 1,
      modifiers: 8,
    });
    expect(result.data.steps).toEqual([
      {
        type: 'click',
        ok: true,
        timings: { actionMs: 0, settleMs: 12 },
        resolved: [{ ref: 'e1', role: 'button', name: 'Save' }],
      },
    ]);
    expect(result.data.delta).toBe('+ - text "Saved"');
    expect(result.untrusted).toBe(true);
    expect(page.calls.some((call) => call.method === 'Emulation.setFocusEmulationEnabled')).toBe(true);
  });

  it('posts every input event but the last, and reads the page once per step', async () => {
    const page = new FakeAgentPage(agentWith());
    await run(page, [{ type: 'click', locator: { ref: 'e1' }, clickCount: 2 }]);
    const mouse = page.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((call) => call.posted)).toEqual([true, true, true, true, false]);
    const agentCalls = page
      .sent('Runtime.evaluate')
      .map((call) => /__eab\.(\w+)\(/.exec((call as { expression: string }).expression)?.[1]);
    expect(agentCalls.filter((name) => name === 'live')).toHaveLength(1);
    expect(agentCalls.filter((name) => name === 'settle')).toHaveLength(1);
    expect(agentCalls).not.toContain('quiet');
  });

  it('waits for the element to become actionable, then acts', async () => {
    let attempts = 0;
    const page = new FakeAgentPage(
      agentWith({
        actionTarget: () => {
          attempts++;
          if (attempts < 3) throw new AgentCode('HIDDEN', 'the element is not visible');
          return targetInfo();
        },
      }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e1' } }]);
    expect(attempts).toBe(3);
    expect(result.data.steps[0]).toMatchObject({ ok: true, timings: { actionMs: 100 } });
  });

  it.each([
    ['HIDDEN', 'Open whatever reveals the element'],
    ['DISABLED', 'Fill in what the form requires'],
    ['OCCLUDED', 'Close the overlay'],
    ['OFF_SCREEN', 'Scroll its container'],
    ['NOT_FOUND', 'Take a fresh snapshot'],
    ['DETACHED', 'removed while acting'],
  ])('reports %s with a hint once the timeout passes', async (code, hint) => {
    const page = new FakeAgentPage(
      agentWith({
        actionTarget: () => {
          throw new AgentCode(code, `problem ${code}`);
        },
      }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e1' } }], { timeoutMs: 200 });
    expect(result.data.steps[0]).toMatchObject({ ok: false, error: { code, message: `problem ${code}` } });
    expect(result.data.steps[0]?.error?.hint).toContain(hint);
    expect(result.data.steps[0]?.timings.actionMs).toBeGreaterThanOrEqual(200);
  });

  it('reports a still-moving element as TIMEOUT, and fails at once on AMBIGUOUS or STALE_REF', async () => {
    const moving = new FakeAgentPage(
      agentWith({
        actionTarget: () => {
          throw new AgentCode('UNSTABLE', 'the element is still moving');
        },
      }),
    );
    expect(
      (await run(moving, [{ type: 'click', locator: { ref: 'e1' } }], { timeoutMs: 100 })).data.steps[0]
        ?.error?.code,
    ).toBe('TIMEOUT');
    for (const code of ['AMBIGUOUS', 'STALE_REF']) {
      let attempts = 0;
      const page = new FakeAgentPage(
        agentWith({
          actionTarget: () => {
            attempts++;
            throw new AgentCode(code);
          },
        }),
      );
      const result = await run(page, [{ type: 'click', locator: { role: 'button' } }]);
      expect(result.data.steps[0]?.error?.code).toBe(code);
      expect(attempts).toBe(1);
    }
  });

  it('stops at the first failure unless continueOnError', async () => {
    const failing = (): ScriptedAgent =>
      agentWith({
        actionTarget: (...args: never[]) => {
          const locator = args[0] as unknown as { ref?: string };
          if (locator.ref === 'e9') throw new AgentCode('STALE_REF');
          return targetInfo();
        },
      });
    const actions: Action[] = [
      { type: 'click', locator: { ref: 'e9' } },
      { type: 'click', locator: { ref: 'e1' } },
    ];
    expect((await run(new FakeAgentPage(failing()), actions)).data.steps).toHaveLength(1);
    const all = await run(new FakeAgentPage(failing()), actions, { continueOnError: true });
    expect(all.data.steps.map((step) => step.ok)).toEqual([false, true]);
  });

  it('reports each element a step acted on, once, and nothing for steps without a locator', async () => {
    const page = new FakeAgentPage(
      agentWith({
        actionTarget: (...args: never[]) => {
          const locator = args[0] as unknown as { ref: string };
          return targetInfo({ ref: locator.ref, name: locator.ref.toUpperCase() });
        },
      }),
    );
    const result = await run(page, [
      { type: 'drag', from: { ref: 'e2' }, to: { ref: 'e3' } },
      { type: 'press', key: 'Enter' },
    ]);
    expect(result.data.steps[0]?.resolved).toEqual([
      { ref: 'e2', role: 'button', name: 'E2' },
      { ref: 'e3', role: 'button', name: 'E3' },
    ]);
    expect(result.data.steps[1]).not.toHaveProperty('resolved');
  });

  it('notes when a stale ref was healed', async () => {
    const page = new FakeAgentPage(
      agentWith({ actionTarget: () => targetInfo({ ref: 'e30', healed: true }) }),
    );
    const result = await run(page, [{ type: 'click', locator: { ref: 'e12' } }]);
    expect(result.limitations[0]?.message).toContain('e12 was stale; acted on e30');
  });

  it('reports each step’s toast even when the next step replaces it in the same region', async () => {
    let clicks = 0;
    const page = new FakeAgentPage(
      agentWith({
        live: () => ({ regions: clicks === 0 ? {} : { e5: `toast ${clicks}` }, dialogs: [] }),
        actionTarget: () => {
          clicks++;
          return targetInfo();
        },
      }),
    );
    const click: Action = { type: 'click', locator: { ref: 'e1' } };
    const result = await run(page, [click, click, click]);
    expect(result.data.observations.toasts).toEqual(['toast 1', 'toast 2', 'toast 3']);
  });

  it('collects console errors, failed requests, navigation, toasts and dialogs caused by the actions', async () => {
    let afterAction = false;
    const page = new FakeAgentPage(
      agentWith({
        live: () =>
          afterAction
            ? { regions: { e5: 'Order saved', e6: 'unchanged' }, dialogs: ['alertdialog "Delete?"'] }
            : { regions: { e6: 'unchanged' }, dialogs: [] },
        actionTarget: () => {
          afterAction = true;
          page.emit({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'error', args: [{ value: 'boom' }] },
          });
          page.emit({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'log', args: [{ value: 'fine' }] },
          });
          page.emit({
            method: 'Runtime.exceptionThrown',
            params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x' } } },
          });
          page.emit({
            method: 'Network.requestWillBeSent',
            params: { requestId: 'r1', request: { url: 'https://api/a' } },
          });
          page.emit({
            method: 'Network.loadingFailed',
            params: { requestId: 'r1', errorText: 'net::ERR_FAILED' },
          });
          page.emit({
            method: 'Network.responseReceived',
            params: { requestId: 'r2', response: { url: 'https://api/b', status: 500 } },
          });
          page.emit({ method: 'Page.frameNavigated', params: { frame: { url: 'file:///next.html' } } });
          page.emit({
            method: 'Page.frameNavigated',
            params: { frame: { url: 'about:blank', parentId: 'main' } },
          });
          return targetInfo();
        },
      }),
    );
    const { observations } = (await run(page, [{ type: 'click', locator: { ref: 'e1' } }])).data;
    expect(observations).toEqual({
      dialogs: ['alertdialog "Delete?"'],
      toasts: ['Order saved'],
      consoleErrors: ['boom', 'TypeError: x'],
      failedRequests: ['net::ERR_FAILED https://api/a', '500 https://api/b'],
      ipc: [],
      navigation: { url: 'file:///next.html' },
    });
    expect(page.calls.filter((call) => call.method === 'Network.enable')).toHaveLength(1);
  });

  it('skips the delta when asked and reports a full snapshot when the page changed too much', async () => {
    const page = new FakeAgentPage(agentWith());
    const quiet = await run(page, [{ type: 'click', locator: { ref: 'e1' } }], { delta: false });
    expect(quiet.data.delta).toBeUndefined();
    const full = new FakeAgentPage(
      agentWith({
        snapshot: () => ({
          kind: 'full',
          cursor: 'c',
          text: '- main',
          lineCount: 1,
          truncated: false,
          collapsed: 0,
          crossOriginFrames: 0,
          url: '',
          title: '',
        }),
      }),
    );
    expect((await run(full, [{ type: 'click', locator: { ref: 'e1' } }])).data.delta).toContain(
      'full snapshot',
    );
  });
});
