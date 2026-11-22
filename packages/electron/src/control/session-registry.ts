import { randomBytes } from 'node:crypto';

import type { SessionRole } from '@eab/core';

/** A connected, authenticated client. */
export interface OpenSession {
  readonly sessionId: string;
  readonly role: SessionRole;
}

/**
 * At most one controller at a time; everyone else observes. The controller slot frees when that
 * session closes, so the next client to connect can take control.
 */
export class SessionRegistry {
  #controller: string | undefined;
  readonly #onControllerClosed: () => void;

  /** `onControllerClosed`: undo what the controller changed in the app (automation state). */
  constructor(options: { onControllerClosed?: () => void } = {}) {
    this.#onControllerClosed = options.onControllerClosed ?? (() => undefined);
  }

  open(wantsControl: boolean): OpenSession {
    const sessionId = randomBytes(6).toString('hex');
    if (wantsControl && this.#controller === undefined) {
      this.#controller = sessionId;
      return { sessionId, role: 'controller' };
    }
    return { sessionId, role: 'observer' };
  }

  close(sessionId: string): void {
    if (this.#controller !== sessionId) return;
    this.#controller = undefined;
    this.#onControllerClosed();
  }
}
