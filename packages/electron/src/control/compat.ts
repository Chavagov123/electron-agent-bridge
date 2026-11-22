import { parseVersion, type Envelope } from '@eab/core';

/** Target kinds a protocol 1.0 client knows (its schema is a closed enum). */
const V1_0_TARGET_KINDS = new Set(['window', 'view', 'webview', 'other']);
/** IPC kinds and sides a protocol 1.0 client knows. */
const V1_0_IPC_KINDS = new Set(['send', 'sendSync', 'invoke', 'handle', 'on', 'toRenderer', 'postMessage']);
const V1_0_IPC_SIDES = new Set(['main', 'renderer']);

interface Kinded {
  readonly kind?: string;
  readonly side?: string;
}

/**
 * A result as a client of `clientVersion` can read it. A 1.0 client validates results against closed
 * enums, so values added in 1.1 would fail its whole call: new target kinds (workers, offscreen pages)
 * are shown as `other`, and IPC records of the new kinds (utility, port, contextBridge) are left out.
 * Newer clients get the result unchanged.
 */
export function forClient(
  clientVersion: string,
  method: string,
  result: Envelope<unknown>,
): Envelope<unknown> {
  const version = parseVersion(clientVersion);
  if (version?.major !== 1 || version.minor >= 1) return result;
  if (method === 'targets.list') {
    return mapList(result, 'targets', (target) =>
      V1_0_TARGET_KINDS.has(target.kind ?? '') ? target : { ...target, kind: 'other' },
    );
  }
  if (method === 'ipc.query') {
    return filterList(
      result,
      'items',
      (event) => V1_0_IPC_KINDS.has(event.kind ?? '') && V1_0_IPC_SIDES.has(event.side ?? ''),
    );
  }
  return result;
}

function mapList(result: Envelope<unknown>, key: string, map: (item: Kinded) => Kinded): Envelope<unknown> {
  const data = result.data as Record<string, unknown>;
  const list = data[key];
  if (!Array.isArray(list)) return result;
  return { ...result, data: { ...data, [key]: (list as Kinded[]).map(map) } };
}

function filterList(
  result: Envelope<unknown>,
  key: string,
  keep: (item: Kinded) => boolean,
): Envelope<unknown> {
  const data = result.data as Record<string, unknown>;
  const list = data[key];
  if (!Array.isArray(list)) return result;
  return { ...result, data: { ...data, [key]: (list as Kinded[]).filter(keep) } };
}
