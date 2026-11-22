import { afterEach, describe, expect, it } from 'vitest';

import { api, callText, calls, closeClient, connectedClient, fakeClient } from '../testing/mcp-harness.js';

afterEach(closeClient);

const NO_OBSERVATIONS = { dialogs: [], toasts: [], consoleErrors: [], failedRequests: [], ipc: [] };

function actResponse(data: Record<string, unknown>, limitations: unknown[] = []) {
  return { data: { observations: NO_OBSERVATIONS, ...data }, limitations, untrusted: true };
}

async function connectedWith(overrides: Record<string, unknown>) {
  const client = await connectedClient({ ...api, connect: () => Promise.resolve(fakeClient(overrides)) });
  await callText(client, 'session', { action: 'connect' });
  calls.length = 0;
  return client;
}

describe('act tool', () => {
  it('renders steps, what the app did and the page changes, all page text untrusted', async () => {
    const client = await connectedWith({
      'action.run': actResponse({
        steps: [
          { type: 'fill', ok: true, timings: { actionMs: 12.4, settleMs: 50 } },
          { type: 'click', ok: true, timings: { actionMs: 8, settleMs: 120 } },
        ],
        observations: {
          ...NO_OBSERVATIONS,
          dialogs: ['dialog "Confirm"'],
          toasts: ['Order saved'],
          consoleErrors: ['TypeError: x is undefined'],
          failedRequests: ['GET https://api/x 500'],
          navigation: { url: 'file:///next.html' },
        },
        delta: '+ - status "Order saved" [e40]',
        cursor: 'c7',
      }),
    });
    const result = await callText(client, 'act', {
      actions: [
        { type: 'fill', locator: { ref: 'e3' }, value: 'Ada' },
        { type: 'click', locator: { role: 'button', name: 'Save' } },
      ],
      timeoutMs: 1000,
    });
    expect(calls[0]?.params).toEqual({
      actions: [
        { type: 'fill', locator: { ref: 'e3' }, value: 'Ada' },
        { type: 'click', locator: { role: 'button', name: 'Save' } },
      ],
      timeoutMs: 1000,
    });
    expect(result.text).toBe(
      [
        '1. ✓ fill (12.4 ms, settled 50 ms)',
        '2. ✓ click (8 ms, settled 120 ms)',
        '',
        'What happened:',
        '<untrusted-page-content>',
        'dialog opened: dialog "Confirm"',
        'message shown: "Order saved"',
        'console error: TypeError: x is undefined',
        'request failed: GET https://api/x 500',
        'navigated to: file:///next.html',
        '</untrusted-page-content>',
        '',
        'Page changes:',
        '<untrusted-page-content>',
        '+ - status "Order saved" [e40]',
        '</untrusted-page-content>',
      ].join('\n'),
    );
  });

  it('renders a failed step with its code and hint, and says when nothing changed', async () => {
    const client = await connectedWith({
      'action.run': actResponse(
        {
          steps: [
            {
              type: 'click',
              ok: false,
              error: { code: 'DISABLED', message: 'button "Archive" is disabled', hint: 'Wait for it.' },
              timings: { actionMs: 5000, settleMs: 0 },
            },
          ],
          delta: '',
        },
        [{ code: 'untrusted-input', message: 'used a JS fallback' }],
      ),
    });
    const result = await callText(client, 'act', {
      target: 'main',
      continueOnError: true,
      actions: [{ type: 'click', locator: { ref: 'e8' } }],
    });
    expect(calls[0]?.params).toMatchObject({ target: 'main', continueOnError: true });
    expect(result.text).toBe(
      '1. ✗ click: [DISABLED] button "Archive" is disabled\n   Hint: Wait for it.\n\n' +
        'Page: no visible changes.\n\nLimitations:\n- untrusted-input: used a JS fallback',
    );
  });

  it('continues changes-only snapshots from after the actions', async () => {
    const client = await connectedWith({
      'action.run': actResponse({
        steps: [{ type: 'press', ok: true, timings: { actionMs: 1, settleMs: 1 } }],
        cursor: 'c9',
      }),
    });
    expect((await callText(client, 'act', { actions: [{ type: 'press', key: 'Enter' }] })).text).toBe(
      '1. ✓ press (1 ms, settled 1 ms)',
    );
    await callText(client, 'snapshot', { changesOnly: true });
    expect(calls[1]).toEqual({ method: 'snapshot.take', params: { mode: 'delta', since: 'c9' } });
  });

  it('rejects an empty action list', async () => {
    const client = await connectedWith({});
    expect((await callText(client, 'act', { actions: [] })).isError).toBe(true);
  });
});

describe('wait_for tool', () => {
  it('reports how long it waited and what it saw', async () => {
    const client = await connectedWith({
      'wait.for': { data: { elapsedMs: 212.6, observed: '1 match(es), 1 visible' }, limitations: [] },
    });
    const result = await callText(client, 'wait_for', {
      condition: { kind: 'text', text: 'Saved' },
      timeoutMs: 3000,
      target: 'main',
    });
    expect(calls[0]).toEqual({
      method: 'wait.for',
      params: { condition: { kind: 'text', text: 'Saved' }, timeoutMs: 3000, target: 'main' },
    });
    expect(result.text).toBe(
      'Condition met after 213 ms.\n<untrusted-page-content>\n1 match(es), 1 visible\n</untrusted-page-content>',
    );
  });

  it('omits the observation block when there is none', async () => {
    const client = await connectedWith({ 'wait.for': { data: { elapsedMs: 0 }, limitations: [] } });
    expect((await callText(client, 'wait_for', { condition: { kind: 'networkIdle' } })).text).toBe(
      'Condition met after 0 ms.',
    );
  });
});
