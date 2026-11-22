import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName, type Action } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { versionModes } from '../harness/modes.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { waitFor } from '../harness/wait.js';

const button = (name: string) => ({ role: 'button', name, exact: true });

/** All limitation messages of a result, one per line. */
const notes = (result: { limitations: readonly { message: string }[] }): string =>
  result.limitations.map((limitation) => limitation.message).join('\n');

describe.each(versionModes())(
  'actions, waits and observations on Electron %s (%s mode)',
  (electron, mode) => {
    let endpoint: IsolatedEndpoint | undefined;
    let app: LaunchedFixture | undefined;
    let client: BridgeClient | undefined;
    let mcp: McpTestClient | undefined;
    let scratch: string | undefined;

    afterEach(async () => {
      await mcp?.close();
      client?.close();
      await app?.dispose();
      endpoint?.cleanup();
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      [mcp, client, app, endpoint, scratch] = [undefined, undefined, undefined, undefined, undefined];
    });

    /** The app, ready for clients, with the path of its handshake file. */
    async function launched(): Promise<{ app: LaunchedFixture; handshake: string }> {
      endpoint = isolatedEndpoint();
      app = await launchFixture({
        fixture: 'app-basic',
        electron,
        mode,
        env: { ...endpoint.env, EAB_ENABLE: '1' },
      });
      const handshake = join(endpoint.directory, handshakeFileName(app.pid));
      await waitFor(() => existsSync(handshake), { what: 'handshake file' });
      return { app, handshake };
    }

    async function connected(): Promise<{ bridge: BridgeClient; app: LaunchedFixture }> {
      const { app: started, handshake } = await launched();
      client = await connect({ handshakePath: handshake });
      return { bridge: client, app: started };
    }

    const act = (
      bridge: BridgeClient,
      actions: Action[],
      extra: { timeoutMs?: number; continueOnError?: boolean } = {},
    ) => bridge.call('action.run', { actions, ...extra });

    it('fills a form with trusted input and reports the toast and the new row', async () => {
      const { bridge } = await connected();
      const result = await act(bridge, [
        { type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Ada' },
        { type: 'fill', locator: { role: 'spinbutton', name: 'Quantity' }, value: '3' },
        { type: 'select', locator: { role: 'combobox', name: 'Priority' }, values: ['High'] },
        { type: 'check', locator: { role: 'radio', name: 'Courier' } },
        { type: 'check', locator: { role: 'checkbox', name: 'Gift wrap' } },
        { type: 'type', locator: { role: 'textbox', name: 'Notes', exact: true }, text: 'Ring twice' },
        { type: 'click', locator: button('Save order') },
      ]);
      const { steps, observations, delta } = result.data;
      expect(steps.map((step) => [step.type, step.ok, step.error?.code])).toEqual([
        ['fill', true, undefined],
        ['fill', true, undefined],
        ['select', true, undefined],
        ['check', true, undefined],
        ['check', true, undefined],
        ['type', true, undefined],
        ['click', true, undefined],
      ]);
      expect(observations.toasts).toContain('Order saved');
      expect(delta).toContain('Ada x3 (high, courier)');
      for (const step of steps) expect(step.timings.settleMs).toBeLessThanOrEqual(600);
      const state = (await bridge.call('snapshot.take', {})).data.text;
      expect(state).toMatch(/checkbox "Gift wrap" \[e\d+\] checked/);
      expect(state).toMatch(/textbox "Notes" \[e\d+\].*: "Ring twice"/);
    });

    it('presses shortcuts, opens and answers an in-page dialog', async () => {
      const { bridge } = await connected();
      const saved = await act(bridge, [
        { type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Bo' },
        { type: 'press', key: 'Control+S' },
      ]);
      expect(saved.data.observations.toasts).toContain('Order saved');
      const opened = await act(bridge, [{ type: 'click', locator: button('Delete…') }]);
      expect(opened.data.observations.dialogs).toEqual(['alertdialog "Delete order?"']);
      const answered = await act(bridge, [{ type: 'click', locator: button('Yes, delete') }]);
      expect(answered.data.observations.toasts).toContain('Order deleted');
      expect(answered.data.delta).toMatch(/^- /m);
    });

    it('uploads files, drags cards, scrolls to far elements and reports console and load failures', async () => {
      const { bridge } = await connected();
      scratch = mkdtempSync(join(tmpdir(), 'eab-upload-'));
      const file = join(scratch, 'invoice.txt');
      writeFileSync(file, 'hello');
      const result = await act(bridge, [
        { type: 'upload', locator: { css: '#attachment' }, files: [file] },
        { type: 'drag', from: { role: 'listitem', name: 'Card A' }, to: { role: 'list', name: 'Done' } },
        { type: 'click', locator: button('Far button') },
        { type: 'scroll', deltaY: -5000 },
        { type: 'click', locator: button('Break things') },
      ]);
      expect(result.data.steps.every((step) => step.ok)).toBe(true);
      const { toasts, consoleErrors, failedRequests } = result.data.observations;
      expect(toasts).toEqual(expect.arrayContaining(['Attached invoice.txt', 'Card moved', 'Far clicked']));
      expect(consoleErrors.some((error) => error.includes('fixture failure'))).toBe(true);
      expect(failedRequests.some((request) => request.includes('missing-image.png'))).toBe(true);
      expect(notes(result)).toContain('synthetic drag');
    });

    it('fails each step with a precise code and a hint', async () => {
      const { bridge } = await connected();
      const result = await act(
        bridge,
        [
          { type: 'click', locator: button('Archive') },
          { type: 'click', locator: { text: 'No such thing anywhere' } },
          { type: 'click', locator: { role: 'radio' } },
          { type: 'click', locator: { css: '#confirm-yes' } },
          { type: 'click', locator: button('Covered') },
          { type: 'click', locator: { ref: 'e9999' } },
          { type: 'fill', locator: button('Save order'), value: 'x' },
          { type: 'press', key: 'Hyper+Q' },
        ],
        { timeoutMs: 300, continueOnError: true },
      );
      expect(result.data.steps.map((step) => step.error?.code)).toEqual([
        'DISABLED',
        'NOT_FOUND',
        'AMBIGUOUS',
        'HIDDEN',
        'OCCLUDED',
        'STALE_REF',
        'INVALID_PARAMS',
        'INVALID_PARAMS',
      ]);
      for (const step of result.data.steps) expect(step.error?.hint ?? step.error?.message).toBeTruthy();
      expect(result.data.steps[4]?.error?.message).toContain('Busy overlay');
    });

    it('heals a stale ref when the element is re-created', async () => {
      const { bridge, app: launched } = await connected();
      const before =
        (await bridge.call('dom.find', { locator: button('Save order') })).data.matches[0]?.ref ?? '';
      await launched.command('rerender-save');
      const result = await act(bridge, [
        { type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Cy' },
        { type: 'click', locator: { ref: before } },
      ]);
      expect(result.data.steps.every((step) => step.ok)).toBe(true);
      expect(result.data.observations.toasts).toContain('Order saved');
      expect(notes(result)).toContain('was stale');
    });

    it('waits for conditions and explains timeouts', async () => {
      const { bridge, app: launched } = await connected();
      await launched.command('show-toast-later');
      const shown = await bridge.call('wait.for', {
        condition: { kind: 'text', text: 'Later' },
        timeoutMs: 5000,
      });
      expect(shown.data.elapsedMs).toBeGreaterThan(0);
      const idle = await bridge.call('wait.for', { condition: { kind: 'networkIdle', idleMs: 100 } });
      expect(idle.data.observed).toMatch(/0 request\(s\) in flight/);
      await expect(
        bridge.call('wait.for', {
          condition: { kind: 'element', locator: { role: 'alertdialog' }, state: 'visible' },
          timeoutMs: 300,
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('last:') as unknown });
    });

    it('acts through MCP with readable step results', async () => {
      // No direct client: the MCP session must be the controller to act.
      const { app: started } = await launched();
      mcp = await startMcpClient(endpoint!.env);
      await mcp.call('session', { action: 'connect', pid: started.pid });
      const result = await mcp.call('act', {
        actions: [
          { type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Dee' },
          { type: 'click', locator: button('Save order') },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/^1\. ✓ fill \(/);
      expect(result.text).toContain('message shown: "Order saved"');
      const changes = await mcp.call('snapshot', { changesOnly: true });
      expect(changes.text).toContain('no changes since the last snapshot');
      const waited = await mcp.call('wait_for', { condition: { kind: 'text', text: 'Order saved' } });
      expect(waited.text).toMatch(/^Condition met after \d+ ms\./);
    });
  },
);
