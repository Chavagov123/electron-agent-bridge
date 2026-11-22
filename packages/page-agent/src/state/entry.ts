import { installClickTracking } from './clicks.js';
import { installDevtoolsShim } from './devtools-shim.js';
import { StateRegistry } from './registry.js';

/** Where `registerState` (in `@electron-agent-bridge/electron/renderer`) and the runtime find the registry. */
export const STATE_KEY = 'electron-agent-bridge.v1.state';
/** Where `registerState` queues stores registered before this hook ran. */
export const STATE_PENDING_KEY = 'electron-agent-bridge.v1.state-pending';

interface Pending {
  readonly name: unknown;
  readonly store: unknown;
  readonly options?: unknown;
  undo?: () => void;
}

export interface StateHookConfig {
  readonly devtoolsShim?: boolean;
  /** Track click listeners so snapshots can give role-less clickable elements refs. Default on. */
  readonly clickListeners?: boolean;
}

/**
 * The main-world state hook (ADR-0007), evaluated in every new document of an app page before its
 * scripts. Top-level frames only (never iframes); idempotent; defines nothing visible to the page
 * except, when the app opted in, the devtools globals.
 */
export function install(config: StateHookConfig): void {
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  const page = globalThis as unknown as Record<string | symbol, unknown>;
  const key = Symbol.for(STATE_KEY);
  if (page[key] !== undefined) return;
  const registry = new StateRegistry();
  Object.defineProperty(page, key, {
    value: registry,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  if (config.devtoolsShim === true) installDevtoolsShim(registry, page);
  if (config.clickListeners !== false) installClickTracking(window);
  takeOverPending(registry, page[Symbol.for(STATE_PENDING_KEY)]);
}

/** Stores the page registered before the hook ran (it can arrive late in a page's first document). */
function takeOverPending(registry: StateRegistry, pending: unknown): void {
  if (!Array.isArray(pending)) return;
  for (const entry of pending.splice(0) as Pending[]) {
    try {
      const options = typeof entry.options === 'object' && entry.options !== null ? entry.options : {};
      entry.undo = registry.register(String(entry.name), entry.store, options);
    } catch {
      // A broken entry must not stop the others.
    }
  }
}
