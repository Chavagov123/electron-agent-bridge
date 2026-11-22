import type { WebContents } from 'electron';

import { guardHostDebugger } from './debugger-guard.js';
import { InProcessDebuggerTransport } from './in-process-debugger-transport.js';

/**
 * Owns the bridge's debugger connection to one webContents for its whole life: attach at creation,
 * yield to the host app and take the debugger back once it lets go, and re-attach when the page
 * loads again (e.g. after a crash). Whether the host holds the debugger is read from Electron, never
 * tracked separately, so the two cannot disagree. After `stop()` nothing re-attaches, even if a
 * deferred re-attach or a guard that could not be restored fires later.
 */
export class DebuggerSession {
  readonly transport: InProcessDebuggerTransport;
  readonly #contents: WebContents;
  #restoreGuard: (() => void) | undefined;
  #stopped = false;
  readonly #onLoading = (): void => {
    this.#reattach();
  };

  constructor(contents: WebContents) {
    this.#contents = contents;
    this.transport = new InProcessDebuggerTransport(contents.debugger);
  }

  /** Synchronous: never awaits anything before the page's first navigation (ADR-0002). */
  start(): void {
    this.transport.attach();
    this.#restoreGuard = guardHostDebugger(this.#contents.debugger, {
      bridgeHolds: () => this.transport.attached,
      beforeHostAttach: () => {
        this.transport.yieldTo('host-debugger');
      },
      afterHostRelease: () => {
        // Let the host's detach settle before taking the debugger back.
        setImmediate(() => {
          this.#reattach();
        });
      },
    });
    this.#contents.on('did-start-loading', this.#onLoading);
  }

  stop(): void {
    this.#stopped = true;
    this.#restoreGuard?.();
    this.#restoreGuard = undefined;
    if (!this.#contents.isDestroyed()) this.#contents.off('did-start-loading', this.#onLoading);
    void this.transport.close();
  }

  #reattach(): void {
    if (this.#stopped || this.#contents.isDestroyed() || this.transport.attached) return;
    // Stays detached with reason `host-debugger` while the app still holds the debugger.
    this.transport.attach();
  }
}
