import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launch, type LaunchOptions } from './launch.js';

/**
 * Node stands in for the app: it honours NODE_OPTIONS --require and --inspect-brk like Electron's main
 * process. A fake inject reports the stage named by FAKE_STAGE (or nothing), so every outcome the
 * launcher must handle is produced by real processes.
 */
let work: string;
let fakeApp: string;
let fakeInject: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'eab-launch-test-'));
  // ES module: Node (like Electron 35) does not pause before a CommonJS entry script.
  fakeApp = join(work, 'app.mjs');
  fakeInject = join(work, 'inject.cjs');
  writeFileSync(
    fakeApp,
    'if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));\nsetInterval(() => {}, 1000);\n',
  );
  writeFileSync(
    fakeInject,
    [
      "const viaInspector = process.execArgv.some((arg) => arg.startsWith('--inspect'));",
      "if (process.env.FAKE_THROW && viaInspector) throw new Error('inject exploded');",
      'const stage = process.env.FAKE_ONLY_INSPECTOR && !viaInspector ? undefined : process.env.FAKE_STAGE;',
      "if (stage) require('node:fs').writeFileSync(process.env.EAB_LAUNCH_STATUS, JSON.stringify({ stage, pid: process.pid, reason: process.env.FAKE_REASON, crash: process.env.FAKE_CRASH }));",
      "if (stage === 'loaded' && process.env.FAKE_THEN) setTimeout(() => require('node:fs').writeFileSync(process.env.EAB_LAUNCH_STATUS, JSON.stringify({ stage: process.env.FAKE_THEN, pid: process.pid })), 50);",
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function fake(env: Record<string, string>, extra: Partial<LaunchOptions> = {}): Promise<unknown> {
  return launch({
    executable: process.execPath,
    args: [fakeApp],
    env,
    injectPath: fakeInject,
    probeMs: 1_500,
    timeoutMs: 1_500,
    ...extra,
  });
}

describe('launch', () => {
  it('skips strategies the binary’s fuses block and says so without starting anything', async () => {
    const fused = join(work, 'fused-electron');
    writeFileSync(
      fused,
      Buffer.concat([
        Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
        Buffer.from([1, 4]),
        Buffer.from('0000'),
      ]),
    );
    const started = Date.now();
    await expect(launch({ executable: fused, injectPath: fakeInject })).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      message: expect.stringMatching(
        /node-options: not tried: the EnableNodeOptionsEnvironmentVariable fuse.*inspector: not tried/s,
      ) as unknown,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports a refusal by the bridge gate as NOT_ENABLED without trying other strategies', async () => {
    await expect(
      fake({
        FAKE_STAGE: 'off',
        FAKE_REASON: 'packaged app without enableAgentBridge({ allowPackaged: true })',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_ENABLED',
      hint: expect.stringContaining('--allow-packaged') as unknown,
    });
  });

  it('stops at a runtime failure and reports it', async () => {
    const error = fake({ FAKE_STAGE: 'failed', FAKE_REASON: 'port in use' });
    await expect(error).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      message: expect.stringMatching(/node-options: the bridge failed to start: port in use\.$/) as unknown,
    });
  });

  it('reports the app’s own startup crash instead of the stall it causes', async () => {
    const error = fake({
      FAKE_STAGE: 'enabled',
      FAKE_CRASH: "uncaughtException: Error: Cannot find module 'x.node'",
    });
    await expect(error).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      message: expect.stringContaining(
        "node-options: the app's main process threw (uncaughtException: Error: Cannot find module 'x.node')",
      ) as unknown,
      hint: expect.stringContaining('fails the same way without the bridge') as unknown,
    });
  });

  it('falls back to the inspector when NODE_OPTIONS has no effect, and injects through it', async () => {
    await expect(
      fake({ FAKE_ONLY_INSPECTOR: '1', FAKE_STAGE: 'off', FAKE_REASON: 'EAB_DISABLE=1 (kill switch)' }),
    ).rejects.toMatchObject({
      code: 'NOT_ENABLED',
      message: expect.stringContaining('kill switch') as unknown,
    });
  });

  it('fails with NOT_FOUND, without crashing the launcher, when the executable does not exist', async () => {
    await expect(fake({}, { executable: join(work, 'no-such-app') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('could not start') as unknown,
      hint: expect.stringContaining('executable path') as unknown,
    });
  });

  it('reports an inject that throws inside the app during inspector injection', async () => {
    await expect(fake({ FAKE_THROW: '1' }, { strategy: 'inspector' })).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      message: expect.stringContaining('inject exploded') as unknown,
    });
  });

  it('names an app that exits before the bridge starts', async () => {
    await expect(fake({ FAKE_EXIT: '3' }, { strategy: 'node-options' })).rejects.toMatchObject({
      code: 'LAUNCH_BLOCKED',
      message: expect.stringContaining('exited before the bridge started (code 3)') as unknown,
    });
  });

  it('reports no effect when nothing loads, for each strategy tried', async () => {
    await expect(fake({}, { strategy: 'node-options' })).rejects.toMatchObject({
      message: expect.stringContaining('node-options: NODE_OPTIONS had no effect') as unknown,
    });
  });

  it('says when the inspector never reaches the app’s own code (CommonJS entry)', async () => {
    const cjs = join(work, 'app.cjs');
    writeFileSync(cjs, 'setInterval(() => {}, 1000);\n');
    await expect(fake({ FAKE_STAGE: 'off' }, { strategy: 'inspector', args: [cjs] })).rejects.toMatchObject({
      message: expect.stringContaining("the inspector never reached the app's own code") as unknown,
    });
  });

  it('injects through the inspector of an app started with --inspect-brk', async () => {
    await expect(
      fake({ FAKE_STAGE: 'off', FAKE_REASON: 'kill switch' }, { strategy: 'inspector' }),
    ).rejects.toMatchObject({
      code: 'NOT_ENABLED',
      message: expect.stringContaining('kill switch') as unknown,
    });
  });

  it('times out when the bridge never finishes starting, or never writes its handshake', async () => {
    await expect(fake({ FAKE_STAGE: 'enabled' }, { strategy: 'node-options' })).rejects.toMatchObject({
      message: expect.stringContaining('timed out waiting for the bridge to start') as unknown,
    });
    await expect(
      fake({ FAKE_STAGE: 'loaded', FAKE_THEN: 'started' }, { strategy: 'node-options' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/timed out waiting for the handshake at .*\.json/) as unknown,
    });
  });
});
