import { renameSync, rmSync, writeFileSync } from 'node:fs';

import type { Handshake } from '@eab/core';

/**
 * Writes the discovery file clients read to find the endpoint and token.
 * Owner-only (0600) and written atomically, so a reader never sees a half-written token.
 */
export class HandshakeFile {
  readonly path: string;
  #written = false;

  constructor(path: string) {
    this.path = path;
  }

  write(handshake: Handshake): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    // Exclusive create: never write the token through a file (or symlink) someone else prepared.
    // `rmSync` removes a leftover link itself, not its target.
    rmSync(temporary, { force: true });
    writeFileSync(temporary, `${JSON.stringify(handshake)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path);
    this.#written = true;
  }

  /** Rewrite the file with new details, unless it was removed meanwhile (the bridge stopped). */
  update(handshake: Handshake): void {
    if (this.#written) this.write(handshake);
  }

  /** Synchronous so it can run from `process.on('exit')`. */
  remove(): void {
    if (!this.#written) return;
    this.#written = false;
    rmSync(this.path, { force: true });
  }
}
