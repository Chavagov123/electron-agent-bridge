import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { connect, launch } from '@electron-agent-bridge/client';
import { handshakeFileName } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BinaryUnavailable, fusedElectron, packagedElectron } from '../harness/binaries.js';
import { electronBinary, selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture, type LaunchOptions } from '../harness/launch-fixture.js';
import { eabBinPath, startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { countProcesses, isAlive, killProcessTree } from '../harness/process-tree.js';
import { waitFor } from '../harness/wait.js';

const run = promisify(execFile);
const appBasic = dirname(createRequire(import.meta.url).resolve('@eab-fixtures/app-basic/package.json'));

interface LaunchEnv {
  nodeOptions: string | null;
  bridgeVariables: string[];
  inspectorUrl: string | null;
  isPackaged: boolean;
}

describe.each(selectedVersions())('Launch mode on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let mcp: McpTestClient | undefined;
  const pids: number[] = [];

  afterEach(async () => {
    await mcp?.close();
    await app?.dispose();
    for (const pid of pids.splice(0)) killProcessTree(pid);
    endpoint?.cleanup();
    [mcp, app, endpoint] = [undefined, undefined, undefined];
  });

  async function launched(extra: Partial<LaunchOptions> = {}): Promise<LaunchedFixture> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-basic',
      electron,
      mode: 'launch',
      env: endpoint.env,
      ...extra,
    });
    return app;
  }

  it.each(['node-options', 'inspector'] as const)(
    'starts an unmodified app via %s and leaves no trace in it',
    async (strategy) => {
      const started = await launched({ strategy });
      const env = (await started.command('launch-env')).result as LaunchEnv;
      // Children of the app inherit nothing of the bridge, and no debug port stays open.
      expect(env).toEqual({ nodeOptions: null, bridgeVariables: [], inspectorUrl: null, isPackaged: false });
      const client = await connect({
        handshakePath: join(endpoint!.directory, handshakeFileName(started.pid)),
      });
      expect((await client.call('snapshot.take', {})).data.text).toMatch(/button "Save order" \[e\d+\]/);
      client.close();
      await started.dispose();
      expect(isAlive(started.pid)).toBe(false);
    },
  );

  // Packaged apps ignore NODE_OPTIONS, so the launcher spawns the app twice (node-options, then the
  // inspector): fixture commands go to the process that reported ready, not to the killed attempt.
  it('refuses a packaged build unless allowPackaged, then works in it', async () => {
    const executable = packagedElectron(electron);
    await expect(launched({ executable })).rejects.toMatchObject({
      code: 'NOT_ENABLED',
      hint: expect.stringContaining('--allow-packaged') as unknown,
    });
    // Helpers (GPU, utility) are reaped a little after the main process.
    await waitFor(() => countProcesses(basename(executable)) === 0, {
      what: 'the refused attempt to exit',
    });
    endpoint?.cleanup();
    const started = await launched({ executable, allowPackaged: true });
    // A freshly copied binary can start slowly on Windows CI (virus scanning): allow it time.
    expect(((await started.command('launch-env', 30_000)).result as LaunchEnv).isPackaged).toBe(true);
  });

  it('diagnoses a binary whose fuses block both strategies from the binary, without starting it', async (context) => {
    let executable: string;
    try {
      executable = await fusedElectron(electron);
    } catch (error) {
      // E.g. Electron 35's npm bundle on macOS cannot be re-signed after flipping its fuses.
      if (error instanceof BinaryUnavailable) {
        process.stderr.write(`[launch] fused Electron ${electron} unavailable: ${error.message}\n`);
        context.skip();
      }
      throw error;
    }
    endpoint = isolatedEndpoint();
    const attempt = launch({
      executable,
      args: [appBasic],
      env: { ...endpoint.env, EAB_FIXTURE_MODE: 'launch' },
      allowPackaged: true,
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      // Read from the binary before launching: nothing is started, the cause is definite.
      message: expect.stringMatching(
        /node-options: not tried: the EnableNodeOptionsEnvironmentVariable fuse.*inspector: not tried: the EnableNodeCliInspectArguments fuse/s,
      ) as unknown,
      hint: expect.stringContaining("import '@electron-agent-bridge/electron/register'") as unknown,
    });
    await waitFor(() => countProcesses(basename(executable)) === 0, { what: 'blocked attempts to exit' });
  }, 60_000);

  it('launches through MCP and closes the app with the session', async () => {
    endpoint = isolatedEndpoint();
    mcp = await startMcpClient({ ...endpoint.env, EAB_FIXTURE_MODE: 'launch' });
    const result = await mcp.call('session', {
      action: 'launch',
      executable: electronBinary(electron),
      args: [appBasic],
    });
    expect(result.text).toMatch(/^Launched pid \d+ \(bridge injected via node-options\)\.\nApp: /);
    const pid = Number(/pid (\d+)/.exec(result.text)?.[1]);
    pids.push(pid);
    // The bridge is up before the app opens its first window: wait for the page like an agent would.
    const client = mcp;
    await waitFor(
      async () =>
        (await client.call('find', { role: 'button', name: 'Save order' })).text.includes('1 match(es)'),
      {
        what: 'the launched app’s page',
      },
    );
    await mcp.call('session', { action: 'close' });
    await waitFor(() => !isAlive(pid), { what: 'the launched app to exit' });
  });

  it('launches from the CLI and leaves the app running for later commands', async () => {
    endpoint = isolatedEndpoint();
    const env = { ...process.env, ...endpoint.env, EAB_FIXTURE_MODE: 'launch' };
    const eab = (...args: string[]) =>
      run(process.execPath, [eabBinPath(), ...args], { env, windowsHide: true });
    const { stdout } = await eab('launch', electronBinary(electron), '--', appBasic);
    const pid = Number(/Launched pid (\d+)/.exec(stdout)?.[1]);
    pids.push(pid);
    expect(isAlive(pid)).toBe(true);
    expect(existsSync(join(endpoint.directory, handshakeFileName(pid)))).toBe(true);
    expect((await eab('snapshot', '--pid', String(pid))).stdout).toMatch(/button "Save order" \[e\d+\]/);
  });
});
