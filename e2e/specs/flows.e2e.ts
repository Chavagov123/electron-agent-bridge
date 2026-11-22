import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { handshakeFileName } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { electronBinary, selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { eabBinPath } from '../harness/mcp-client.js';
import { isAlive } from '../harness/process-tree.js';
import { waitFor } from '../harness/wait.js';

const flows = join(dirname(fileURLToPath(import.meta.url)), '..', 'flows');
const appState = dirname(createRequire(import.meta.url).resolve('@eab-fixtures/app-state/package.json'));

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `eab run …` as a CI job would call it; resolves with the exit code instead of rejecting. */
function eabRun(args: readonly string[], env: Readonly<Record<string, string>>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [eabBinPath(), 'run', ...args],
      { env: { ...process.env, ...env }, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe.each(selectedVersions())('flows (eab run) on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await app?.dispose();
    endpoint?.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    [app, endpoint, scratch] = [undefined, undefined, undefined];
  });

  async function runningAppBasic(): Promise<number> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-basic',
      electron,
      mode: 'integrated',
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    return app.pid;
  }

  it('runs passing flows against a running app, with a report, JUnit and screenshots', async () => {
    const pid = await runningAppBasic();
    scratch = mkdtempSync(join(tmpdir(), 'eab-flows-'));
    const junit = join(scratch, 'report.xml');
    const artifacts = join(scratch, 'artifacts');
    const result = await eabRun(
      [join(flows, 'passing'), '--pid', String(pid), '--junit', junit, '--artifacts', artifacts],
      endpoint!.env,
    );
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('✓ 1. fill and save the order form');
    expect(result.stdout).toContain('✓ 3. expect element');
    expect(result.stdout).toMatch(/1 flow\(s\) passed, 0 failed/);
    expect(readFileSync(junit, 'utf8')).toMatch(
      /<testsuite name="Place an order" tests="5" failures="0" skipped="0"/,
    );
    expect(existsSync(join(artifacts, 'place-an-order', 'order.png'))).toBe(true);
  });

  it('reports failing and invalid flows with the reason, artifacts and exit code 1', async () => {
    const pid = await runningAppBasic();
    scratch = mkdtempSync(join(tmpdir(), 'eab-flows-'));
    const artifacts = join(scratch, 'artifacts');
    const result = await eabRun(
      [join(flows, 'failing'), '--pid', String(pid), '--artifacts', artifacts],
      endpoint!.env,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('✗ 1. expect text');
    expect(result.stdout).toContain('TIMEOUT: ');
    expect(result.stdout).toContain('- 2. reset (skipped)');
    expect(result.stdout).toMatch(/2-invalid\.flow\.yaml:3: steps\[0\]: a step needs exactly one of/);
    expect(result.stdout).toMatch(/0 flow\(s\) passed, 2 failed/);
    const saved = readdirSync(join(artifacts, 'expect-something-that-never-happens')).sort();
    expect(saved).toEqual(['step-1-failed.logs.txt', 'step-1-failed.png', 'step-1-failed.snapshot.txt']);
  });

  it('launches the app a flow names, with eval for dialog stubs, and closes it afterwards', async () => {
    endpoint = isolatedEndpoint();
    const result = await eabRun([join(flows, 'launch')], {
      ...endpoint.env,
      EAB_FLOW_ELECTRON: electronBinary(electron),
      EAB_FLOW_APP: appState,
    });
    expect(result.stderr).toBe('');
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('✓ 4. theme stays light');
    // The launched app is gone (it was killed, so its handshake file stays until the stale sweep).
    const pids = readdirSync(endpoint.directory)
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((pid): pid is string => pid !== undefined)
      .map(Number);
    expect(pids).toHaveLength(1);
    await waitFor(() => pids.every((pid) => !isAlive(pid)), { what: 'launched app closed' });
  });
});
