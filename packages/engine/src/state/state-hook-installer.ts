import type { CdpTransport, Disposable } from '../ports/cdp-transport.js';

/**
 * Puts the main-world state hook into a page before its scripts run (ADR-0007): registered for every
 * new document from the page's creation on, again on each fresh CDP session, and run at once in the
 * current document (the hook is idempotent). Posted, never awaited: the page has not navigated yet.
 */
export class StateHookInstaller {
  readonly #source: string;

  constructor(source: string) {
    this.#source = source;
  }

  watch(transport: CdpTransport): Disposable {
    if (transport.attached) this.install(transport);
    return transport.onAttach(() => {
      this.install(transport);
    });
  }

  /** Register the hook for new documents of this page now (and run it in the current one). */
  install(transport: CdpTransport): void {
    if (!transport.attached) return;
    // Scripts for new documents are evaluated only while the Page domain is enabled.
    transport.post('Page.enable');
    transport.post('Page.addScriptToEvaluateOnNewDocument', { source: this.#source, runImmediately: true });
  }
}
