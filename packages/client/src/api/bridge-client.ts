import {
  BridgeError,
  Methods,
  envelopeSchema,
  type Envelope,
  type Handshake,
  type MethodData,
  type MethodName,
  type MethodParams,
} from '@electron-agent-bridge/core';

/**
 * What carries a client's calls: the runtime's socket (`connect`), or an engine in this process
 * (`@electron-agent-bridge/attach`). Rejects with a `BridgeError`.
 */
export interface RpcCaller {
  readonly closed: boolean;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** Methods a client calls after authentication. */
export type CallableMethod = Exclude<MethodName, 'session.auth'>;

/** Per-call options. */
export interface CallOptions {
  readonly timeoutMs?: number;
}

/** What the runtime granted at authentication. */
export type SessionInfo = MethodData<'session.auth'>;

/**
 * A typed, authenticated connection to one app. Results are validated against the protocol table,
 * so a mismatched runtime fails loudly instead of returning malformed data.
 */
export class BridgeClient {
  readonly session: SessionInfo;
  readonly handshake: Handshake;
  readonly #connection: RpcCaller;

  constructor(connection: RpcCaller, session: SessionInfo, handshake: Handshake) {
    this.#connection = connection;
    this.session = session;
    this.handshake = handshake;
  }

  get closed(): boolean {
    return this.#connection.closed;
  }

  async call<M extends CallableMethod>(
    method: M,
    params: MethodParams<M>,
    options: CallOptions = {},
  ): Promise<Envelope<MethodData<M>>> {
    const raw = await this.#connection.call(method, params, options.timeoutMs);
    const parsed = envelopeSchema(Methods[method].data).safeParse(raw);
    if (!parsed.success) {
      throw new BridgeError('INTERNAL', `malformed ${method} result from the app`, {
        hint: 'Client and runtime versions may differ.',
      });
    }
    // The schema was built from Methods[method].data, which is exactly MethodData<M>.
    return parsed.data as unknown as Envelope<MethodData<M>>;
  }

  close(): void {
    this.#connection.close();
  }
}
