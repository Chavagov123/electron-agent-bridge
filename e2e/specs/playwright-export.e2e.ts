import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFlow, toPlaywright } from '@eab/client';
import { afterEach, describe, expect, it } from 'vitest';

import { electronBinary, selectedVersions } from '../harness/electron-versions.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwrightCli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const appBasic = dirname(require.resolve('@eab-fixtures/app-basic/package.json'));
/** Inside the e2e package, so the exported test resolves `@playwright/test` from it. */
const out = join(here, '..', '.playwright');

interface Run {
  readonly code: number;
  readonly output: string;
}

function playwright(args: readonly string[], env: Readonly<Record<string, string>>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [playwrightCli, 'test', ...args],
      { cwd: out, env: { ...process.env, ...env }, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe.each(selectedVersions())('exported Playwright tests on Electron %s', (electron) => {
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('runs a flow exported to Playwright against the app, without the bridge', async () => {
    const flow = parseFlow(readFileSync(join(here, '..', 'flows', 'passing', '1-order.flow.yaml'), 'utf8'));
    const { code, warnings } = toPlaywright(flow);
    expect(warnings).toEqual([
      'app: a flow that connects to a running app is launched from EAB_EXECUTABLE and EAB_ARGS (JSON)',
    ]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'order.spec.ts'), code);
    const run = await playwright(
      ['order.spec.ts', '--reporter=line', '--workers=1', `--output=${join(out, 'results')}`],
      {
        EAB_EXECUTABLE: electronBinary(electron),
        EAB_ARGS: JSON.stringify([appBasic]),
      },
    );
    expect(run.output).toMatch(/1 passed/);
    expect(run.code).toBe(0);
  });

  it('fails when the app does not do what the flow expects', async () => {
    const { code } = toPlaywright({
      name: 'Wrong text',
      steps: [{ expect: { text: 'This text is not on the page' }, timeoutMs: 1_000 }],
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'wrong.spec.ts'), code);
    const run = await playwright(
      ['wrong.spec.ts', '--reporter=line', '--workers=1', `--output=${join(out, 'results')}`],
      {
        EAB_EXECUTABLE: electronBinary(electron),
        EAB_ARGS: JSON.stringify([appBasic]),
      },
    );
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/1 failed/);
  });
});
