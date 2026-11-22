import { describe, expect, it } from 'vitest';

import { ConsoleCollector } from '../observe/console-collector.js';
import { LogBook } from '../observe/log-book.js';
import { NetworkLog } from '../observe/network-log.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { TargetRegistry } from '../targets/target-registry.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { FakeClock } from '../testing/fake-clock.js';
import { queryLogs, queryNetwork } from './record-queries.js';

function setup() {
  const clock = new FakeClock();
  const page = new FakeCdpTransport()
    .handle('Runtime.enable', () => ({}))
    .handle('Network.enable', () => ({}));
  const pages: TargetDescriptor[] = [
    {
      id: 'wc1',
      kind: 'window',
      title: 'Settings',
      url: 'file:///settings.html',
      focused: true,
      transport: page,
      nameHint: 'settings',
    },
  ];
  const logs = new LogBook();
  const console = new ConsoleCollector(logs, clock);
  const network = new NetworkLog(clock);
  console.watch('wc1', page);
  network.watch('wc1', page);
  const deps = { targets: new TargetRegistry({ list: () => pages }), logs, console, network };
  return { deps, page, logs };
}

describe('record queries', () => {
  it('logs: starts capture on the first query, names pages, filters by page name or a closed page’s id', async () => {
    const { deps, logs } = setup();
    logs.add({ source: 'renderer', level: 'info', text: 'here', target: 'wc1' });
    logs.add({ source: 'renderer', level: 'info', text: 'closed page', target: 'wc9' });
    logs.add({ source: 'main', level: 'error', text: 'main' });
    const first = await queryLogs(deps, {});
    expect(first.data.items.map((entry) => entry.target)).toEqual(['settings', 'wc9', undefined]);
    expect(first.limitations.map((limitation) => limitation.code)).toEqual(['partial']);
    const second = await queryLogs(deps, {
      target: 'settings',
      minLevel: 'info',
      source: 'renderer',
      contains: 'here',
      since: 0,
      limit: 5,
    });
    expect(second.data.items.map((entry) => entry.text)).toEqual(['here']);
    expect(second.limitations).toEqual([]);
    expect((await queryLogs(deps, { target: 'wc9' })).data.items.map((entry) => entry.text)).toEqual([
      'closed page',
    ]);
  });

  it('network: starts recording on the first query and reports requests still in flight', async () => {
    const { deps, page } = setup();
    const first = await queryNetwork(deps, {});
    expect(first.limitations.map((limitation) => limitation.message)).toEqual([
      expect.stringContaining('started with this query'),
    ]);
    page.emit({
      method: 'Network.requestWillBeSent',
      params: { requestId: '1', request: { url: 'http://h/a', method: 'POST' }, timestamp: 1, wallTime: 1 },
    });
    page.emit({
      method: 'Network.requestWillBeSent',
      params: { requestId: '2', request: { url: 'http://h/b', method: 'GET' }, timestamp: 1, wallTime: 1 },
    });
    page.emit({
      method: 'Network.loadingFailed',
      params: { requestId: '2', timestamp: 2, errorText: 'net::ERR_CONNECTION_REFUSED' },
    });
    const second = await queryNetwork(deps, {
      target: 'settings',
      url: 'http://h/*',
      failedOnly: false,
      since: 0,
      limit: 10,
    });
    expect(second.data.items).toMatchObject([
      { target: 'settings', url: 'http://h/b', failed: 'net::ERR_CONNECTION_REFUSED' },
    ]);
    expect(second.limitations.map((limitation) => limitation.message)).toEqual([
      '1 request(s) still in flight are listed once they finish.',
    ]);
  });
});
