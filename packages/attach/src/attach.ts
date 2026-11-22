import { BridgeClient, type RpcCaller } from '@electron-agent-bridge/client';
import {
  BridgeError,
  LIMITATION_CODES,
  Methods,
  PROTOCOL_VERSION,
  isMethodName,
  ok,
  type Envelope,
  type Handshake,
  type MethodInput,
  type MethodName,
} from '@electron-agent-bridge/core';
import {
  ActionEngine,
  AgentPool,
  AgentSnapshotter,
  ChildSessions,
  ComponentReader,
  ConsoleCollector,
  EngineFacade,
  InputRecorder,
  LogBook,
  NetworkLog,
  Screenshotter,
  StateHookInstaller,
  StateReader,
  TargetRegistry,
  Waiter,
  queryLogs,
  queryNetwork,
  queryRecorded,
  withDeadline,
  type Clock,
  type Disposable,
} from '@electron-agent-bridge/engine';
import { AGENT_SOURCE, AGENT_VERSION, stateHookSource } from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import { RemoteTargetSource } from './remote-targets.js';
import { WebSocketCdpTransport, type SocketFactory } from './websocket-transport.js';

export interface AttachOptions {
  /** The app's `--remote-debugging-port`. */
  readonly port: number;
  /** Default `127.0.0.1`. */
  readonly host?: string;
  readonly fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  readonly socket?: SocketFactory;
}

/** Feature groups Attach mode serves: pages and their stores, no main process. */
const FEATURES = ['pages', 'state'];
const MAIN_ONLY = new Set<MethodName>([
  'ipc.query',
  'app.info',
  'window.control',
  'menu.click',
  'dialog.stub',
  'main.eval',
]);
const Version = z.object({
  Browser: z.string().optional(),
  'User-Agent': z.string().optional(),
  webSocketDebuggerUrl: z.string().optional(),
});
const ProcessInfo = z.object({
  processInfo: z.array(z.object({ type: z.string(), id: z.number().int() })),
});
/** How long the browser target may take to say which process is the app's main one. */
const PROCESS_INFO_MS = 2_000;

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Handler = (input: never) => Envelope<unknown> | Promise<Envelope<unknown>>;

/**
 * Attach mode (protocol 1.1): drive the renderers of a running Electron app through its remote debugging
 * port, with the engine running in this process — no runtime inside the app. Snapshots, actions, waits,
 * screenshots, console and network logs, store and component state and recording work as usual;
 * main-process features (IPC, main logs, menus, dialogs, windows, `main.eval`) answer `UNSUPPORTED`.
 * Anyone who can reach the port has this much control: treat it like `eval`.
 */
export async function attach(options: AttachOptions): Promise<BridgeClient> {
  const base = `http://${options.host ?? '127.0.0.1'}:${options.port}`;
  const fetcher = options.fetch ?? ((url: string) => fetch(url));
  const version = await readVersion(fetcher, base);
  const pid = await browserPid(version.browserUrl, options.socket);
  const pool = new AgentPool({ source: AGENT_SOURCE, version: AGENT_VERSION });
  const logs = new LogBook();
  const consoleLogs = new ConsoleCollector(logs, SYSTEM_CLOCK);
  const network = new NetworkLog(SYSTEM_CLOCK);
  const inputs = new InputRecorder({ pool, clock: SYSTEM_CLOCK });
  const stateHook = new StateHookInstaller(stateHookSource({ devtoolsShim: false, clickListeners: true }));
  const children = new ChildSessions((child) =>
    watchAll([consoleLogs.watch(child.id, child.transport), network.watch(child.id, child.transport)]),
  );
  const source = new RemoteTargetSource({
    base,
    ...(options.socket === undefined ? {} : { socket: options.socket }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    onPage: (id, transport) =>
      watchAll([
        consoleLogs.watch(id, transport),
        network.watch(id, transport),
        inputs.watch(id, transport),
        stateHook.watch(transport),
        children.watch(id, transport),
      ]),
  });
  await source.start();
  const targets = new TargetRegistry(source);
  const state = new StateReader();
  const engine = new EngineFacade({
    targets,
    snapshotter: new AgentSnapshotter(pool),
    actions: new ActionEngine({ pool, clock: SYSTEM_CLOCK, recorder: inputs }),
    waiter: new Waiter({ pool, clock: SYSTEM_CLOCK, state }),
    screenshots: new Screenshotter(pool),
    state,
    components: new ComponentReader(pool),
  });
  const records = { logs, console: consoleLogs, network, targets };
  const handlers: Partial<Record<MethodName, Handler>> = {
    'targets.list': () => engine.listTargets(),
    'snapshot.take': (input: MethodInput<'snapshot.take'>) => engine.snapshot(input),
    'dom.find': (input: MethodInput<'dom.find'>) => engine.find(input),
    'action.run': (input: MethodInput<'action.run'>) => engine.act(input),
    'wait.for': (input: MethodInput<'wait.for'>) => engine.wait(input),
    'screenshot.take': (input: MethodInput<'screenshot.take'>) => engine.screenshot(input),
    'state.read': async (input: MethodInput<'state.read'>) => withStoreHint(await engine.readState(input)),
    'state.dispatch': (input: MethodInput<'state.dispatch'>) => engine.dispatchState(input),
    'state.component': (input: MethodInput<'state.component'>) => engine.readComponent(input),
    'logs.query': (input: MethodInput<'logs.query'>) => queryLogs(records, input),
    'network.query': (input: MethodInput<'network.query'>) => queryNetwork(records, input),
    'record.start': async () => ok({ recording: true as const, nextSeq: await inputs.start() }),
    'record.stop': async () => {
      await inputs.stop();
      return ok({ recording: false as const });
    },
    'record.events': (input: MethodInput<'record.events'>) => queryRecorded(inputs, targets, input),
    'session.reset': () => {
      pool.release();
      return ok({ reset: true });
    },
  };
  let closed = false;
  const caller: RpcCaller = {
    get closed() {
      return closed;
    },
    call: async (method, params) => {
      if (closed) throw new BridgeError('TRANSPORT_CLOSED', 'the attach session is closed');
      return dispatch(handlers, method, params);
    },
    close: () => {
      closed = true;
      pool.release();
      source.stop();
    },
  };
  const app = { name: version.name, version: version.version, electron: version.electron, pid };
  const handshake: Handshake = {
    schema: 1,
    protocolVersion: PROTOCOL_VERSION,
    pid,
    startedAt: Date.now(),
    endpoint: base,
    token: 'attach',
    app: { name: app.name, version: app.version },
    electron: version.electron,
  };
  return new BridgeClient(
    caller,
    {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: `attach-${options.port}`,
      role: 'controller',
      capabilities: ['observe', 'interact'],
      app,
      mode: 'attach',
      features: FEATURES,
    },
    handshake,
  );
}

async function dispatch(
  handlers: Partial<Record<MethodName, Handler>>,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!isMethodName(method)) throw new BridgeError('UNSUPPORTED', `unknown method ${method}`);
  const handler = handlers[method];
  if (handler === undefined) {
    throw new BridgeError('UNSUPPORTED', `${method} needs the bridge inside the app`, {
      hint: MAIN_ONLY.has(method)
        ? 'Attach mode reaches renderers only. For IPC, main logs and main control use Integrated or Launch mode.'
        : 'Not available in Attach mode.',
    });
  }
  const parsed = Methods[method].params.safeParse(params ?? {});
  if (!parsed.success) {
    throw new BridgeError(
      'INVALID_PARAMS',
      `invalid params for ${method}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return handler(parsed.data as never);
}

function watchAll(watching: readonly Disposable[]): Disposable {
  return {
    dispose: () => {
      for (const watch of watching) watch.dispose();
    },
  };
}

interface Endpoint {
  readonly electron: string;
  /** The app's name and version, as Electron puts them in its user agent. */
  readonly name: string;
  readonly version: string;
  /** The browser target's socket. */
  readonly browserUrl: string | undefined;
}

/**
 * What the endpoint says of the app: Electron's user agent names the app and its version before
 * Chrome's (`… (KHTML, like Gecko) MyApp/1.2.0 Chrome/140… Electron/45.0.0 …`).
 */
async function readVersion(fetcher: NonNullable<AttachOptions['fetch']>, base: string): Promise<Endpoint> {
  let response: { ok: boolean; json(): Promise<unknown> };
  try {
    response = await fetcher(`${base}/json/version`);
  } catch {
    throw new BridgeError('NOT_FOUND', `nothing answers at ${base}`, {
      hint: 'Start the app with --remote-debugging-port=<port> (and pass that port).',
    });
  }
  const version = Version.safeParse(response.ok ? await response.json() : {});
  const agent = version.success ? (version.data['User-Agent'] ?? '') : '';
  const app = /\(KHTML, like Gecko\) ([^\s/]+)\/(\S+) Chrome\//.exec(agent);
  return {
    electron: /Electron\/([\d.]+)/.exec(agent)?.[1] ?? 'unknown',
    name: app?.[1] ?? 'electron-app',
    version: app?.[2] ?? '',
    browserUrl: version.success ? version.data.webSocketDebuggerUrl : undefined,
  };
}

/** The app's main process id, from the browser target; 0 when it cannot be told. */
async function browserPid(url: string | undefined, socket: SocketFactory | undefined): Promise<number> {
  if (url === undefined) return 0;
  let transport: WebSocketCdpTransport | undefined;
  try {
    transport = await WebSocketCdpTransport.open(url, socket);
    // Late or failed: parsed as nothing, so 0.
    const info = ProcessInfo.safeParse(
      await withDeadline(transport.send('SystemInfo.getProcessInfo'), PROCESS_INFO_MS),
    );
    return info.success ? (info.data.processInfo.find((entry) => entry.type === 'browser')?.id ?? 0) : 0;
  } catch {
    return 0;
  } finally {
    void transport?.close();
  }
}

/** No store found: in Attach mode that usually means they were made before the bridge was there. */
export function withStoreHint<T extends { stores: readonly unknown[] }>(result: Envelope<T>): Envelope<T> {
  if (result.data.stores.length > 0) return result;
  return {
    ...result,
    limitations: [
      ...result.limitations,
      {
        code: LIMITATION_CODES.degraded,
        message:
          'No store is registered. Attach mode connects after the page loaded, so stores made at startup ' +
          'are found once the page reloads (the state hook then runs first); Launch mode sees them at once.',
      },
    ],
  };
}
