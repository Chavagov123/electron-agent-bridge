import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NewLogEntry } from '@electron-agent-bridge/engine';
import type { App, Session, WebContents } from 'electron';

import { PRELOAD_SOURCE, PRELOAD_VERSION } from '../generated/preload-source.js';
import { CorrelationQueue } from './correlation.js';
import { safely, wrapIpcTarget, type IpcTarget, type WrapContext } from './ipc-main-wrapper.js';
import { UPLINK_CHANNEL, type IpcRecorder } from './ipc-recorder.js';
import { PortCapture, type MessageChannelFactory } from './port-capture.js';
import { createUplinkHandler } from './uplink.js';
import type { SyncWaits } from './sync-waits.js';
import { UtilityCapture, type UtilityProcessLike } from './utility-capture.js';
import { hookWebContents } from './web-contents-hooks.js';

const PRELOAD_ID = 'electron-agent-bridge';

/** `ipcMain` as the capture uses it. */
export interface IpcMainLike extends IpcTarget {
  listenerCount(channel: string): number;
  eventNames(): (string | symbol)[];
}

export interface IpcCaptureDeps {
  readonly app: App;
  readonly ipcMain: IpcMainLike;
  /** The default session; only valid once the app is ready. */
  readonly defaultSession: () => Session;
  readonly allWebContents: () => WebContents[];
  readonly recorder: IpcRecorder;
  /** Private directory for the preload file (the endpoint directory). */
  readonly preloadDirectory: string;
  /** Electron's `utilityProcess`, to record main ↔ utility messages (absent: not recorded). */
  readonly utilityProcess?: UtilityProcessLike;
  /** `() => new MessageChannelMain()`, to reach the port prototype (absent: ports not recorded). */
  readonly createMessageChannel?: MessageChannelFactory;
  /** Where unanswered `sendSync` messages are tracked (pages blocked on a dialog). */
  readonly waits?: SyncWaits;
  /** Where process events of the capture go (utility processes starting). */
  readonly log?: (entry: NewLogEntry) => void;
}

/**
 * Installs every IPC source of ADR-0005 and the renderer preload of ADR-0003. Synchronous, so
 * `ipcMain` is wrapped before the app registers its first handler. `stop()` undoes all of it.
 */
export class IpcCapture {
  readonly #deps: IpcCaptureDeps;
  readonly #undo: (() => void)[] = [];
  readonly #pages = new Map<number, () => void>();
  readonly #recording = { value: true };

  constructor(deps: IpcCaptureDeps) {
    this.#deps = deps;
  }

  start(): void {
    const { app, ipcMain, recorder } = this.#deps;
    recorder.markPreexisting(preexistingChannels(ipcMain));
    const correlation = new CorrelationQueue();
    // Registered before wrapping: our own channel is never recorded.
    const uplink = createUplinkHandler({ recorder, correlation });
    ipcMain.on(UPLINK_CHANNEL, uplink as never);
    this.#undo.push(() => ipcMain.removeListener(UPLINK_CHANNEL, uplink as never));
    const context: WrapContext = {
      recorder,
      correlation,
      seen: new WeakSet<object>(),
      syncEvents: new WeakSet<object>(),
      proxies: new WeakMap<object, object>(),
      ...(this.#deps.waits === undefined ? {} : { waits: this.#deps.waits }),
      wrapped: new WeakSet<object>(),
      recording: this.#recording,
    };
    this.#undo.push(wrapIpcTarget(ipcMain, context));
    const onCreated = (_event: unknown, contents: WebContents): void => {
      this.#deps.waits?.noteOpened();
      this.#hook(contents, context);
    };
    app.on('web-contents-created', onCreated);
    this.#undo.push(() => app.off('web-contents-created', onCreated));
    for (const contents of this.#deps.allWebContents()) this.#hook(contents, context);
    this.#installPreload();
    this.#startProcessSources();
  }

  /** utilityProcess and MessagePortMain messages (protocol 1.1). */
  #startProcessSources(): void {
    const { recorder, utilityProcess, createMessageChannel, log } = this.#deps;
    const utility = new UtilityCapture({
      utilityProcess,
      recorder,
      recording: this.#recording,
      log: log ?? (() => undefined),
    });
    const ports = new PortCapture({
      createChannel: createMessageChannel,
      recorder,
      recording: this.#recording,
    });
    utility.start();
    ports.start();
    this.#undo.push(
      () => {
        utility.stop();
      },
      () => {
        ports.stop();
      },
    );
  }

  /** Stop recording; wrappers stay as pass-throughs so the app's listeners remain removable. */
  stop(): void {
    this.#recording.value = false;
    for (const undo of this.#pages.values()) safely(undo);
    this.#pages.clear();
    for (const undo of this.#undo.splice(0).reverse()) safely(undo);
  }

  #hook(contents: WebContents, context: WrapContext): void {
    if (this.#pages.has(contents.id)) return;
    this.#pages.set(contents.id, hookWebContents(contents, context));
    contents.once('destroyed', () => {
      this.#pages.delete(contents.id);
    });
  }

  /** Write the preload next to the endpoints and register it on every session, current and future. */
  #installPreload(): void {
    const filePath = writePreload(this.#deps.preloadDirectory);
    const register = (session: Session): void => {
      safely(() => {
        const id = session.registerPreloadScript({ type: 'frame', id: PRELOAD_ID, filePath });
        // New windows after a stop must not load it (it would report to nobody).
        this.#undo.push(() => {
          session.unregisterPreloadScript(id);
        });
      });
    };
    const { app } = this.#deps;
    const onSession = (session: Session): void => {
      register(session);
    };
    app.on('session-created', onSession);
    this.#undo.push(() => app.off('session-created', onSession));
    // Before the app's own whenReady handlers (the bridge is installed first), so before any window.
    void app.whenReady().then(() => {
      register(this.#deps.defaultSession());
    });
  }
}

/**
 * The preload file, written atomically (temp file, then rename) unless it is already there with exactly
 * this content: a crash mid-write must not leave a truncated preload that every page then loads.
 */
function writePreload(directory: string): string {
  const filePath = join(directory, `preload-${PRELOAD_VERSION}.cjs`);
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === PRELOAD_SOURCE) return filePath;
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, PRELOAD_SOURCE, { mode: 0o600 });
  renameSync(temporary, filePath);
  return filePath;
}

/** Channels with listeners or handlers before the bridge: Electron's own, or code loaded earlier. */
function preexistingChannels(ipcMain: IpcMainLike): string[] {
  const listened = ipcMain.eventNames().filter((name): name is string => typeof name === 'string');
  const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })._invokeHandlers;
  return [...listened, ...(handlers instanceof Map ? [...handlers.keys()] : [])];
}
