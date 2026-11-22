import type { CdpEvent, CdpTransport, DetachReason, Disposable } from '../ports/cdp-transport.js';

type Handler = (params: object | undefined) => unknown;

/** In-memory {@link CdpTransport} for unit tests: scripted command handlers, recorded calls. */
export class FakeCdpTransport implements CdpTransport {
  readonly kind = 'in-process';
  attached = true;
  detachedReason: DetachReason | undefined;
  readonly calls: { method: string; params: object | undefined; posted: boolean }[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #eventListeners = new Set<(event: CdpEvent) => void>();
  readonly #detachListeners = new Set<(reason: DetachReason) => void>();
  readonly #attachListeners = new Set<() => void>();

  handle(method: string, handler: Handler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  send(method: string, params?: object): Promise<unknown> {
    this.calls.push({ method, params, posted: false });
    const handler = this.#handlers.get(method);
    if (!handler) return Promise.reject(new Error(`unexpected CDP command ${method}`));
    try {
      return Promise.resolve(handler(params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  post(method: string, params?: object): void {
    this.calls.push({ method, params, posted: true });
  }

  onEvent(listener: (event: CdpEvent) => void): Disposable {
    this.#eventListeners.add(listener);
    return { dispose: () => this.#eventListeners.delete(listener) };
  }

  onDetach(listener: (reason: DetachReason) => void): Disposable {
    this.#detachListeners.add(listener);
    return { dispose: () => this.#detachListeners.delete(listener) };
  }

  onAttach(listener: () => void): Disposable {
    this.#attachListeners.add(listener);
    return { dispose: () => this.#attachListeners.delete(listener) };
  }

  reattach(): void {
    this.attached = true;
    this.detachedReason = undefined;
    for (const listener of this.#attachListeners) listener();
  }

  emit(event: CdpEvent): void {
    for (const listener of this.#eventListeners) listener(event);
  }

  detach(reason: DetachReason): void {
    this.attached = false;
    this.detachedReason = reason;
    for (const listener of this.#detachListeners) listener(reason);
  }

  close(): Promise<void> {
    this.attached = false;
    return Promise.resolve();
  }
}
