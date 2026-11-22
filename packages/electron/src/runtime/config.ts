import { BridgeError, type Capability } from '@electron-agent-bridge/core';

import type { LogSource } from '../logs/log-sources.js';

/** Options an app passes to `enableAgentBridge`. */
export interface BridgeOptions {
  /** Allow the bridge in a packaged app (still requires `EAB_ENABLE=1`). Default false. */
  readonly allowPackaged?: boolean;
  /** Highest capability any client may get. Default `['observe', 'interact']`; `eval` is opt-in. */
  readonly capabilities?: readonly Capability[];
  /**
   * Audit log of calls (metadata only). Default: `<endpoint dir>/audit-<pid>.jsonl`.
   * A path writes there instead; `false` turns it off (and wins over `EAB_AUDIT`).
   */
  readonly audit?: false | string;
  /**
   * IPC capture. Arguments are recorded as shapes only; `values` lists channel globs (e.g.
   * `['settings:*']`) whose argument values are recorded too, with secret-looking keys redacted.
   */
  readonly ipc?: { readonly values?: readonly string[] };
  /**
   * Logs. The main process's `console` is recorded unless `mainConsole` is false; `sources` adds the
   * app's own loggers (see `loggerSource`, or `addLogSource` at any time).
   */
  readonly logs?: {
    readonly mainConsole?: boolean;
    readonly sources?: readonly LogSource[];
    /** Map stack frames to original sources through the scripts' source maps when logs are read. Default on. */
    readonly sourceMaps?: boolean;
  };
  /**
   * State. `devtoolsShim: true` defines the Redux DevTools extension globals in app pages (when no real
   * extension is there), so stores built with devtools support register themselves. Default off:
   * `registerState` from `@electron-agent-bridge/electron/renderer` needs no shim.
   */
  readonly state?: { readonly devtoolsShim?: boolean };
  /**
   * Snapshots. `clickListeners: false` stops the main-world hook from noting which elements get click
   * listeners (it wraps `EventTarget.prototype.addEventListener`, recording and delegating), so plain
   * elements the page listens to no longer get a `clickable` ref. Default on.
   */
  readonly snapshot?: { readonly clickListeners?: boolean };
}

/** Resolved runtime configuration. */
export interface RuntimeConfig {
  /** Pre-shared token (Launch mode passes one); otherwise the runtime generates one. */
  readonly token: string | undefined;
  /** Where to write the handshake; default `<endpoint dir>/<pid>.json`. */
  readonly handshakePath: string | undefined;
  readonly capabilities: readonly Capability[];
  /** `false`: no audit; a path; or `undefined` for the default location. */
  readonly audit: false | string | undefined;
  /** Channel globs whose IPC argument values are recorded (redacted). */
  readonly ipcValueChannels: readonly string[];
  readonly logMainConsole: boolean;
  readonly logSources: readonly LogSource[];
  readonly sourceMaps: boolean;
  readonly devtoolsShim: boolean;
  readonly clickListeners: boolean;
  /** `launch` when a launcher injected the runtime (it sets the status file), else `integrated`. */
  readonly mode: 'integrated' | 'launch';
}

const DEFAULT_CAPABILITIES: readonly Capability[] = ['observe', 'interact'];
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** Environment variables that carry secrets; removed from `process.env` once read (see index). */
export const SECRET_ENV_KEYS = ['EAB_TOKEN'] as const;

/** Read configuration from the environment and the app's options. Throws on malformed values. */
export function readConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: BridgeOptions,
): RuntimeConfig {
  const token = nonEmpty(env['EAB_TOKEN']);
  if (token !== undefined && !TOKEN_PATTERN.test(token)) {
    throw new BridgeError('INVALID_PARAMS', 'EAB_TOKEN must be 16-256 URL-safe characters');
  }
  return {
    token,
    handshakePath: nonEmpty(env['EAB_HANDSHAKE']),
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    audit: resolveAudit(nonEmpty(env['EAB_AUDIT']), options.audit),
    ipcValueChannels: options.ipc?.values ?? [],
    ...logConfig(options.logs),
    devtoolsShim: options.state?.devtoolsShim ?? false,
    clickListeners: options.snapshot?.clickListeners ?? true,
    mode: nonEmpty(env['EAB_LAUNCH_STATUS']) === undefined ? 'integrated' : 'launch',
  };
}

function logConfig(
  logs: BridgeOptions['logs'],
): Pick<RuntimeConfig, 'logMainConsole' | 'logSources' | 'sourceMaps'> {
  return {
    logMainConsole: logs?.mainConsole ?? true,
    logSources: logs?.sources ?? [],
    sourceMaps: logs?.sourceMaps ?? true,
  };
}

function resolveAudit(
  fromEnv: string | undefined,
  fromOptions: false | string | undefined,
): false | string | undefined {
  if (fromOptions === false) return false;
  if (fromEnv === '0' || fromEnv?.toLowerCase() === 'off') return false;
  return fromEnv ?? fromOptions;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
