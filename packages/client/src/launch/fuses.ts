import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { LaunchStrategy } from './environment.js';

/** Marks the start of Electron's fuse wire in its binary (Electron 12+). */
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Fuse names by their position in wire version 1. Later positions are reported as `fuse<N>`. */
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
] as const;

export type FuseState = 'on' | 'off' | 'removed';

/** The fuses of an Electron binary as written in it. */
export interface FuseReport {
  /** The file the wire was read from (on macOS, the Electron Framework inside the bundle). */
  readonly file: string;
  readonly wireVersion: number;
  readonly fuses: Readonly<Record<string, FuseState>>;
}

/** Which fuse each launch strategy needs. */
export const STRATEGY_FUSES: Readonly<Record<LaunchStrategy, string>> = {
  'node-options': 'EnableNodeOptionsEnvironmentVariable',
  inspector: 'EnableNodeCliInspectArguments',
};

/** Where the fuse wire lives: macOS bundles keep it in the Electron Framework, not the executable. */
export function fuseFileOf(executable: string): string {
  if (executable.endsWith('.app')) {
    return resolve(
      executable,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    );
  }
  if (/\.app[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.test(executable)) {
    return resolve(
      dirname(executable),
      '..',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    );
  }
  return executable;
}

/**
 * Read the fuses of an Electron binary without loading it whole (it is often 100+ MB): the file is
 * scanned in chunks for the sentinel, and the wire after it decoded. `undefined` when the file has no
 * fuse wire (not Electron, or older than 12) or cannot be read.
 */
export async function readFuses(executable: string): Promise<FuseReport | undefined> {
  const file = fuseFileOf(executable);
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const at = await findSentinel(handle);
    if (at === undefined) return undefined;
    const header = Buffer.alloc(2 + 255);
    const { bytesRead } = await handle.read(header, 0, header.length, at + SENTINEL.length);
    if (bytesRead < 2) return undefined;
    const wireVersion = header[0] ?? 0;
    const length = Math.min(header[1] ?? 0, bytesRead - 2);
    const fuses: Record<string, FuseState> = {};
    for (let index = 0; index < length; index++) {
      const state = stateOf(header[2 + index]);
      if (state !== undefined) fuses[FUSE_NAMES[index] ?? `fuse${index}`] = state;
    }
    return { file, wireVersion, fuses };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function findSentinel(handle: Awaited<ReturnType<typeof open>>): Promise<number | undefined> {
  const { size } = await handle.stat();
  const overlap = SENTINEL.length - 1;
  const buffer = Buffer.alloc(CHUNK_BYTES + overlap);
  for (let start = 0; start < size; start += CHUNK_BYTES) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - start), start);
    const found = buffer.subarray(0, bytesRead).indexOf(SENTINEL);
    if (found !== -1) return start + found;
  }
  return undefined;
}

function stateOf(byte: number | undefined): FuseState | undefined {
  if (byte === 0x31) return 'on';
  if (byte === 0x30) return 'off';
  if (byte === 0x72) return 'removed';
  return undefined;
}

/** Launch strategies the binary's fuses rule out (an unknown fuse rules out nothing). */
export function blockedStrategies(report: FuseReport | undefined): LaunchStrategy[] {
  if (report === undefined) return [];
  return (Object.keys(STRATEGY_FUSES) as LaunchStrategy[]).filter((strategy) => {
    const state = report.fuses[STRATEGY_FUSES[strategy]];
    return state === 'off' || state === 'removed';
  });
}

/** The app's code packaged as an asar archive next to the executable (`resources/app.asar`). */
export function asarOf(executable: string): string {
  const mac = /\.app([\\/]|$)/.exec(executable);
  if (mac?.index !== undefined)
    return join(executable.slice(0, mac.index + 4), 'Contents', 'Resources', 'app.asar');
  return join(dirname(executable), 'resources', 'app.asar');
}
