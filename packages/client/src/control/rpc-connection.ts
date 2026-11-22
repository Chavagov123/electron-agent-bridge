import { connect as netConnect, type Socket } from 'node:net';

import {
  BridgeError,
  ERROR_CODES,
  LineDecoder,
  RpcResponseSchema,
  encodeLine,
  type ErrorCode,
  type RpcResponse,
} from '@electron-agent-bridge/core';

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: BridgeError) => void;
  readonly timer: NodeJS.Timeout;
}

/** Default per-call timeout. Snapshots of large pages are the slowest calls. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** JSON-RPC 2.0 over an NDJSON socket: request ids, timeouts, and failure of all pending calls on close. */
export class RpcConnection {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  readonly #decoder = new LineDecoder();
  #nextId = 1;
  #closedError: BridgeError | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#onData(chunk);
    });
    socket.on('close', () => {
      this.#failAll(new BridgeError('TRANSPORT_CLOSED', 'connection to the app closed'));
    });
    socket.on('error', () => socket.destroy());
  }

  /** Open a connection to a named pipe / Unix socket. */
  static open(path: string, timeoutMs: number): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeError('TIMEOUT', `could not connect to ${path} within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new RpcConnection(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new BridgeError('TRANSPORT_CLOSED', `cannot connect to ${path}: ${error.message}`, {
            hint: 'The app may have exited; list running apps again.',
            cause: error,
          }),
        );
      });
    });
  }

  get closed(): boolean {
    return this.#closedError !== undefined;
  }

  call(method: string, params: unknown, timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError('TIMEOUT', `${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.#socket.destroy();
  }

  #onData(chunk: string): void {
    let lines: string[];
    try {
      lines = this.#decoder.push(chunk);
    } catch (error) {
      this.#failAll(BridgeError.from(error));
      this.#socket.destroy();
      return;
    }
    for (const line of lines) this.#settle(line);
  }

  #settle(line: string): void {
    const message = safeJson(line);
    const id = responseId(message);
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (id === undefined || !pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const parsed = RpcResponseSchema.safeParse(message);
    if (!parsed.success) {
      // Fail the call now rather than letting it run into its timeout.
      pending.reject(
        new BridgeError('INTERNAL', 'malformed response from the app', {
          hint: 'Client and runtime versions may differ.',
        }),
      );
      return;
    }
    const response: RpcResponse = parsed.data;
    if ('result' in response) pending.resolve(response.result);
    else pending.reject(toBridgeError(response.error));
  }

  #failAll(error: BridgeError): void {
    this.#closedError ??= error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function responseId(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const id: unknown = (message as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}

/** Map a wire error to a BridgeError; codes this client does not know become INTERNAL, keeping the original. */
function toBridgeError(error: {
  message: string;
  data?: { code: string; hint?: string | undefined } | undefined;
}): BridgeError {
  const code = error.data?.code;
  const hint = error.data?.hint;
  const options = hint === undefined ? {} : { hint };
  if (code !== undefined && isErrorCode(code)) return new BridgeError(code, error.message, options);
  const prefix = code === undefined ? '' : `[${code}] `;
  return new BridgeError('INTERNAL', `${prefix}${error.message}`, options);
}

function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
