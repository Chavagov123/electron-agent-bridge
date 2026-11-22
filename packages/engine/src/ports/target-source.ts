import type { TargetKind } from '@electron-agent-bridge/core';

import type { CdpTransport } from './cdp-transport.js';

/** A page the runtime knows about, with the transport that reaches it (if attached). */
export interface TargetDescriptor {
  readonly id: string;
  readonly kind: TargetKind;
  readonly title: string;
  readonly url: string;
  /** Whether this target currently has user focus. Used to pick a default target. */
  readonly focused: boolean;
  readonly transport: CdpTransport;
  /** A name the app chose for this page; wins over every derived name. */
  readonly nameHint?: string;
  /** Still loading: its title may not be final, so derived names are not frozen yet. */
  readonly loading?: boolean;
  /** On screen: its window shown, its view visible and sized. Unknown when absent. */
  readonly visible?: boolean;
  /** Pixels of its window's content area it shows in (0 when hidden in it), even while the window is hidden. */
  readonly area?: number;
  /** Paint order in its window: 0 is the window's own page, higher is drawn above. */
  readonly stack?: number;
  /** The target id of the window that hosts it (itself for a window's own page). */
  readonly ownerId?: string;
}

/** Lists the pages of the host. Implemented by the Electron runtime; faked in tests. */
export interface TargetSource {
  list(): readonly TargetDescriptor[];
}
