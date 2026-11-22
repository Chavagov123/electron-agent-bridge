import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  connect,
  flowFromRecording,
  parseFlow,
  runFlow,
  stringifyFlow,
  type BridgeClient,
} from '@electron-agent-bridge/client';
import { handshakeFileName, type RecordedEvent } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('recording flows on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function connected(bridge = true): Promise<{ bridge: BridgeClient; app: LaunchedFixture }> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-basic',
      electron,
      mode: bridge ? mode : 'integrated',
      env: { ...endpoint.env, ...(bridge ? { EAB_ENABLE: '1' } : {}) },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return { bridge: client, app };
  }

  it('leaves the page’s handling of user input as without the bridge recording', async () => {
    endpoint = isolatedEndpoint();
    const off = await launchFixture({
      fixture: 'app-basic',
      electron,
      mode: 'integrated',
      env: endpoint.env,
    });
    const without = (await off.command('user-order')).result;
    await off.dispose();
    endpoint.cleanup();
    const { bridge, app: launched } = await connected();
    await bridge.call('record.start', {});
    expect((await launched.command('user-order')).result).toEqual(without);
    expect(without).toContain('Grace');
  });

  it('records what a user does and what an agent runs, and replays it as a flow', async () => {
    const { bridge, app: launched } = await connected();
    const started = await bridge.call('record.start', {});
    await launched.command('user-order');
    await bridge.call('action.run', {
      actions: [{ type: 'click', locator: { ref: await refOf(bridge, 'Orders') } }],
    });
    let events: RecordedEvent[] = [];
    await waitFor(
      async () => {
        events = (await bridge.call('record.events', { since: started.data.nextSeq - 1 })).data.items;
        return events.length >= 4;
      },
      { what: 'four recorded actions' },
    );
    await bridge.call('record.stop', {});
    expect(events.map(({ source, action }) => ({ source, action }))).toEqual([
      {
        source: 'user',
        action: { type: 'fill', locator: { role: 'textbox', name: 'Customer', exact: true }, value: 'Grace' },
      },
      {
        source: 'user',
        action: { type: 'check', locator: { role: 'checkbox', name: 'Gift wrap', exact: true } },
      },
      {
        source: 'user',
        action: { type: 'click', locator: { role: 'button', name: 'Save order', exact: true } },
      },
      { source: 'agent', action: { type: 'click', locator: { role: 'link', name: 'Orders', exact: true } } },
    ]);
    expect(events[0]?.target).toBe('app-basic');

    // The recording as a flow file, run against a fresh page: the order is placed again.
    const { flow } = flowFromRecording(events, { name: 'Recorded order' });
    const parsed = parseFlow(stringifyFlow(flow));
    await launched.command('reload');
    const result = await runFlow(
      {
        ...parsed,
        steps: [...parsed.steps, { expect: { element: { text: 'Grace x1' }, state: 'visible' } }],
      },
      { client: bridge },
    );
    expect(result.steps.map((step) => [step.status, step.error?.message])).toEqual(
      result.steps.map(() => ['passed', undefined]),
    );
  });
});

async function refOf(bridge: BridgeClient, name: string): Promise<string> {
  const found = await bridge.call('dom.find', { locator: { role: 'link', name, exact: true } });
  const ref = found.data.matches[0]?.ref;
  if (ref === undefined) throw new Error(`no link ${name}`);
  return ref;
}
