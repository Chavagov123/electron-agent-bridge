import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultEndpointDirectory } from '@electron-agent-bridge/client';
import { BridgeError } from '@electron-agent-bridge/core';

/** Where tool output too large to return inline is written. Returns the file path. */
export interface SpillSink {
  write(text: string): string;
}

/** Spilled files older than this are removed on the next spill. */
export const SPILL_TTL_MS = 60 * 60 * 1000;

/**
 * Spill files in a private directory next to the bridge endpoints (owner-only: output may contain page
 * content). Old files are swept on every write, so the directory stays small without a timer.
 */
export class FileSpill implements SpillSink {
  readonly #directory: string;
  readonly #now: () => number;

  constructor(directory = join(defaultEndpointDirectory(), 'spill'), now: () => number = Date.now) {
    this.#directory = directory;
    this.#now = now;
  }

  write(text: string): string {
    ensurePrivateDir(this.#directory);
    this.#sweep();
    const path = join(this.#directory, `output-${this.#now()}-${randomBytes(4).toString('hex')}.txt`);
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    return path;
  }

  #sweep(): void {
    for (const name of readdirSync(this.#directory)) {
      if (!/^output-\d+-[0-9a-f]+\.txt$/.test(name)) continue;
      const path = join(this.#directory, name);
      try {
        if (this.#now() - statSync(path).mtimeMs > SPILL_TTL_MS) rmSync(path, { force: true });
      } catch {
        // Removed concurrently: nothing to do.
      }
    }
  }
}

/** On POSIX: a real directory owned by this user, without group/other access. */
function ensurePrivateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== process.getuid?.()) {
    throw new BridgeError('UNSUPPORTED', `${directory} is not a private directory`, {
      hint: 'Remove it, or point XDG_RUNTIME_DIR/TMPDIR at a directory you own.',
    });
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700);
}
