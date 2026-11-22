import type { Debugger } from 'electron';

export interface HostDebuggerHooks {
  /** Whether the bridge (not the host) currently holds the debugger. */
  readonly bridgeHolds: () => boolean;
  /** The host is about to attach: release the debugger so its call succeeds as it would without us. */
  readonly beforeHostAttach: () => void;
  /** The host let go (detached, or its attach failed): the debugger may be free again. */
  readonly afterHostRelease: () => void;
}

/**
 * Host-first debugger etiquette (ADR-0006). Makes the bridge invisible to the host app's use of
 * `webContents.debugger`:
 * - `isAttached()` reports only the host's own attachment, so `if (!isAttached()) attach()` works;
 * - `attach()` makes the bridge yield first, so the host's call succeeds as it would without us;
 * - `detach()` while only the bridge holds the debugger is a no-op for the host (it was not attached
 *   from its point of view), so a defensive detach never tears down the bridge's session;
 * - after the host detaches (or its attach fails), the bridge may take the debugger back.
 * `this`, arguments, return values and thrown errors are preserved. The bridge's own calls use the
 * originals captured by its transport and never pass through here.
 *
 * @returns a function that restores the original methods.
 */
export function guardHostDebugger(debuggerApi: Debugger, hooks: HostDebuggerHooks): () => void {
  const restores = [
    wrap(
      debuggerApi,
      'isAttached',
      (original) =>
        function (this: Debugger): boolean {
          return original.call(this) && !hooks.bridgeHolds();
        },
    ),
    wrap(
      debuggerApi,
      'attach',
      (original) =>
        function (this: Debugger, ...args: Parameters<Debugger['attach']>): void {
          hooks.beforeHostAttach();
          try {
            original.apply(this, args);
          } catch (error) {
            hooks.afterHostRelease();
            throw error;
          }
        },
    ),
    wrap(
      debuggerApi,
      'detach',
      (original) =>
        function (this: Debugger, ...args: Parameters<Debugger['detach']>): void {
          if (hooks.bridgeHolds()) return;
          try {
            original.apply(this, args);
          } finally {
            hooks.afterHostRelease();
          }
        },
    ),
  ];
  return () => {
    for (const restore of restores) restore();
  };
}

type GuardedMethod = 'attach' | 'detach' | 'isAttached';

function wrap<K extends GuardedMethod>(
  target: Debugger,
  key: K,
  make: (original: Debugger[K]) => Debugger[K],
): () => void {
  // Indexed access with a generic key does not trip unbound-method; the wrapper re-applies the receiver.
  const original = target[key];
  const hadOwnProperty = Object.hasOwn(target, key);
  const wrapped = make(original);
  Object.defineProperty(target, key, { value: wrapped, configurable: true, writable: true });
  return () => {
    if (target[key] !== wrapped) return;
    if (hadOwnProperty) {
      Object.defineProperty(target, key, { value: original, configurable: true, writable: true });
    } else {
      Reflect.deleteProperty(target, key);
    }
  };
}
