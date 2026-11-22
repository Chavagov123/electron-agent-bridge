import { BridgeError } from '@electron-agent-bridge/core';
import type { CdpEvent, CdpTransport, DetachReason, Disposable } from '@electron-agent-bridge/engine';
import type { Debugger } from 'electron';

/** CDP protocol version requested from `webContents.debugger`. */
const PROTOCOL = '1.3';

/**
 * CDP over Electron's in-process `webContents.debugger` (ADR-0002): no port, unaffected by fuses.
 * The original `attach`/`detach`/`isAttached` are captured at construction, before any host guard wraps them,
 * so the bridge's own calls are never mistaken for the host app's.
 */
export class InProcessDebuggerTransport implements CdpTransport {
  readonly kind = 'in-process';
  readonly #debugger: Debugger;
  readonly #attachOriginal: Debugger['attach'];
  readonly #detachOriginal: Debugger['detach'];
  readonly #isAttachedOriginal: Debugger['isAttached'];
  readonly #eventListeners = new Set<(event: CdpEvent) => void>();
  readonly #detachListeners = new Set<(reason: DetachReason) => void>();
  readonly #attachListeners = new Set<() => void>();
  #attached = false;
  #detachedReason: DetachReason | undefined = 'closed';

  constructor(debuggerApi: Debugger) {
    this.#debugger = debuggerApi;
    this.#attachOriginal = debuggerApi.attach.bind(debuggerApi);
    this.#detachOriginal = debuggerApi.detach.bind(debuggerApi);
    this.#isAttachedOriginal = debuggerApi.isAttached.bind(debuggerApi);
    debuggerApi.on('message', (_event, method, params: unknown, sessionId) => {
      // While the host holds the debugger, its traffic flows through the same object: not ours.
      if (!this.#attached) return;
      const event: CdpEvent = sessionId ? { method, params, sessionId } : { method, params };
      for (const listener of this.#eventListeners) listener(event);
    });
    debuggerApi.on('detach', (_event, reason) => {
      if (this.#attached) this.#markDetached(mapReason(reason));
    });
  }

  get attached(): boolean {
    return this.#attached;
  }

  get detachedReason(): DetachReason | undefined {
    return this.#attached ? undefined : this.#detachedReason;
  }

  /** Attach; returns false (and stays detached) when someone else already holds the debugger. */
  attach(): boolean {
    if (this.#attached) return true;
    if (this.#isAttachedOriginal()) {
      this.#detachedReason = 'host-debugger';
      return false;
    }
    try {
      this.#attachOriginal(PROTOCOL);
      this.#attached = true;
      this.#detachedReason = undefined;
      for (const listener of this.#attachListeners) listener();
    } catch {
      this.#detachedReason = 'unknown';
    }
    return this.#attached;
  }

  async send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    if (!this.#attached) throw new BridgeError('DETACHED', `debugger not attached (${method})`);
    try {
      return (await this.#debugger.sendCommand(method, params, sessionId)) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = this.#isAttachedOriginal() ? 'INTERNAL' : 'TRANSPORT_CLOSED';
      throw new BridgeError(code, `${method} failed: ${message}`, { cause: error });
    }
  }

  post(method: string, params?: object, sessionId?: string): void {
    if (!this.#attached) return;
    this.#debugger.sendCommand(method, params, sessionId).catch(() => undefined);
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

  /** Give the debugger up (e.g. because the host app wants it). */
  yieldTo(reason: DetachReason): void {
    if (!this.#attached) return;
    this.#attached = false;
    try {
      this.#detachOriginal();
    } catch {
      // Already gone; nothing to release.
    }
    this.#markDetached(reason);
  }

  close(): Promise<void> {
    this.yieldTo('closed');
    return Promise.resolve();
  }

  #markDetached(reason: DetachReason): void {
    this.#attached = false;
    this.#detachedReason = reason;
    for (const listener of this.#detachListeners) listener(reason);
  }
}

/** Electron's detach reasons are free text; map the known ones. */
function mapReason(reason: string): DetachReason {
  const text = reason.toLowerCase();
  if (text.includes('target closed')) return 'target-closed';
  if (text.includes('render process gone') || text.includes('crash')) return 'crashed';
  return 'unknown';
}
