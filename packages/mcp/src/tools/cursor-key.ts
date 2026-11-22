/**
 * Which records a cursor belongs to: the app's pid and when its bridge started. That stays the same
 * across reconnects to one app (its records go on), and changes with every attach, whose records start
 * again at 1 (a cursor from an earlier attach would skip them).
 */
export function appKey(handshake: { readonly pid: number; readonly startedAt: number }): string {
  return `${String(handshake.pid)}@${String(handshake.startedAt)}`;
}

/** Key for remembered snapshot cursors: one per app, page and snapshot scope. */
export function cursorKey(
  app: string,
  scope: {
    readonly target?: string | undefined;
    readonly root?: string | undefined;
    readonly depth?: number | undefined;
    readonly fidelity?: string | undefined;
  },
): string {
  return JSON.stringify([
    app,
    scope.target ?? '',
    scope.root ?? '',
    scope.depth ?? 0,
    scope.fidelity ?? 'dom',
  ]);
}
