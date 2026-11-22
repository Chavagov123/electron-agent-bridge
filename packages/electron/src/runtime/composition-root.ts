import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { ok, handshakeFileName, socketPath } from '@electron-agent-bridge/core';
import {
  ActionEngine,
  AgentPool,
  AgentSnapshotter,
  ChildSessions,
  ComponentReader,
  EngineFacade,
  InputRecorder,
  StateHookInstaller,
  StateReader,
  TargetRegistry,
  Screenshotter,
  Waiter,
  queryLogs,
  queryNetwork,
  queryRecorded,
  type Clock,
  type RecordQueryDeps,
} from '@electron-agent-bridge/engine';
import { AGENT_SOURCE, AGENT_VERSION, stateHookSource } from '@electron-agent-bridge/page-agent';
import type { App, Session, WebContents } from 'electron';

import { NO_AUDIT, type AuditSink } from '../audit/audit-log.js';
import type { PageLayout } from '../targets/page-layout.js';
import { Authenticator } from '../control/authenticator.js';
import { assertPrivateDir } from '../control/endpoint-dir.js';
import { HandshakeFile } from '../control/handshake-file.js';
import { RpcSession, type MethodHandlers } from '../control/rpc-session.js';
import { SessionRegistry } from '../control/session-registry.js';
import { SocketServer } from '../control/socket-server.js';
import { IpcCapture, type IpcMainLike } from '../ipc/ipc-capture.js';
import type { MessageChannelFactory } from '../ipc/port-capture.js';
import type { UtilityProcessLike } from '../ipc/utility-capture.js';
import type { MainNetworkCapture, NetLike } from '../network/main-network.js';
import { queryIpc } from '../ipc/ipc-query.js';
import { IpcRecorder } from '../ipc/ipc-recorder.js';
import { SyncWaits } from '../ipc/sync-waits.js';
import type { MainLogCapture } from '../logs/main-logs.js';
import { guardBlockedPages } from './blocked-pages.js';
import { createMainControl, type MainControl, type MainControlHost } from '../main-control/main-handlers.js';
import { ElectronTargetSource } from '../targets/electron-target-source.js';
import type { RuntimeConfig } from './config.js';
import { createAudit, handshakeFor, prepareEndpointDir, refreshWhenReady } from './endpoint.js';
import type { WorkerStackMapper } from '../logs/worker-stack-mapper.js';
import { createRecords } from './records.js';

/** Real time for waits and retries. */
const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What the host passes in: the Electron objects the runtime is allowed to touch. */
export interface ElectronHost extends MainControlHost {
  readonly app: App;
  readonly allWebContents: () => WebContents[];
  /** Where `contents` sits in its window (tells windows from embedded views, and what is on screen). */
  readonly layoutOf: (contents: WebContents) => PageLayout | undefined;
  readonly ipcMain: IpcMainLike;
  /** The default session; only valid once the app is ready. */
  readonly defaultSession: () => Session;
  /** `utilityProcess`, for recording main ↔ utility messages. */
  readonly utilityProcess?: UtilityProcessLike;
  /** Makes a `MessageChannelMain`, for recording MessagePortMain messages. */
  readonly createMessageChannel?: MessageChannelFactory;
  /** Electron's `net`, for recording main-process requests made with it. */
  readonly net?: NetLike;
}

/** A running bridge. */
export interface Runtime {
  readonly endpoint: string;
  readonly handshakePath: string;
  close(): Promise<void>;
}

/**
 * The only place that constructs runtime adapters. Targets are tracked synchronously (so windows
 * created right after `register` are attached), then the socket and the handshake follow.
 * Any failure undoes everything already started, so a failed start leaves nothing behind.
 */
export async function startRuntime(host: ElectronHost, config: RuntimeConfig): Promise<Runtime> {
  const {
    logs,
    consoleLogs,
    network,
    mainLogs,
    mainNetwork,
    sourceMaps,
    queries: records,
  } = createRecords(host, config, SYSTEM_CLOCK);
  const pool = new AgentPool({ source: AGENT_SOURCE, version: AGENT_VERSION });
  const inputs = new InputRecorder({ pool, clock: SYSTEM_CLOCK });
  const stateHook = new StateHookInstaller(
    stateHookSource({ devtoolsShim: config.devtoolsShim, clickListeners: config.clickListeners }),
  );
  // Cross-origin iframes and workers: their console and network, under ids like `wc3:w1`.
  const children = new ChildSessions((child) => {
    const watching = [consoleLogs.watch(child.id, child.transport), network.watch(child.id, child.transport)];
    return {
      dispose: () => {
        for (const watch of watching) watch.dispose();
      },
    };
  });
  const targets = new ElectronTargetSource({
    app: host.app,
    allWebContents: host.allWebContents,
    layoutOf: host.layoutOf,
    children: () => children.list(),
    onPage: (targetId, transport, contents) => {
      const watching = [
        consoleLogs.watch(targetId, transport),
        network.watch(targetId, transport),
        inputs.watch(targetId, transport),
        children.watch(targetId, transport),
      ];
      // App pages only: a <webview> shows foreign content (docs/security.md, T23).
      if (contents.getType() !== 'webview') {
        watching.push(stateHook.watch(transport));
      }
      return {
        dispose: () => {
          for (const watch of watching) watch.dispose();
        },
      };
    },
  });
  let server: SocketServer | undefined;
  let audit: AuditSink = NO_AUDIT;
  let ipc: IpcCapture | undefined;
  const mainControl = createMainControl(host);
  try {
    // First: a crash during the rest of the start-up is recorded too.
    mainLogs.start();
    targets.start();
    const directory = prepareEndpointDir();
    // Still synchronous: IPC is hooked before the app's own main code registers anything.
    const recorder = new IpcRecorder({ valueChannels: config.ipcValueChannels });
    const waits = new SyncWaits();
    ipc = new IpcCapture({
      waits,
      app: host.app,
      ipcMain: host.ipcMain,
      defaultSession: host.defaultSession,
      allWebContents: host.allWebContents,
      recorder,
      preloadDirectory: directory,
      ...(host.utilityProcess === undefined ? {} : { utilityProcess: host.utilityProcess }),
      ...(host.createMessageChannel === undefined ? {} : { createMessageChannel: host.createMessageChannel }),
      log: (entry) => {
        logs.add(entry);
      },
    });
    ipc.start();
    const handshakePath = config.handshakePath ?? join(directory, handshakeFileName(process.pid));
    if (config.handshakePath !== undefined) assertPrivateDir(dirname(config.handshakePath));
    audit = createAudit(config, directory);
    const token = config.token ?? randomBytes(32).toString('base64url');
    const parts = { host, config, targets, directory, token, audit, recorder, waits, records, mainControl };
    server = createServer({ ...parts, pool, inputs });
    const endpoint = await server.listen();
    const handshake = new HandshakeFile(handshakePath);
    const details = handshakeFor(host, endpoint, token);
    handshake.write(details);
    refreshWhenReady(host, handshake, details);
    return running({
      ...{ endpoint, handshake, server, targets, audit, ipc, mainLogs, mainControl, mainNetwork },
      sourceMaps,
    });
  } catch (error) {
    sourceMaps?.close();
    mainNetwork.stop();
    mainControl.restore();
    mainLogs.stop();
    ipc?.stop();
    targets.stop();
    await server?.close();
    audit.close();
    throw error;
  }
}

interface ServerParts {
  readonly host: ElectronHost;
  readonly config: RuntimeConfig;
  readonly targets: ElectronTargetSource;
  readonly directory: string;
  readonly token: string;
  readonly audit: AuditSink;
  readonly recorder: IpcRecorder;
  readonly waits: SyncWaits;
  readonly records: Omit<RecordQueryDeps, 'targets'>;
  readonly mainControl: MainControl;
  readonly pool: AgentPool;
  readonly inputs: InputRecorder;
}

function createServer({
  host,
  config,
  targets,
  directory,
  token,
  audit,
  recorder,
  waits,
  records,
  mainControl,
  pool,
  inputs,
}: ServerParts): SocketServer {
  const registry = new TargetRegistry(targets);
  const recordQueries: RecordQueryDeps = { ...records, targets: registry };
  const state = new StateReader();
  const engine = new EngineFacade({
    targets: registry,
    snapshotter: new AgentSnapshotter(pool),
    actions: new ActionEngine({ pool, clock: SYSTEM_CLOCK, ipc: recorder, recorder: inputs }),
    waiter: new Waiter({ pool, clock: SYSTEM_CLOCK, ipc: recorder, state }),
    screenshots: new Screenshotter(pool),
    state,
    components: new ComponentReader(pool),
  });
  const authenticator = new Authenticator({ token, capabilities: config.capabilities });
  const sessions = new SessionRegistry({
    onControllerClosed: () => {
      pool.release();
      mainControl.restore();
    },
  });
  // Read on each session: in Launch mode the bridge starts before Electron has read the app's
  // package.json, when the name and version are still Electron's own.
  const app = {
    get name() {
      return host.app.getName();
    },
    get version() {
      return host.app.getVersion();
    },
    electron: host.electronVersion,
    pid: process.pid,
  };
  const methods: MethodHandlers = {
    'targets.list': () => engine.listTargets(),
    'snapshot.take': (input) => engine.snapshot(input),
    'dom.find': (input) => engine.find(input),
    'action.run': (input) => engine.act(input),
    'wait.for': (input) => engine.wait(input),
    'screenshot.take': (input) => engine.screenshot(input),
    'ipc.query': (input) => queryIpc(recorder, input),
    'state.read': (input) => engine.readState(input),
    'state.dispatch': (input) => engine.dispatchState(input),
    'state.component': (input) => engine.readComponent(input),
    'logs.query': (input) => queryLogs(recordQueries, input),
    'network.query': (input) => queryNetwork(recordQueries, input),
    'record.start': async () => ok({ recording: true as const, nextSeq: await inputs.start() }),
    'record.stop': async () => {
      await inputs.stop();
      return ok({ recording: false as const });
    },
    'record.events': (input) => queryRecorded(inputs, registry, input),
    ...mainControl.handlers,
    // Undo automation state: focus emulation, dialog stubs.
    'session.reset': () => {
      pool.release();
      mainControl.restore();
      return ok({ reset: true });
    },
  };
  // A page blocked on sendSync (a dialog open) fails fast and says so, instead of hanging.
  const handlers = guardBlockedPages(methods, { waits, targets: registry });
  const nonce = randomBytes(8).toString('hex');
  return new SocketServer({
    path: socketPath({ platform: process.platform, directory, pid: process.pid, nonce }),
    createSession: () => new RpcSession({ authenticator, sessions, audit, handlers, app, mode: config.mode }),
    onError: () => undefined,
  });
}

interface RunningParts {
  readonly endpoint: string;
  readonly handshake: HandshakeFile;
  readonly server: SocketServer;
  readonly targets: ElectronTargetSource;
  readonly audit: AuditSink;
  readonly ipc: IpcCapture;
  readonly mainLogs: MainLogCapture;
  readonly mainControl: MainControl;
  readonly mainNetwork: MainNetworkCapture;
  readonly sourceMaps: WorkerStackMapper | undefined;
}

function running(parts: RunningParts): Runtime {
  const { endpoint, handshake, server, targets, audit, ipc, mainLogs, mainControl, mainNetwork } = parts;
  const { sourceMaps } = parts;
  const removeHandshake = (): void => {
    handshake.remove();
  };
  process.once('exit', removeHandshake);
  return {
    endpoint,
    handshakePath: handshake.path,
    close: async () => {
      process.off('exit', removeHandshake);
      handshake.remove();
      mainControl.restore();
      sourceMaps?.close();
      mainNetwork.stop();
      mainLogs.stop();
      ipc.stop();
      targets.stop();
      await server.close();
      audit.close();
    },
  };
}
