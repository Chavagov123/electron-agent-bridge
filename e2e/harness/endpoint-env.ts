import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { endpointDirectory } from '@eab/core';

/** A private endpoint directory, so a spec only ever sees the apps it launched. */
export interface IsolatedEndpoint {
  /** Environment to give both the app and the client so they agree on the directory. */
  readonly env: Readonly<Record<string, string>>;
  /** The directory handshake files land in. */
  readonly directory: string;
  cleanup(): void;
}

/**
 * Windows: point TEMP/TMP at a fresh directory. POSIX: point XDG_RUNTIME_DIR at a short fresh directory
 * under /tmp (macOS temp paths are long and Unix socket paths are limited to ~104 bytes).
 */
export function isolatedEndpoint(): IsolatedEndpoint {
  const windows = process.platform === 'win32';
  const base = mkdtempSync(windows ? join(tmpdir(), 'eab-e2e-') : '/tmp/eab-');
  const env: Record<string, string> = windows ? { TEMP: base, TMP: base } : { XDG_RUNTIME_DIR: base };
  return {
    env,
    directory: endpointDirectory({ platform: process.platform, env, tmpdir: base }),
    cleanup: () => {
      // Electron helper processes can hold temp files briefly after the main pid exits (EBUSY on Windows).
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}
