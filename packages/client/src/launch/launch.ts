import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeError, handshakeFileName, type LaunchBridgeOptions, type SessionRole } from '@eab/core';

import type { BridgeClient } from '../api/bridge-client.js';
import { connect } from '../api/connect.js';
import { defaultEndpointDirectory } from '../control/discovery.js';
import { spawnApp, type AppProcess } from './app-process.js';
import { STRATEGY_FUSES, blockedStrategies, readFuses } from './fuses.js';
import { diagnose, type Attempt, type AttemptOutcome } from './diagnose.js';
import { launchEnvironment, type LaunchStrategy } from './environment.js';
import { injectViaInspector, inspectorUrl } from './inspector.js';

export interface LaunchOptions {
  /** The app's executable: a packaged app, or the Electron binary with the app directory in `args`. */
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Extra environment for the app (on top of the launcher's own). */
  readonly env?: Readonly<Record<string, string>>;
  /** Default `auto`: NODE_OPTIONS first, then the inspector. */
  readonly strategy?: 'auto' | LaunchStrategy;
  /** Allow the bridge in a packaged (production) build. Default false. */
  readonly allowPackaged?: boolean;
  /**
   * Grant the `eval` capability (main-process code execution, dialog stubs) to clients of this app.
   * Default false: launched apps get `observe` and `interact` only.
   */
  readonly allowEval?: boolean;
  /**
   * Define the Redux DevTools extension globals in the app's pages, so stores built with DevTools
   * support (Redux, RTK, Zustand `devtools`, NgRx store-devtools) register for `state.read`. Adds
   * visible globals; default false. See docs/state.md.
   */
  readonly stateShim?: boolean;
  /**
   * Runtime options for the launched app, as an app would pass them to `enableAgentBridge` (the
   * serializable subset): IPC value channels, main console capture, click-listener tracking.
   */
  readonly options?: LaunchBridgeOptions;
  readonly role?: SessionRole;
  /** How long one strategy may take until the bridge is up. Default 20 s. */
  readonly timeoutMs?: number;
  /**
   * How long to wait for the injected code to report that it loaded; longer means the app ignored the
   * strategy. Default 8 s.
   */
  readonly probeMs?: number;
  /** Path of `@eab/electron/inject` (default: resolved next to this package). */
  readonly injectPath?: string;
  /** Read the binary's fuses first and skip strategies they block (default true). */
  readonly checkFuses?: boolean;
}

/** An app started by {@link launch}, with a connected client. */
export interface LaunchedApp {
  readonly pid: number;
  readonly strategy: LaunchStrategy;
  readonly client: BridgeClient;
  /** The app's stdout and stderr. */
  readonly logPath: string;
  readonly outputTail: () => string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Disconnect and kill the app with all its processes. */
  readonly close: () => Promise<void>;
  /** Disconnect and leave the app running (the launcher may exit). */
  readonly detach: () => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The inject reports `loaded` right at startup; if it has not after this long, the app ignored us. */
const LOAD_PROBE_MS = 8_000;
const POLL_MS = 50;

interface Status {
  readonly stage: 'loaded' | 'enabled' | 'off' | 'started' | 'failed';
  readonly pid: number;
  readonly reason?: string;
  /** Where the runtime wrote its handshake (with `started`). */
  readonly handshakePath?: string;
  /** The app's first uncaught main-process exception, at any stage. */
  readonly crash?: string;
}

/**
 * Start an unmodified app with the bridge injected (Launch mode, ADR-0004). Tries NODE_OPTIONS, then
 * the inspector; if the binary blocks both (fuses), fails with `LAUNCH_BLOCKED` and what each attempt
 * saw. A failed attempt's app is killed before the next one starts.
 */
export async function launch(options: LaunchOptions): Promise<LaunchedApp> {
  const strategies: LaunchStrategy[] =
    options.strategy === undefined || options.strategy === 'auto'
      ? ['node-options', 'inspector']
      : [options.strategy];
  const injectPath = options.injectPath ?? resolveInject();
  // Strategies the binary's fuses rule out are not tried: no app start, no 8 s probe, a definite cause.
  const blocked = new Set(
    options.checkFuses === false ? [] : blockedStrategies(await readFuses(options.executable)),
  );
  // Status files and the app's log; kept while the app runs (the log path is reported), removed on close.
  const work = mkdtempSync(join(tmpdir(), 'eab-launch-'));
  const attempts: Attempt[] = [];
  let tail = '';
  try {
    for (const strategy of strategies) {
      if (blocked.has(strategy)) {
        attempts.push({ strategy, outcome: { kind: 'fuse-off', fuse: STRATEGY_FUSES[strategy] } });
        continue;
      }
      const result = await attempt(strategy, { ...options, injectPath }, work);
      if ('app' in result) return result.app;
      attempts.push({ strategy, outcome: result.outcome });
      tail = result.tail;
      // Only "the app ignored us" is worth another strategy; a refusal or a crash would just repeat.
      if (result.outcome.kind !== 'no-effect' && result.outcome.kind !== 'no-user-script') break;
    }
  } catch (error) {
    removeWork(work);
    throw error;
  }
  removeWork(work);
  throw diagnose(options.executable, attempts, tail);
}

function removeWork(work: string): void {
  rmSync(work, { recursive: true, force: true });
}

type AttemptResult = { app: LaunchedApp } | { outcome: AttemptOutcome; tail: string };

async function attempt(
  strategy: LaunchStrategy,
  options: LaunchOptions & { readonly injectPath: string },
  work: string,
): Promise<AttemptResult> {
  const { injectPath } = options;
  const statusPath = join(work, `${strategy}.status.json`);
  const logPath = join(work, `${strategy}.log`);
  const app = await spawnApp({
    executable: options.executable,
    args: strategy === 'inspector' ? ['--inspect-brk=0', ...(options.args ?? [])] : (options.args ?? []),
    env: launchEnvironment({
      parent: process.env,
      ...(options.env === undefined ? {} : { extra: options.env }),
      strategy,
      injectPath,
      statusPath,
      allowPackaged: options.allowPackaged ?? false,
      allowEval: options.allowEval ?? false,
      stateShim: options.stateShim ?? false,
      ...(options.options === undefined ? {} : { options: options.options }),
    }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    logPath,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeMs = options.probeMs ?? LOAD_PROBE_MS;
  const outcome = await bringUp(strategy, app, { injectPath, statusPath, timeoutMs, probeMs });
  if ('status' in outcome) {
    const handshakePath =
      outcome.status.handshakePath ?? join(defaultEndpointDirectory(), handshakeFileName(outcome.status.pid));
    const connected = await connectTo(app, { handshakePath, role: options.role, timeoutMs });
    if ('client' in connected) {
      return { app: launchedApp(app, { strategy, client: connected.client, logPath, work }) };
    }
    return fail(app, connected.outcome, statusPath);
  }
  return fail(app, outcome.outcome, statusPath);
}

/**
 * Kill the attempt's app; if the app itself threw meanwhile, that is the outcome worth reporting (the
 * runtime records only throws the app does not handle: Electron then stalls behind an error box).
 */
async function fail(app: AppProcess, outcome: AttemptOutcome, statusPath: string): Promise<AttemptResult> {
  const tail = app.outputTail();
  await app.kill();
  const crash = readStatus(statusPath)?.crash;
  return {
    outcome: crash === undefined || outcome.kind === 'off' ? outcome : { kind: 'crashed', crash },
    tail,
  };
}

interface BringUp {
  readonly injectPath: string;
  readonly statusPath: string;
  readonly timeoutMs: number;
  readonly probeMs: number;
}

/** Until the inject reports the runtime started (or why it did not). */
async function bringUp(
  strategy: LaunchStrategy,
  app: AppProcess,
  { injectPath, statusPath, timeoutMs, probeMs }: BringUp,
): Promise<{ status: Status } | { outcome: AttemptOutcome }> {
  if (strategy === 'inspector') {
    const url = await until(() => inspectorUrl(app.outputTail()), app, probeMs);
    if ('outcome' in url)
      return { outcome: url.outcome.kind === 'timeout' ? { kind: 'no-effect' } : url.outcome };
    const injected = await injectViaInspector(url.value, injectPath, AbortSignal.timeout(timeoutMs));
    if (injected.kind === 'failed') return { outcome: { kind: 'failed', reason: injected.reason } };
    if (injected.kind === 'unreached') {
      // The inspector also goes away when the app exits: tell the two apart.
      await Promise.race([app.exited, new Promise((resolve) => setTimeout(resolve, 200))]);
      if (!app.hasExited()) return { outcome: { kind: 'no-user-script' } };
      const { code, signal } = await app.exited;
      return { outcome: { kind: 'exited', code, signal } };
    }
  }
  const loaded = await until(() => readStatus(statusPath), app, probeMs);
  if ('outcome' in loaded)
    return { outcome: loaded.outcome.kind === 'timeout' ? { kind: 'no-effect' } : loaded.outcome };
  const settled = await until(
    () => {
      const status = readStatus(statusPath);
      return status && status.stage !== 'loaded' && status.stage !== 'enabled' ? status : undefined;
    },
    app,
    timeoutMs,
  );
  if ('outcome' in settled) {
    return {
      outcome:
        settled.outcome.kind === 'timeout'
          ? { kind: 'timeout', stage: 'the bridge to start' }
          : settled.outcome,
    };
  }
  const status = settled.value;
  if (status.stage === 'off') return { outcome: { kind: 'off', reason: status.reason ?? 'unknown' } };
  if (status.stage === 'failed') return { outcome: { kind: 'failed', reason: status.reason ?? 'unknown' } };
  return { status };
}

interface ConnectTarget {
  readonly handshakePath: string;
  readonly role: SessionRole | undefined;
  readonly timeoutMs: number;
}

async function connectTo(
  app: AppProcess,
  { handshakePath, role, timeoutMs }: ConnectTarget,
): Promise<{ client: BridgeClient } | { outcome: AttemptOutcome }> {
  // One budget for the handshake and every connection attempt.
  const deadline = Date.now() + timeoutMs;
  const written = await until(() => (existsSync(handshakePath) ? true : undefined), app, timeoutMs);
  if ('outcome' in written) {
    return {
      outcome:
        written.outcome.kind === 'timeout'
          ? { kind: 'timeout', stage: `the handshake at ${handshakePath}` }
          : written.outcome,
    };
  }
  // A freshly started bridge can drop the very first connection (the app still busy starting up, e.g.
  // just resumed from the inspector): retry a closed connection a few times while the app lives.
  for (let attempt = 1; ; attempt++) {
    try {
      // The app may still be busy starting (heavy synchronous startup): allow it what is left.
      const left = Math.max(1, deadline - Date.now());
      return {
        client: await connect({ handshakePath, timeoutMs: left, ...(role === undefined ? {} : { role }) }),
      };
    } catch (error) {
      const closed = error instanceof BridgeError && error.code === 'TRANSPORT_CLOSED';
      if (!closed || attempt >= CONNECT_ATTEMPTS || app.hasExited() || Date.now() >= deadline) {
        return {
          outcome: { kind: 'failed', reason: error instanceof Error ? error.message : String(error) },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

const CONNECT_ATTEMPTS = 3;

interface Started {
  readonly strategy: LaunchStrategy;
  readonly client: BridgeClient;
  readonly logPath: string;
  readonly work: string;
}

function launchedApp(app: AppProcess, { strategy, client, logPath, work }: Started): LaunchedApp {
  return {
    pid: app.pid,
    strategy,
    client,
    logPath,
    outputTail: app.outputTail,
    exited: app.exited,
    close: async () => {
      client.close();
      await app.kill();
      removeWork(work);
    },
    detach: () => {
      client.close();
      app.detach();
    },
  };
}

/** Poll `probe` until it yields a value, the app exits, or the time is up. */
async function until<T>(
  probe: () => T | undefined,
  app: AppProcess,
  timeoutMs: number,
): Promise<{ value: T } | { outcome: AttemptOutcome }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return { value };
    if (app.hasExited()) {
      const { code, signal } = await app.exited;
      return { outcome: { kind: 'exited', code, signal } };
    }
    if (Date.now() >= deadline) return { outcome: { kind: 'timeout', stage: 'the app' } };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function readStatus(path: string): Status | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Status;
  } catch {
    // Not written yet, or caught mid-write.
    return undefined;
  }
}

/** `@eab/electron/inject`, resolved from this package (works from the ESM and the CJS build). */
function resolveInject(): string {
  const base = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
  try {
    return createRequire(base).resolve('@eab/electron/inject');
  } catch {
    throw new BridgeError('UNSUPPORTED', 'Launch mode needs @eab/electron, which is not installed', {
      hint: 'Install it next to @eab/client (npm install @eab/electron), or pass injectPath.',
    });
  }
}
