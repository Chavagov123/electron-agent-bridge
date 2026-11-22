/**
 * Names apps give their pages with `nameTarget()`. Stored on a global `Symbol.for` key so a name set
 * through one bundle copy (or before the bridge starts, or while it is off) is seen by the runtime.
 */
const NAMES_KEY = Symbol.for('electron-agent-bridge.v1.target-names');

function registry(): WeakMap<object, string> {
  const slot = globalThis as unknown as Partial<Record<typeof NAMES_KEY, WeakMap<object, string>>>;
  let names = slot[NAMES_KEY];
  if (!names) {
    names = new WeakMap();
    Object.defineProperty(slot, NAMES_KEY, { value: names, configurable: true, enumerable: false });
  }
  return names;
}

/** Remember an explicit name for a webContents (weakly: it disappears with the page). */
export function setTargetName(contents: object, name: string): void {
  registry().set(contents, name);
}

/** The explicit name for a webContents, if the app gave one. */
export function targetNameOf(contents: object): string | undefined {
  return registry().get(contents);
}
