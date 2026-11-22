/**
 * One runtime per process, even when two copies of the package are loaded (e.g. Launch mode injecting
 * into an app that already imports the bridge). The registry lives on a global `Symbol.for` key so
 * every bundle copy sees the same slot.
 */
const RUNTIME_KEY = Symbol.for('electron-agent-bridge.v1.runtime');

type Registry = Record<typeof RUNTIME_KEY, unknown>;

/** Return the runtime already registered in this process, if any. */
export function existingRuntime(): unknown {
  return (globalThis as unknown as Partial<Registry>)[RUNTIME_KEY];
}

/** Claim the process-wide slot. Returns false when another copy already owns it. */
export function claimRuntime(runtime: unknown): boolean {
  const registry = globalThis as unknown as Partial<Registry>;
  if (registry[RUNTIME_KEY] !== undefined) return false;
  Object.defineProperty(registry, RUNTIME_KEY, { value: runtime, configurable: true, enumerable: false });
  return true;
}

/** Release the slot (on shutdown) so tests and re-enables start clean. */
export function releaseRuntime(runtime: unknown): void {
  const registry = globalThis as unknown as Partial<Registry>;
  if (registry[RUNTIME_KEY] === runtime) Reflect.deleteProperty(registry, RUNTIME_KEY);
}
