// @vitest-environment happy-dom
import { AGENT_SOURCE, AGENT_VERSION } from '@electron-agent-bridge/page-agent';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActionEngine } from '../action/action-engine.js';
import { AgentPool } from '../page/agent-pool.js';
import { Screenshotter } from '../page/screenshotter.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { AgentSnapshotter } from '../snapshot/agent-snapshotter.js';
import { TargetRegistry } from '../targets/target-registry.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakePage } from '../testing/fake-page.js';
import { Waiter } from '../wait/waiter.js';
import { EngineFacade } from './engine-facade.js';

const bundle = { source: AGENT_SOURCE, version: AGENT_VERSION };

function target(
  id: string,
  focused: boolean,
  transport: FakeCdpTransport = new FakePage(bundle),
): TargetDescriptor {
  return { id, kind: 'window', title: id, url: `file:///app/${id}.html`, focused, transport };
}

function engineOver(targets: TargetDescriptor[]): EngineFacade {
  const pool = new AgentPool(bundle);
  const clock = new FakeClock();
  return new EngineFacade({
    targets: new TargetRegistry({ list: () => targets }),
    snapshotter: new AgentSnapshotter(pool),
    actions: new ActionEngine({ pool, clock }),
    waiter: new Waiter({ pool, clock }),
    screenshots: new Screenshotter(pool),
  });
}

beforeEach(() => {
  document.title = 'Page';
  document.body.innerHTML = '<h1>Orders</h1><button>Save</button>';
});

describe('EngineFacade', () => {
  it('lists targets with names and attachment state', () => {
    const detached = new FakeCdpTransport();
    detached.detach('host-debugger');
    expect(
      engineOver([target('wc1', false), target('wc2', true, detached)]).listTargets().data.targets,
    ).toEqual([
      { id: 'wc1', name: 'wc1', kind: 'window', title: 'wc1', url: 'file:///app/wc1.html', attached: true },
      {
        id: 'wc2',
        name: 'wc2',
        kind: 'window',
        title: 'wc2',
        url: 'file:///app/wc2.html',
        attached: false,
        detachedReason: 'host-debugger',
      },
    ]);
  });

  it('snapshots the focused window by default, by name on request, untrusted, with a cursor', async () => {
    const engine = engineOver([target('wc1', false), target('wc2', true)]);
    const result = await engine.snapshot({});
    expect(result.data).toMatchObject({ target: 'wc2', kind: 'full', title: 'Page' });
    expect(result.data.text).toBe('- heading "Orders" [e1] level=1\n- button "Save" [e2]');
    expect(result.data.cursor).toMatch(/^\w+\.\d+$/);
    expect(result.untrusted).toBe(true);
    expect((await engine.snapshot({ target: 'WC1' })).data.target).toBe('wc1');
  });

  it('returns deltas against a cursor and explains full fallbacks', async () => {
    const engine = engineOver([target('wc1', true)]);
    const first = await engine.snapshot({});
    expect((await engine.snapshot({ mode: 'delta', since: first.data.cursor })).data.kind).toBe('unchanged');
    document.body.insertAdjacentHTML('beforeend', '<a href="#">Next</a>');
    const second = await engine.snapshot({ mode: 'delta', since: first.data.cursor });
    // One agent serves the whole file (installed once per page), so ref numbers continue between tests.
    expect(second.data.kind).toBe('delta');
    expect(second.data.text).toMatch(/^\+ - link "Next" \[e\d+\]$/);
    const unknown = await engine.snapshot({ mode: 'delta', since: 'gone.1' });
    expect(unknown.limitations.map((limitation) => limitation.code)).toEqual(['full-snapshot']);
  });

  it('reports truncation, collapsed lists and capped output as limitations', async () => {
    document.body.innerHTML = `<ul aria-label="L">${'<li>x</li>'.repeat(40)}</ul>`;
    const result = await engineOver([target('wc1', true)]).snapshot({ maxLines: 5 });
    expect(result.limitations.map((limitation) => limitation.code)).toEqual(['truncated']);
    const collapsed = await engineOver([target('wc1', true)]).snapshot({});
    expect(collapsed.limitations[0]?.message).toContain('20 items of long lists were collapsed');
  });

  it('uses names from the accessibility tree with fidelity ax', async () => {
    const page = new FakePage(bundle);
    page.axNamesByText.set('Save', 'Save the order');
    const result = await engineOver([target('wc1', true, page)]).snapshot({ fidelity: 'ax' });
    expect(result.data.text).toContain('button "Save the order"');
    expect(page.calls.some((call) => call.method === 'Accessibility.enable' && call.posted)).toBe(true);
  });

  it('fetches accessibility-tree names for the snapshot root only, keeping agent names on failures', async () => {
    document.body.innerHTML =
      '<nav aria-label="N"><a href="#">Out</a></nav><main><button>Save</button></main>';
    const page = new FakePage(bundle);
    page.axNamesByText.set('Out', 'Outside');
    page.axNamesByText.set('Save', 'Save the order');
    const engine = engineOver([target('wc1', true, page)]);
    const main = (await engine.find({ locator: { role: 'main' } })).data.matches[0]?.ref ?? '';
    const scoped = await engine.snapshot({ fidelity: 'ax', root: { ref: main } });
    expect(scoped.data.text).toContain('button "Save the order"');
    expect(scoped.data.text).not.toContain('Out');
    page.handle('Accessibility.getPartialAXTree', () => {
      throw new Error('node gone');
    });
    expect((await engine.snapshot({ fidelity: 'ax' })).data.text).toContain('button "Save"');
  });

  it('finds elements and reports when more matched than returned', async () => {
    document.body.innerHTML = '<button>A</button><button>B</button><button>C</button>';
    const result = await engineOver([target('wc1', true)]).find({ locator: { role: 'button' }, limit: 2 });
    expect(result.data.total).toBe(3);
    expect(result.data.matches.map((match) => match.name)).toEqual(['A', 'B']);
    expect(result.limitations[0]?.message).toBe('Showing 2 of 3 matches.');
  });

  it('explains why a detached target cannot be snapshotted', async () => {
    const transport = new FakeCdpTransport();
    transport.detach('host-debugger');
    await expect(engineOver([target('wc1', true, transport)]).snapshot({})).rejects.toMatchObject({
      code: 'DETACHED',
      hint: expect.stringContaining('re-attaches when the app detaches') as unknown,
    });
  });
});
