import { BridgeError, type DetachReason } from '@electron-agent-bridge/core';

import type { CdpTransport } from '../ports/cdp-transport.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { PageAgentClient, type AgentBundle } from './page-agent-client.js';

const DETACHED_HINTS: Record<DetachReason, string> = {
  'host-debugger':
    'The app itself is using webContents.debugger on this page; the bridge re-attaches when the app detaches.',
  'target-closed': 'The page was closed.',
  crashed: 'The page crashed; the bridge re-attaches after it reloads.',
  closed: 'The bridge is shutting down.',
  unknown: 'Retry; if it persists, list targets again.',
};

/** `DETACHED` for a page whose debugger session is gone, with the reason and what to do. */
export function detachedError(what: string, transport: CdpTransport): BridgeError {
  const reason = transport.detachedReason ?? 'unknown';
  return new BridgeError('DETACHED', `${what} is not attached (${reason})`, { hint: DETACHED_HINTS[reason] });
}

/** One {@link PageAgentClient} per page, created on first use and shared by snapshots, actions and waits. */
export class AgentPool {
  readonly #bundle: AgentBundle;
  readonly #clients = new WeakMap<CdpTransport, PageAgentClient>();
  /** Pages whose behaviour was changed for automation, restored by {@link release}. */
  readonly #automated = new Set<PageAgentClient>();

  constructor(bundle: AgentBundle) {
    this.#bundle = bundle;
  }

  /** The client for an attached target; `DETACHED` (with the reason and what to do) otherwise. */
  clientFor(target: TargetDescriptor): PageAgentClient {
    if (!target.transport.attached) throw detachedError(`target "${target.id}"`, target.transport);
    let client = this.#clients.get(target.transport);
    if (!client) {
      client = new PageAgentClient(target.transport, this.#bundle);
      this.#clients.set(target.transport, client);
    }
    return client;
  }

  /**
   * Make the page behave as focused while it is automated (pages in background windows otherwise see
   * blur and skip focus-dependent behaviour). Undone by {@link release}.
   */
  emulateFocus(client: PageAgentClient): void {
    client.ensure(FOCUS_EMULATION, { enabled: true });
    this.#automated.add(client);
  }

  /** Restore every automated page (the controller disconnected or reset its session). */
  release(): void {
    for (const client of this.#automated) {
      client.forget(FOCUS_EMULATION, { enabled: true });
      if (client.transport.attached) client.transport.post(FOCUS_EMULATION, { enabled: false });
    }
    this.#automated.clear();
  }
}

const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled';
