import { formatWithOptions } from 'node:util';

import type { LogEntry } from '@eab/core';

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** Wrapped calls in progress: a logger that logs through another wrapped one is recorded once. */
export interface ReentryGuard {
  depth: number;
}

/** Logger method name → level (`log`, `trace` and unknown names are info/debug). */
export function levelOfMethod(method: string): LogEntry['level'] {
  const name = method.toLowerCase();
  if (name === 'error' || name === 'fatal' || name === 'critical' || name === 'assert') return 'error';
  if (name === 'warn' || name === 'warning') return 'warn';
  if (name === 'debug' || name === 'trace' || name === 'verbose' || name === 'silly') return 'debug';
  return 'info';
}

/** Bounds for inspecting logged objects: the entry is clipped anyway, so never inspect a whole store. */
const INSPECT_LIMITS = { depth: 3, maxArrayLength: 20, maxStringLength: 2_000, breakLength: Infinity };

/** What the logger would print for these arguments (printf-style, objects inspected within bounds). */
export function formatArgs(args: readonly unknown[]): string {
  try {
    return formatWithOptions(INSPECT_LIMITS, ...args);
  } catch {
    return '[unformattable log arguments]';
  }
}

/**
 * Wrap `methods` of `target` (wrap and delegate: the original runs first, with the same `this` and
 * arguments; its result and exceptions are the caller's). `record` sees each call; it is not called
 * for calls made from inside another wrapped call. Returns the undo, which restores only methods that
 * are still ours.
 */
export function wrapLoggerMethods(
  target: Record<string, unknown>,
  methods: readonly string[],
  record: (method: string, args: readonly unknown[]) => void,
  guard: ReentryGuard,
): () => void {
  const restore: (() => void)[] = [];
  for (const name of methods) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const call = original as Method;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const outermost = guard.depth === 0;
      guard.depth++;
      try {
        return call.apply(this, args);
      } finally {
        guard.depth--;
        if (outermost) {
          try {
            record(name, args);
          } catch {
            // Recording must never change what the app's logger does.
          }
        }
      }
    };
    try {
      target[name] = wrapper;
    } catch {
      // A frozen or read-only logger stays as it is (and unrecorded).
      continue;
    }
    restore.push(() => {
      if (target[name] === wrapper) target[name] = original;
    });
  }
  return () => {
    for (const step of restore) step();
  };
}
