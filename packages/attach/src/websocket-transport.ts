import { BridgeError, type DetachReason } from '@eab/core';
import type { CdpEvent, CdpTransport, Disposable } from '@eab/engine';

/** How long one command may take before it fails (a hung page must not hang the agent). */
const COMMAND_TIMEOUT_MS = 30_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: BridgeError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/** A socket like the global `WebSocket` (Node 22+), injectable for tests. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

/**
 * CDP over one page's DevTools WebSocket (`ws://host:port/devtools/page/<id>`), for Attach mode. One
 * socket per page, so the engine sees no session ids of its own; child sessions (auto-attached frames
 * and workers) carry theirs as usual. When the socket closes, the page is detached for good: a page
 * that comes back is a new target.
 */
export class WebSocketCdpTransport implements CdpTransport {
  readonly kind = 'websocket' as const;
  readonly #socket: SocketLike;
  readonly #pending = new Map<number, Pending>();
  readonly #events = new Set<(event: CdpEvent) => void>();
  readonly #detaches = new Set<(reason: DetachReason) => void>();
  #next = 1;
  #detached: DetachReason | undefined;

  private constructor(socket: SocketLike) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      this.#onMessage(event.data);
    });
    socket.addEventListener('close', () => {
      this.#markDetached('target-closed');
    });
  }

  /** Open the page's socket; rejects when it cannot be reached. */
  static open(
    url: string,
    factory: SocketFactory = (address) => new WebSocket(address),
  ): Promise<WebSocketCdpTransport> {
    return new Promise((resolve, reject) => {
      const socket = factory(url);
      const transport = new WebSocketCdpTransport(socket);
      socket.addEventListener('open', () => {
        resolve(transport);
      });
      socket.addEventListener('error', () => {
        reject(new BridgeError('TRANSPORT_CLOSED', `cannot open ${url}`));
      });
    });
  }

  get attached(): boolean {
    return this.#detached === undefined && this.#socket.readyState === OPEN;
  }

  get detachedReason(): DetachReason | undefined {
    return this.#detached;
  }

  send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    if (!this.attached) {
      return Promise.reject(
        new BridgeError('DETACHED', `the page is not attached (${this.#detached ?? 'closed'})`),
      );
    }
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError('TIMEOUT', `${method} took longer than ${COMMAND_TIMEOUT_MS} ms`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          ...(params === undefined ? {} : { params }),
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }

  post(method: string, params?: object, sessionId?: string): void {
    this.send(method, params, sessionId).catch(() => undefined);
  }

  onEvent(listener: (event: CdpEvent) => void): Disposable {
    this.#events.add(listener);
    return { dispose: () => this.#events.delete(listener) };
  }

  onDetach(listener: (reason: DetachReason) => void): Disposable {
    this.#detaches.add(listener);
    return { dispose: () => this.#detaches.delete(listener) };
  }

  /** A page socket never re-attaches. */
  onAttach(): Disposable {
    return { dispose: () => undefined };
  }

  close(): Promise<void> {
    this.#markDetached('closed');
    this.#socket.close();
    return Promise.resolve();
  }

  #onMessage(data: unknown): void {
    let message: Message;
    try {
      message = JSON.parse(String(data)) as Message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new BridgeError('INTERNAL', message.error.message ?? 'CDP command failed'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    const event: CdpEvent = {
      method: message.method,
      params: message.params,
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    };
    for (const listener of [...this.#events]) listener(event);
  }

  #markDetached(reason: DetachReason): void {
    if (this.#detached !== undefined) return;
    this.#detached = reason;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('DETACHED', `the page went away (${reason})`));
    }
    this.#pending.clear();
    for (const listener of [...this.#detaches]) listener(reason);
  }
}
