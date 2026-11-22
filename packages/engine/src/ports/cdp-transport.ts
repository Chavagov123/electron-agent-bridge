import type { DetachReason } from '@electron-agent-bridge/core';

export type { DetachReason };

/** Something that can be stopped. Returned by every subscription. */
export interface Disposable {
  dispose(): void;
}

/** A CDP event as delivered by a transport. */
export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}

/**
 * A Chrome DevTools Protocol connection to one page.
 * v1 ships the in-process `webContents.debugger` adapter; a WebSocket adapter is additive (v1.1).
 */
export interface CdpTransport {
  readonly kind: 'in-process' | 'websocket';
  /** Send a command and await its result. Rejects with a `BridgeError`. */
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  /**
   * Send a command without awaiting it. Required before a page's first navigation, where
   * commands may not resolve until navigation starts (ADR-0002). Failures are swallowed.
   */
  post(method: string, params?: object, sessionId?: string): void;
  onEvent(listener: (event: CdpEvent) => void): Disposable;
  onDetach(listener: (reason: DetachReason) => void): Disposable;
  /**
   * The transport (re)attached: a fresh CDP session, so anything set up on the previous one
   * (enabled domains, scripts to evaluate on new documents) must be set up again.
   */
  onAttach(listener: () => void): Disposable;
  readonly attached: boolean;
  /** Why the transport is detached; `undefined` while attached. */
  readonly detachedReason: DetachReason | undefined;
  close(): Promise<void>;
}
