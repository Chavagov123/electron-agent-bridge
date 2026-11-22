import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

/**
 * Snapshot performance on a ~5000-element page (NFR4), measured end to end from the client: socket,
 * runtime, CDP and the in-page agent. The targets (in-page, ADR-0007) are full ≤150 ms and delta ≤20 ms p95;
 * the assertions here are looser ceilings for shared CI machines, and the numbers are printed.
 */
describe.each(selectedVersions())('snapshot performance on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const started = performance.now();
    const value = await run();
    return { ms: performance.now() - started, value };
  }

  function p95(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  }

  it('full and delta snapshots of a 5000-element page stay fast', async () => {
    endpoint = isolatedEndpoint();
    app = await launchFixture({ fixture: 'app-heavy', electron, env: { ...endpoint.env, EAB_ENABLE: '1' } });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    const bridge = client;
    const elements = (await app.command('count-elements')).result as number;
    expect(elements).toBeGreaterThan(4000);

    // Cold: the first snapshot installs the agent and walks the whole page with an empty cache.
    const cold = await timed(() => bridge.call('snapshot.take', { maxLines: 20_000 }));

    // Main-process event-loop delay while the snapshots and mutations below run.
    await app.command('loop-delay-reset');
    const full: number[] = [];
    for (let run = 0; run < 5; run++) {
      full.push((await timed(() => bridge.call('snapshot.take', { maxLines: 20_000 }))).ms);
    }
    let cursor = (await bridge.call('snapshot.take', { maxLines: 20_000 })).data.cursor ?? '';
    const delta: number[] = [];
    for (let run = 0; run < 10; run++) {
      await app.command(run % 2 === 0 ? 'mutate-10' : 'mutate-100');
      const result = await timed(() =>
        bridge.call('snapshot.take', { maxLines: 20_000, mode: 'delta', since: cursor }),
      );
      expect(result.value.data.kind).toBe('delta');
      cursor = result.value.data.cursor ?? '';
      delta.push(result.ms);
    }
    // Actions on the big page: a click, waiting for actionability and settling, no snapshot delta.
    const actions: number[] = [];
    for (let run = 0; run < 10; run++) {
      const clicked = await timed(() =>
        bridge.call('action.run', {
          actions: [{ type: 'click', locator: { role: 'button', name: `Edit ${run * 7}`, exact: true } }],
          delta: false,
        }),
      );
      expect(clicked.value.data.steps[0]?.ok).toBe(true);
      actions.push(clicked.ms);
    }
    const loop = (await app.command('loop-delay')).result as { p99: number; max: number };
    const report = {
      actionP95: Math.round(p95(actions)),
      elements,
      mainLoopDelayP99Ms: Math.round(loop.p99),
      mainLoopDelayMaxMs: Math.round(loop.max),
      coldMs: Math.round(cold.ms),
      fullP95: Math.round(p95(full)),
      deltaP95: Math.round(p95(delta)),
    };
    process.stdout.write(`[perf] Electron ${electron}: ${JSON.stringify(report)}\n`);
    // Local runs gate on the budgets; shared CI runners only record, with a guard against
    // gross regressions.
    const slack = process.env['CI'] === 'true' ? 4 : 1;
    expect(report.fullP95).toBeLessThan(1_000 * slack);
    expect(report.deltaP95).toBeLessThan(400 * slack);
    expect(report.coldMs).toBeLessThan(5_000 * slack);
    // Settling alone waits 50 ms of quiet; the rest is locating, actionability and input.
    expect(report.actionP95).toBeLessThan(600 * slack);
    // Snapshots are computed in the page: the app's main process keeps responding.
    expect(report.mainLoopDelayP99Ms).toBeLessThan(50 * slack);
  });

  it('keeps the main process responsive through IPC and console floods', async () => {
    const flood = async (fixture: 'app-ipc' | 'app-logs', command: string, bridge: boolean) => {
      endpoint = isolatedEndpoint();
      app = await launchFixture({
        fixture,
        electron,
        env: { ...endpoint.env, ...(bridge ? { EAB_ENABLE: '1' } : {}) },
      });
      if (bridge) {
        const handshake = join(endpoint.directory, handshakeFileName(app.pid));
        await waitFor(() => existsSync(handshake), { what: 'handshake file' });
        client = await connect({ handshakePath: handshake });
        // Everything on: console, network and IPC recording, and a reader paging through it.
        await client.call('logs.query', {});
        await client.call('network.query', {});
      }
      await app.command('loop-delay-reset');
      for (let run = 0; run < 3; run++) {
        await app.command(command);
        await client?.call(fixture === 'app-ipc' ? 'ipc.query' : 'logs.query', { limit: 500 });
      }
      const loop = (await app.command('loop-delay')).result as { p99: number; max: number };
      client?.close();
      await app.dispose();
      endpoint.cleanup();
      [client, app, endpoint] = [undefined, undefined, undefined];
      return { p99: Math.round(loop.p99), max: Math.round(loop.max) };
    };
    // What the bridge adds: the same flood with the bridge off is the app's own cost.
    const report = {
      ipcOff: await flood('app-ipc', 'flood', false),
      ipc: await flood('app-ipc', 'flood', true),
      logsOff: await flood('app-logs', 'burst', false),
      logs: await flood('app-logs', 'burst', true),
    };
    process.stdout.write(`[perf] Electron ${electron} floods: ${JSON.stringify(report)}
`);
    const slack = process.env['CI'] === 'true' ? 4 : 1;
    // ADR-0010: with the in-process debugger, Electron alone adds ~170 ms delivering 24,000 console events
    // to main; the bridge's own work on top is bounded by the console rate cap. Single stalls are noisy,
    // so these are ceilings against regressions, and the numbers are printed.
    expect(report.ipc.p99 - report.ipcOff.p99).toBeLessThan(600 * slack);
    expect(report.logs.p99 - report.logsOff.p99).toBeLessThan(600 * slack);
  });
});
