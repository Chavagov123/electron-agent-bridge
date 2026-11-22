/**
 * Launch-mode entry (ADR-0004). Loaded into an unmodified app's main process with
 * `NODE_OPTIONS=--require <this file>`, or by the inspector strategy, before the app's main script.
 * `electron` cannot be required that early, so the bridge is installed at the first moment it can be:
 * immediately, on the next module load, or on the next tick. Reports its progress to the launcher
 * through the `EAB_LAUNCH_STATUS` file so a failed launch can be diagnosed precisely.
 * @packageDocumentation
 */
import { writeFileSync } from 'node:fs';
import Module from 'node:module';

import {
  LAUNCH_OPTIONS_ENV,
  parseLaunchOptions,
  type LaunchBridgeOptions,
} from '@electron-agent-bridge/core';

import type { BridgeOptions, BridgeStatus, enableAgentBridge as EnableAgentBridge } from './index.js';

/** Stages the launcher reads from the status file. */
export type LaunchStage = 'loaded' | 'enabled' | 'off' | 'started' | 'failed';

/** Variables only a launcher sets; removed from `process.env` once read, so children never inherit them. */
const LAUNCH_ENV_KEYS = [
  'EAB_ENABLE',
  'EAB_HANDSHAKE',
  'EAB_AUDIT',
  'EAB_ALLOW_PACKAGED',
  'EAB_ALLOW_EVAL',
  'EAB_STATE_SHIM',
  'EAB_OPTIONS',
  'EAB_LAUNCH_STATUS',
  'EAB_LAUNCH_REQUIRE',
];
const LOADED = Symbol.for('electron-agent-bridge.v1.inject');

type Load = (request: string, parent: unknown, isMain: boolean) => unknown;
/**
 * Progress for the launcher; `started` carries the handshake path so it never has to guess it. Every
 * report also carries the app's first uncaught main-process exception, if any (`crash`): Electron then
 * shows a blocking error box, and a launch that stalls can say why.
 */
type Report = (stage: LaunchStage, details?: { reason?: string; handshakePath?: string }) => void;
const loader = Module as unknown as { _load: Load };

const globals = globalThis as Record<symbol, unknown>;
if (process.type === 'browser' && globals[LOADED] !== true) {
  globals[LOADED] = true;
  const statusPath = process.env['EAB_LAUNCH_STATUS'];
  let last: { stage: LaunchStage; details: Parameters<Report>[1] } = { stage: 'loaded', details: {} };
  let crash: string | undefined;
  const report: Report = (stage, details = {}): void => {
    last = { stage, details };
    if (statusPath === undefined || statusPath === '') return;
    try {
      const status = { stage, pid: process.pid, ...details, ...(crash === undefined ? {} : { crash }) };
      writeFileSync(statusPath, JSON.stringify(status), { mode: 0o600 });
    } catch {
      // The launcher then diagnoses from the handshake and the process output.
    }
  };
  const onCrash: OnCrash = (origin, error) => {
    if (crash !== undefined) return;
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    crash = `${origin}: ${text}`.slice(0, 2_000);
    report(last.stage, last.details);
  };
  // Observe only: neither changes how the app or Electron handle the exception. One the app handles
  // itself (its own uncaughtException listener) is survivable, so it explains no failure.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    if (process.listenerCount('uncaughtException') === 0) onCrash(origin, error);
  });
  report('loaded');
  installWhenElectronIsReady(report, onCrash);
}

/** Records the app's first startup failure for the launcher. */
type OnCrash = (origin: string, error: unknown) => void;

/**
 * Install the bridge once `electron` resolves, and watch the app's main script load: Electron catches
 * an error thrown there itself (no uncaughtException), so it is recorded and rethrown unchanged. The
 * loader is restored after that load, unless someone else has replaced it since.
 */
function installWhenElectronIsReady(report: Report, onCrash: OnCrash): void {
  const originalLoad = loader._load;
  let installed = false;
  const tryInstall = (): void => {
    if (installed || !electronAvailable(originalLoad)) return;
    installed = true;
    install(report);
  };
  const restore = (): void => {
    if (loader._load === load) loader._load = originalLoad;
  };
  function load(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    tryInstall();
    // Electron loads the app's main script without a parent (and, in recent versions, isMain false).
    if (!isMain && parent != null) return originalLoad.call(this, request, parent, isMain);
    restore();
    try {
      return originalLoad.call(this, request, parent, isMain);
    } catch (error) {
      onCrash('main script', error);
      throw error;
    }
  }
  loader._load = load;
  tryInstall();
  process.nextTick(tryInstall);
}

function electronAvailable(load: Load): boolean {
  try {
    const electron = load.call(Module, 'electron', null, false) as { app?: unknown } | undefined;
    return electron?.app !== undefined;
  } catch {
    return false;
  }
}

function install(report: Report): void {
  try {
    // Required here, not imported at the top: the runtime imports `electron`, which only now resolves.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load, see above
    const { enableAgentBridge } = require('./index.js') as { enableAgentBridge: typeof EnableAgentBridge };
    // Only a launcher can ask for a packaged app or for `eval`: plain EAB_* variables never grant them.
    const launcherOptions = launchOptions();
    const status: BridgeStatus = enableAgentBridge({
      ...launcherOptions,
      allowPackaged: process.env['EAB_ALLOW_PACKAGED'] === '1',
      ...(process.env['EAB_ALLOW_EVAL'] === '1' ? { capabilities: ['observe', 'interact', 'eval'] } : {}),
      ...(process.env['EAB_STATE_SHIM'] === '1' ? { state: { devtoolsShim: true } } : {}),
    });
    scrubEnvironment();
    if (!status.enabled) {
      report('off', status.reason === undefined ? {} : { reason: status.reason });
      return;
    }
    report('enabled');
    void status.ready.then((runtime) => {
      if (runtime) report('started', { handshakePath: runtime.handshakePath });
      else report('failed', { reason: 'the runtime failed to start (see stderr)' });
    });
  } catch (error) {
    scrubEnvironment();
    report('failed', { reason: error instanceof Error ? error.message : String(error) });
  }
}

/** The launcher's serializable options (`EAB_OPTIONS`), validated; none when it set nothing. */
function launchOptions(): BridgeOptions {
  const raw = process.env[LAUNCH_OPTIONS_ENV];
  if (raw === undefined || raw === '') return {};
  const { ipc, logs, snapshot }: LaunchBridgeOptions = parseLaunchOptions(raw);
  return {
    ...(ipc?.values === undefined ? {} : { ipc: { values: ipc.values } }),
    ...(logs === undefined
      ? {}
      : {
          logs: {
            ...(logs.mainConsole === undefined ? {} : { mainConsole: logs.mainConsole }),
            ...(logs.sourceMaps === undefined ? {} : { sourceMaps: logs.sourceMaps }),
          },
        }),
    ...(snapshot?.clickListeners === undefined
      ? {}
      : { snapshot: { clickListeners: snapshot.clickListeners } }),
  };
}

/**
 * Remove our `--require` from NODE_OPTIONS and the launch variables (config is read by now). The
 * launcher passes the exact entry it wrote (`EAB_LAUNCH_REQUIRE`), so a symlinked or differently
 * spelled path is removed just the same.
 */
function scrubEnvironment(): void {
  const entry = process.env['EAB_LAUNCH_REQUIRE'];
  for (const key of LAUNCH_ENV_KEYS) Reflect.deleteProperty(process.env, key);
  const options = process.env['NODE_OPTIONS'];
  if (options === undefined || entry === undefined || entry === '') return;
  const rest = options.replace(entry, '').trim();
  if (rest === '') Reflect.deleteProperty(process.env, 'NODE_OPTIONS');
  else process.env['NODE_OPTIONS'] = rest;
}
