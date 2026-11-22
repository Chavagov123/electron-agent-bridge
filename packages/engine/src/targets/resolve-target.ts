import { BridgeError } from '@electron-agent-bridge/core';

import type { TargetDescriptor } from '../ports/target-source.js';

/**
 * Pick the target a call applies to: the one whose id or name equals `selector` (names compare
 * case-insensitively), else the main page on screen (see {@link defaultTarget}).
 */
export function resolveTarget<T extends TargetDescriptor & { readonly name?: string }>(
  targets: readonly T[],
  selector?: string,
): T {
  if (selector !== undefined) {
    const wanted = selector.toLowerCase();
    const match =
      targets.find((target) => target.id === selector) ??
      targets.find((target) => target.name?.toLowerCase() === wanted);
    if (match) return match;
    throw new BridgeError('NOT_FOUND', `no target "${selector}"`, {
      hint:
        targets.length > 0
          ? `Known targets: ${targets.map((t) => (t.name === undefined ? t.id : `${t.name} (${t.id})`)).join(', ')}.`
          : 'The app has no pages.',
    });
  }
  const fallback = defaultTarget(targets);
  if (fallback) return fallback;
  throw new BridgeError('NOT_FOUND', 'the app has no pages yet', { hint: 'Wait for a window to open.' });
}

/** Share of a window a view must cover to stand for it: apps built from views draw content above. */
const COVERING = 0.5;

/**
 * The main page on screen: in the window holding focus (else the first visible window, else the first
 * window), the topmost visible view covering at least half of it, else the window's own page. Without
 * windows, the first target.
 */
function defaultTarget<T extends TargetDescriptor>(targets: readonly T[]): T | undefined {
  const windows = targets.filter((target) => target.kind === 'window');
  const focusedOwner = targets.find((target) => target.focused)?.ownerId;
  const window =
    windows.find((target) => target.focused || target.id === focusedOwner) ??
    windows.find((target) => target.visible !== false) ??
    windows[0];
  // Without windows: a page that is not a worker (offscreen pages and views can still be acted on).
  if (window === undefined)
    return targets.find((target) => target.kind !== 'worker' && target.kind !== 'serviceWorker');
  const covering = targets
    .filter((target) => target.ownerId === window.id && target.id !== window.id)
    .filter((target) => (target.area ?? 0) > 0 && (target.area ?? 0) >= (window.area ?? 0) * COVERING)
    .sort((a, b) => (b.stack ?? 0) - (a.stack ?? 0));
  return covering[0] ?? window;
}
