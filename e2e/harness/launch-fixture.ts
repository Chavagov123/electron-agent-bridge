import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { launch, type LaunchStrategy } from '@eab/client';

import { electronBinary, type ElectronVersion } from './electron-versions.js';
import type { BridgeMode } from './modes.js';
import { FixtureControl, type FixtureReply } from './fixture-control.js';
import { isAlive, killProcessTree } from './process-tree.js';
import { waitFor } from './wait.js';

export type { FixtureReply } from './fixture-control.js';

/** Fixture apps available to specs (workspace package names without the scope). */
export type FixtureName =
  | 'app-basic'
  | 'app-multi'
  | 'app-host-debugger'
  | 'app-heavy'
  | 'app-ipc'
  | 'app-logs'
  | 'app-state'
  | 'app-bundled'
  | 'app-components'
  | 'app-frames';

export interface LaunchOptions {
  readonly fixture: FixtureName;
  readonly electron: ElectronVersion;
  /** `ci1-sb1-ni0` style spec; see fixtures/fixture-kit. */
  readonly webPrefs?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readyTimeoutMs?: number;
  /**
   * `integrated` (default): the fixture imports `@eab/electron/register`. `launch`: the fixture stays
   * unmodified and `@eab/client` launch() injects the bridge.
   */
  readonly mode?: BridgeMode;
  /** Launch mode only: force a strategy, another executable, or allow a packaged build. */
  readonly strategy?: 'auto' | LaunchStrategy;
  readonly executable?: string;
  readonly allowPackaged?: boolean;
  /** Launch mode: grant `eval` (launcher option). */
  readonly allowEval?: boolean;
  /** Launch mode: turn on the state devtools shim (launcher option). */
  readonly stateShim?: boolean;
  /** Integrated mode: extra Electron arguments before the app directory (e.g. a remote debugging port). */
  readonly args?: readonly string[];
}

/** Payload printed by fixture-kit once the fixture's windows have loaded. */
export interface FixtureReady {
  readonly fixture: string;
  readonly pid: number;
  readonly electron: string;
  readonly webPreferences: { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean };
}

export interface LaunchedFixture {
  readonly pid: number;
  readonly ready: FixtureReady;
  /** Send a command to the fixture (fixture-kit `handleCommands`) and wait for its reply. */
  readonly command: (name: string, timeoutMs?: number) => Promise<FixtureReply>;
  readonly output: () => { stdout: string; stderr: string };
  readonly dispose: () => Promise<void>;
}

const READY_PREFIX = 'EAB_FIXTURE_READY ';
const requireFromHere = createRequire(import.meta.url);

function fixtureDirectory(fixture: FixtureName): string {
  return dirname(requireFromHere.resolve(`@eab-fixtures/${fixture}/package.json`));
}

/** Launch a fixture app and resolve once it reports ready. Never sleeps; fails fast on early exit. */
export async function launchFixture(options: LaunchOptions): Promise<LaunchedFixture> {
  if (options.mode === 'launch') return launchInjected(options);
  const control = await FixtureControl.listen();
  const child = spawn(
    electronBinary(options.electron),
    [...(options.args ?? []), fixtureDirectory(options.fixture)],
    {
      env: {
        ...process.env,
        ...(options.webPrefs ? { EAB_FIXTURE_WEBPREFS: options.webPrefs } : {}),
        ...options.env,
        EAB_FIXTURE_CONTROL: control.path,
        ELECTRON_ENABLE_LOGGING: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });
  const pid = child.pid;
  if (pid === undefined) {
    control.close();
    throw new Error(`failed to spawn Electron for ${options.fixture}`);
  }

  let disposed = false;
  // Idempotent: a second kill could hit a reused pid that now belongs to another process.
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    control.close();
    killProcessTree(pid);
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, what: `${options.fixture} exit` });
  };

  try {
    const ready = await readyLine(child, output, options);
    return {
      pid,
      ready,
      command: withOutput(control, ready.pid, () => output),
      output: () => ({ ...output }),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function readyLine(
  child: ChildProcess,
  output: { readonly stdout: string; readonly stderr: string },
  options: LaunchOptions,
): Promise<FixtureReady> {
  const timeoutMs = options.readyTimeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const onData = (): void => {
      const line = output.stdout.split('\n').find((candidate) => candidate.startsWith(READY_PREFIX));
      if (!line) return;
      cleanup();
      resolve(JSON.parse(line.slice(READY_PREFIX.length)) as FixtureReady);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`${options.fixture} exited early with code ${String(code)}\n${output.stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${options.fixture} not ready within ${timeoutMs}ms (pid ${String(child.pid)})\n` +
            `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

/**
 * Launch mode: the unmodified fixture is started by `@eab/client` launch(), which injects the bridge.
 * The launcher's own client is closed so specs connect exactly as in Integrated mode.
 */
async function launchInjected(options: LaunchOptions): Promise<LaunchedFixture> {
  const control = await FixtureControl.listen();
  const app = await launch({
    executable: options.executable ?? electronBinary(options.electron),
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
    ...(options.allowPackaged === undefined ? {} : { allowPackaged: options.allowPackaged }),
    ...(options.allowEval === undefined ? {} : { allowEval: options.allowEval }),
    ...(options.stateShim === undefined ? {} : { stateShim: options.stateShim }),
    // Observer: the spec's own client must get the controller slot without a handover race.
    role: 'observer',
    args: [fixtureDirectory(options.fixture)],
    env: {
      ...(options.webPrefs ? { EAB_FIXTURE_WEBPREFS: options.webPrefs } : {}),
      ...options.env,
      EAB_FIXTURE_CONTROL: control.path,
      EAB_FIXTURE_MODE: 'launch',
      ELECTRON_ENABLE_LOGGING: '0',
    },
  }).catch((error: unknown) => {
    control.close();
    throw error;
  });
  app.client.close();
  const log = (): string => {
    try {
      return readFileSync(app.logPath, 'utf8');
    } catch {
      return '';
    }
  };
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    control.close();
    await app.close();
    await waitFor(() => !isAlive(app.pid), { timeoutMs: 5_000, what: `${options.fixture} exit` });
  };
  try {
    // waitFor returns the first truthy value: the parsed ready line.
    const ready = await waitFor(
      () => {
        const line = log()
          .split('\n')
          .find((candidate) => candidate.startsWith(READY_PREFIX));
        return line === undefined ? undefined : (JSON.parse(line.slice(READY_PREFIX.length)) as FixtureReady);
      },
      { timeoutMs: options.readyTimeoutMs ?? 20_000, what: `${options.fixture} ready (launch mode)` },
    );
    return {
      pid: app.pid,
      ready,
      command: withOutput(control, ready.pid, () => ({ stdout: log(), stderr: '' })),
      output: () => ({ stdout: log(), stderr: '' }),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** A command whose timeout error carries the end of the app's output (what was it doing?). */
function withOutput(
  control: FixtureControl,
  pid: number | undefined,
  output: () => { readonly stdout: string; readonly stderr: string },
): LaunchedFixture['command'] {
  return async (name, timeoutMs) => {
    try {
      return await control.command(name, timeoutMs, pid);
    } catch (error) {
      const { stdout, stderr } = output();
      const tail = (text: string) => text.split('\n').slice(-15).join('\n');
      const message = error instanceof Error ? error.message : String(error);
      const report = `${message}\napp stdout:\n${tail(stdout)}\napp stderr:\n${tail(stderr)}`;
      // Also on stderr: a retried test that passes in the end shows no error, but this still shows.
      process.stderr.write(`[fixture command failed] ${report}\n`);
      throw new Error(report, { cause: error });
    }
  };
}
