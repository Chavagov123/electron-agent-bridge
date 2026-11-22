import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { versionModes } from '../harness/modes.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type FixtureName, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

/** `role "name" [eN]` → name by ref, for comparing two snapshots of the same page. */
function namesByRef(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of text.matchAll(/- ([\w-]+) ("(?:[^"\\]|\\.)*") \[(e\d+)\]/g)) {
    names.set(match[3] ?? '', JSON.parse(match[2] ?? '""') as string);
  }
  return names;
}

describe.each(versionModes())('page agent snapshots on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function connected(fixture: FixtureName): Promise<{ bridge: BridgeClient; app: LaunchedFixture }> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture,
      electron,
      mode,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return { bridge: client, app };
  }

  it('lives in an isolated world the page cannot see, with stable refs', async () => {
    const { bridge, app: launched } = await connected('app-basic');
    const first = (await bridge.call('snapshot.take', {})).data;
    const second = (await bridge.call('snapshot.take', {})).data;
    expect(second.text).toBe(first.text);
    expect(first.text).toMatch(/button "Save order" \[e\d+\]/);
    expect(await launched.command('main-world-sees-agent')).toMatchObject({ ok: true, result: false });
  });

  it('reports value changes without DOM mutations, and new content, as deltas', async () => {
    const { bridge, app: launched } = await connected('app-basic');
    const base = (await bridge.call('snapshot.take', {})).data;
    await launched.command('type-customer');
    await launched.command('show-toast');
    const delta = (await bridge.call('snapshot.take', { mode: 'delta', since: base.cursor ?? '' })).data;
    expect(delta.kind).toBe('delta');
    expect(delta.text).toMatch(/^~ +- textbox "Customer" \[e\d+\]: "Ann"$/m);
    expect(delta.text).toMatch(/^\+ +- text "Saved"$/m);
    const quiet = (await bridge.call('snapshot.take', { mode: 'delta', since: delta.cursor ?? '' })).data;
    expect(quiet.kind).toBe('unchanged');
  });

  it('starts over after a reload: old cursors give a full snapshot with a reason', async () => {
    const { bridge, app: launched } = await connected('app-basic');
    const base = (await bridge.call('snapshot.take', {})).data;
    await launched.command('reload');
    const after = await bridge.call('snapshot.take', { mode: 'delta', since: base.cursor ?? '' });
    expect(after.data.kind).toBe('full');
    expect(after.limitations.map((limitation) => limitation.code)).toContain('full-snapshot');
    expect(after.data.text).toMatch(/button "Save order" \[e\d+\]/);
  });

  it('finds elements and zooms into one by ref', async () => {
    const { bridge } = await connected('app-basic');
    const found = await bridge.call('dom.find', { locator: { role: 'button', name: 'save' } });
    expect(found.data.matches.map((match) => match.name)).toEqual(['Save order']);
    const form = await bridge.call('dom.find', { locator: { role: 'form' } });
    const ref = form.data.matches[0]?.ref ?? '';
    const scoped = (await bridge.call('snapshot.take', { root: { ref } })).data.text;
    expect(scoped.split('\n')[0]).toBe(`- form "New order" [${ref}]`);
    expect(scoped).not.toMatch(/navigation "Primary"/);
  });

  it.each(['app-basic', 'app-multi'] as const)(
    'on %s, accessible names match Chromium for at least 95% of elements across all pages',
    async (fixture) => {
      const { bridge } = await connected(fixture);
      let compared = 0;
      const mismatches: string[] = [];
      for (const target of (await bridge.call('targets.list', {})).data.targets) {
        const dom = namesByRef((await bridge.call('snapshot.take', { target: target.id })).data.text);
        const ax = namesByRef(
          (await bridge.call('snapshot.take', { target: target.id, fidelity: 'ax' })).data.text,
        );
        for (const [ref, name] of dom) {
          if (!ax.has(ref)) continue;
          compared++;
          if (ax.get(ref) !== name)
            mismatches.push(
              `${target.name}/${ref}: ${JSON.stringify(name)} vs ${JSON.stringify(ax.get(ref))}`,
            );
        }
      }
      expect(compared).toBeGreaterThan(5);
      const agreement = (compared - mismatches.length) / compared;
      expect(agreement, `mismatches: ${mismatches.join('; ')}`).toBeGreaterThanOrEqual(0.95);
    },
  );
});
