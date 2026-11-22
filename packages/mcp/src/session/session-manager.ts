import { BridgeError } from '@eab/core';
import type { AppInstance, BridgeClient, ConnectOptions, LaunchedApp, LaunchOptions } from '@eab/client';

/** The client functions the MCP server needs; injected so tools can be tested without sockets. */
export interface ClientApi {
  connect(options: ConnectOptions): Promise<BridgeClient>;
  listInstances(): AppInstance[];
  launch(options: LaunchOptions): Promise<LaunchedApp>;
  /** Attach mode: renderers over a remote debugging port (absent: not offered). */
  attach?(options: { readonly port: number; readonly host?: string }): Promise<BridgeClient>;
}

export interface SessionManagerOptions {
  /**
   * When we give up control and reconnect, the app may not have processed our old connection's close
   * yet, so the new one would come back as an observer. Retry this many times before accepting that.
   */
  readonly handoverRetries?: number;
  readonly handoverDelayMs?: number;
  /**
   * Whether `launch` may grant `eval`. Set by the operator who starts the MCP server
   * (`eab-mcp --allow-eval`), never by the agent: an agent must not raise its own ceiling.
   */
  readonly allowEval?: boolean;
}

/** App arguments that open a debugger or inject code: as powerful as `eval`, so gated like it. */
const DEBUG_FLAG =
  /^--(?:inspect(?:-brk|-port|-publish-uid)?|remote-debugging-(?:port|pipe|address)|js-flags)(?:=|$)/;

/**
 * Holds the one app connection an MCP session works against, and the app it launched, if any: a
 * launched app belongs to the session and is closed with it (or replaced by the next launch).
 */
export class SessionManager {
  readonly #api: ClientApi;
  readonly #retries: number;
  readonly #delayMs: number;
  readonly #allowEval: boolean;
  #client: BridgeClient | undefined;
  #options: ConnectOptions = {};
  #connecting: Promise<BridgeClient> | undefined;
  #launched: LaunchedApp | undefined;
  /** Set while the session is attached (Attach mode), to attach again after a drop. */
  #attached: { readonly port: number; readonly host?: string } | undefined;
  /** Bumped by close(): work that started before a close must not resurrect the session. */
  #epoch = 0;

  constructor(api: ClientApi, options: SessionManagerOptions = {}) {
    this.#api = api;
    this.#retries = options.handoverRetries ?? 20;
    this.#delayMs = options.handoverDelayMs ?? 50;
    this.#allowEval = options.allowEval ?? false;
  }

  list(): AppInstance[] {
    return this.#api.listInstances();
  }

  /**
   * Replace the connection. Calls are serialized: overlapping connects (e.g. parallel tool calls
   * reconnecting after a drop) run one after another, and only the last connection is kept open.
   */
  connect(options: ConnectOptions): Promise<BridgeClient> {
    return this.#serialized(
      () => this.#replace(options),
      (client) => client,
    );
  }

  /** Start an app with the bridge injected and work against it (Launch mode). */
  launch(options: LaunchOptions): Promise<LaunchedApp> {
    const debugFlag = options.args?.find((arg) => DEBUG_FLAG.test(arg));
    if (!this.#allowEval && (options.allowEval === true || debugFlag !== undefined)) {
      const what = debugFlag === undefined ? 'grant eval to launched apps' : `launch with ${debugFlag}`;
      return Promise.reject(
        new BridgeError('CAPABILITY_DENIED', `this MCP server may not ${what}`, {
          hint: 'The operator can allow it by starting the server with `eab-mcp --allow-eval`.',
        }),
      );
    }
    // Taken now: a close() before the queued work starts counts too.
    const epoch = this.#epoch;
    return this.#serialized(
      async () => {
        this.#release();
        const launched = await this.#api.launch(options);
        if (epoch !== this.#epoch) {
          // The session was closed while the app was starting: it must not outlive the session.
          await launched.close();
          throw new BridgeError('NOT_FOUND', 'the session was closed while the app was launching', {
            hint: 'Launch it again.',
          });
        }
        this.#launched = launched;
        this.#client = launched.client;
        this.#options = { pid: launched.pid, ...(options.role === undefined ? {} : { role: options.role }) };
        return launched;
      },
      (launched) => launched.client,
    );
  }

  /**
   * Attach to a running app's renderers over its remote debugging port. Whoever reaches that port has
   * full control of the pages, so this is gated like `eval` (`eab-mcp --allow-eval`).
   */
  attach(options: { readonly port: number; readonly host?: string }): Promise<BridgeClient> {
    const api = this.#api;
    if (api.attach === undefined)
      return Promise.reject(new BridgeError('UNSUPPORTED', 'this server cannot attach'));
    if (!this.#allowEval) {
      return Promise.reject(
        new BridgeError('CAPABILITY_DENIED', 'this MCP server may not attach over a remote debugging port', {
          hint: 'The operator can allow it by starting the server with `eab-mcp --allow-eval`.',
        }),
      );
    }
    const epoch = this.#epoch;
    return this.#serialized(
      async () => {
        // Like connecting elsewhere: an app this session launched keeps running (it may be the very app
        // being attached to, through its remote debugging port), and closes with the session.
        this.#disconnect();
        const client = await (api.attach?.(options) ??
          Promise.reject(new BridgeError('UNSUPPORTED', 'this server cannot attach')));
        if (epoch !== this.#epoch) {
          // The session was closed while attaching: the pages' sockets must not outlive it.
          client.close();
          throw new BridgeError('NOT_FOUND', 'the session was closed while attaching', {
            hint: 'Attach again.',
          });
        }
        this.#client = client;
        this.#attached = options;
        return client;
      },
      (client) => client,
    );
  }

  /** The app this session launched, while it runs. */
  launchedApp(): LaunchedApp | undefined {
    return this.#launched;
  }

  /** Run connection changes one after another; `current()` waits for the one in progress. */
  #serialized<T>(work: () => Promise<T>, clientOf: (value: T) => BridgeClient): Promise<T> {
    const previous = this.#connecting ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const client = next.then(clientOf);
    this.#connecting = client;
    // On `next` itself, so it runs before the caller's own continuation sees the session again.
    const settle = (): void => {
      if (this.#connecting === client) this.#connecting = undefined;
    };
    next.then(settle, settle);
    client.catch(() => undefined);
    return next;
  }

  /**
   * The current connection. If it dropped, reconnects to the same app with the same options
   * (role, capabilities) — once, shared by concurrent callers.
   */
  async current(): Promise<BridgeClient> {
    if (this.#connecting) return this.#connecting;
    const client = this.#client;
    if (!client) {
      throw new BridgeError('NOT_FOUND', 'not connected to an app', {
        hint: 'Call the session tool with action "connect" first (or "list" to see running apps).',
      });
    }
    if (!client.closed) return client;
    if (this.#attached !== undefined) return this.attach(this.#attached);
    return this.connect({ ...this.#options, pid: client.handshake.pid });
  }

  status(): BridgeClient | undefined {
    return this.#client;
  }

  /** Disconnect, and close the app this session launched (killing it and its processes). */
  close(): void {
    this.#epoch++;
    this.#release();
  }

  #release(): void {
    this.#disconnect();
    // The kill itself is synchronous; waiting for the exit is not needed here.
    void this.#launched?.close();
    this.#launched = undefined;
  }

  #disconnect(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#attached = undefined;
  }

  async #replace(options: ConnectOptions): Promise<BridgeClient> {
    const wasController = this.#client?.session.role === 'controller';
    // Connecting elsewhere keeps a launched app running; closing the session closes it.
    this.#disconnect();
    let client = await this.#api.connect(options);
    const wantsControl = options.role !== 'observer';
    for (let attempt = 0; wasController && wantsControl && client.session.role === 'observer'; attempt++) {
      if (attempt >= this.#retries) break;
      client.close();
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
      client = await this.#api.connect(options);
    }
    this.#client = client;
    this.#options = options;
    return client;
  }
}
