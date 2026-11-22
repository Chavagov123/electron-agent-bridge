/**
 * @eab/electron: In-app runtime for the Electron main process, preload and renderer. Off unless explicitly enabled.
 * @packageDocumentation
 */
import * as electron from 'electron';
import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  net,
  session,
  utilityProcess,
  webContents,
} from 'electron';

import { SECRET_ENV_KEYS, readConfig, type BridgeOptions, type RuntimeConfig } from './runtime/config.js';
import { startRuntime, type Runtime } from './runtime/composition-root.js';
import { evaluateGate } from './runtime/gate.js';
import { claimRuntime, existingRuntime, releaseRuntime } from './runtime/singleton.js';
import type { UtilityProcessLike } from './ipc/utility-capture.js';
import type { MenuLike } from './main-control/menu.js';
import type { NetLike } from './network/main-network.js';
import { pageLayout } from './targets/page-layout.js';
import { setTargetName } from './targets/target-names.js';

export {
  DEFAULT_LOGGER_METHODS,
  addLogSource,
  loggerSource,
  type CustomLogEntry,
  type LogSink,
  type LogSource,
} from './logs/log-sources.js';
export type { BridgeOptions } from './runtime/config.js';
export type { Runtime } from './runtime/composition-root.js';

/**
 * Give a page a stable name agents can use instead of its id (e.g. `nameTarget(win.webContents, 'settings')`).
 * Works before or after the bridge starts, and is a harmless no-op while it is off.
 */
export function nameTarget(contents: Electron.WebContents, name: string): void {
  setTargetName(contents, name);
}

/** Outcome of {@link enableAgentBridge}. */
export interface BridgeStatus {
  readonly enabled: boolean;
  /** Why the bridge is off, when it is. */
  readonly reason?: string;
  /** Resolves with the running bridge, or `undefined` when it is off or failed to start (never rejects). */
  readonly ready: Promise<Runtime | undefined>;
}

/**
 * Turn the bridge on for this app — only if `EAB_ENABLE=1` and the app is unpackaged (or opted in).
 * Call it, or `import '@eab/electron/register'`, before the app registers IPC handlers or creates windows.
 * Safe to call more than once and from several bundle copies: the first call wins.
 */
export function enableAgentBridge(options: BridgeOptions = {}): BridgeStatus {
  if (process.type !== 'browser') return off('not the Electron main process');
  const decision = evaluateGate({
    env: process.env,
    isPackaged: app.isPackaged,
    allowPackaged: options.allowPackaged ?? false,
  });
  if (!decision.enabled) return off(decision.reason);
  // Every copy of this package stores a BridgeStatus in the slot.
  const existing = existingRuntime() as BridgeStatus | undefined;
  if (existing) {
    if (Object.keys(options).length > 0) warnIgnoredOptions();
    return existing;
  }

  const status: BridgeStatus = { enabled: true, ready: start(options) };
  claimRuntime(status);
  status.ready
    .then((runtime) => {
      if (!runtime) releaseRuntime(status);
    })
    .catch(() => undefined);
  return status;
}

async function start(options: BridgeOptions): Promise<Runtime | undefined> {
  try {
    const runtime = await startRuntime(
      {
        app,
        allWebContents: () => webContents.getAllWebContents(),
        layoutOf: (contents) => {
          const window = BrowserWindow.fromWebContents(contents);
          return window ? pageLayout(window, contents.id) : undefined;
        },
        electronVersion: process.versions.electron,
        ipcMain,
        defaultSession: () => session.defaultSession,
        windows: BrowserWindow,
        // MenuItem.click is typed as a bare `Function`; it is called with Electron's own arguments.
        applicationMenu: () => Menu.getApplicationMenu() as unknown as MenuLike | null,
        dialog,
        electron,
        utilityProcess: utilityProcess as unknown as UtilityProcessLike,
        createMessageChannel: () => new MessageChannelMain(),
        net: net as unknown as NetLike,
      },
      configFromEnvironment(options),
    );
    app.once('will-quit', () => {
      void runtime.close();
    });
    return runtime;
  } catch (error) {
    // Never break the host: report and stay off.
    process.stderr.write(
      `[electron-agent-bridge] failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

/**
 * Read the configuration, then remove secrets from `process.env` so child processes the app spawns
 * (which inherit its environment) never see the session token.
 */
function configFromEnvironment(options: BridgeOptions): RuntimeConfig {
  try {
    return readConfig(process.env, options);
  } finally {
    for (const key of SECRET_ENV_KEYS) Reflect.deleteProperty(process.env, key);
  }
}

/** The first call wins; never silently keep a wider capability ceiling than the app asked for. */
function warnIgnoredOptions(): void {
  process.stderr.write(
    '[electron-agent-bridge] enableAgentBridge(options) ignored: the bridge is already enabled ' +
      '(e.g. by @eab/electron/register). Pass options in the first call and drop the register import.\n',
  );
}

function off(reason: string): BridgeStatus {
  return { enabled: false, reason, ready: Promise.resolve(undefined) };
}
