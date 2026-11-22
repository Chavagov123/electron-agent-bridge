import type { CdpEvent, CdpTransport, Disposable } from '../ports/cdp-transport.js';
import type { Clock } from '../ports/clock.js';

/** How long activation waits for one page to confirm (a page that has not navigated yet may never). */
const ENABLE_WAIT_MS = 1_000;

/** A page's CDP session changed: a fresh one (`attach`, which may replay) or none (`detach`). */
export type SessionChange = 'attach' | 'detach';

export interface LazyDomainHandlers {
  readonly onEvent: (targetId: string, event: CdpEvent) => void;
  readonly onSession?: (targetId: string, change: SessionChange) => void;
}

interface Watched {
  readonly transport: CdpTransport;
  readonly subscriptions: Disposable[];
}

/**
 * One CDP domain (`Runtime`, `Network`) on every page, enabled only once someone asks (NFR4: no event
 * traffic into the main process before that). Events of the page's own session are handed on as they
 * arrive, also while another user (the page agent, an action) has the domain enabled. Once active, the
 * domain is enabled on every page, new ones and re-attached ones (a fresh CDP session) included.
 */
export class LazyDomain {
  readonly #enable: string;
  readonly #clock: Clock;
  readonly #handlers: LazyDomainHandlers;
  readonly #watched = new Map<string, Watched>();
  #activation: Promise<void> | undefined;

  constructor(enable: string, clock: Clock, handlers: LazyDomainHandlers) {
    this.#enable = enable;
    this.#clock = clock;
    this.#handlers = handlers;
  }

  get active(): boolean {
    return this.#activation !== undefined;
  }

  /** Follow one page for its whole life; dispose when it is gone. */
  watch(targetId: string, transport: CdpTransport): Disposable {
    this.#watched.get(targetId)?.subscriptions.forEach((subscription) => {
      subscription.dispose();
    });
    const subscriptions = [
      transport.onEvent((event) => {
        // Child sessions (auto-attached frames, workers) are not followed.
        if (event.sessionId === undefined) this.#handlers.onEvent(targetId, event);
      }),
      transport.onAttach(() => {
        this.#handlers.onSession?.(targetId, 'attach');
        if (this.active) transport.post(this.#enable);
      }),
      transport.onDetach(() => {
        this.#handlers.onSession?.(targetId, 'detach');
      }),
    ];
    this.#watched.set(targetId, { transport, subscriptions });
    // Before its first navigation a page must not be awaited (ADR-0002): post only.
    if (this.active && transport.attached) transport.post(this.#enable);
    return {
      dispose: () => {
        for (const subscription of subscriptions) subscription.dispose();
        if (this.#watched.get(targetId)?.transport === transport) this.#watched.delete(targetId);
      },
    };
  }

  /**
   * Enable the domain everywhere. Resolves once every attached page confirmed (events the domain
   * replays on enable, such as stored console messages, are delivered before that) or after a short
   * wait. Returns whether this call switched it on; a concurrent caller waits for the same start.
   */
  async activate(): Promise<boolean> {
    if (this.#activation) {
      await this.#activation;
      return false;
    }
    const pending = [...this.#watched.values()]
      .filter(({ transport }) => transport.attached)
      .map(({ transport }) => transport.send(this.#enable).catch(() => undefined));
    this.#activation = Promise.race([Promise.all(pending), this.#clock.sleep(ENABLE_WAIT_MS)]).then(
      () => undefined,
    );
    await this.#activation;
    return true;
  }
}
