import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from 'node:fs';

import type { ErrorCode } from '@eab/core';

/**
 * One audited call. Deliberately metadata only: never params, values, tokens or page content, so
 * the log is safe to keep and share.
 */
export interface AuditEntry {
  readonly ts: number;
  readonly method: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly session?: string;
  readonly client?: string;
  readonly code?: ErrorCode;
}

/** Where audit entries go. */
export interface AuditSink {
  record(entry: AuditEntry): void;
  close(): void;
}

/** Audit disabled (`EAB_AUDIT=0`). */
export const NO_AUDIT: AuditSink = { record: () => undefined, close: () => undefined };

export interface FileAuditLogOptions {
  readonly path: string;
  /** Rotate to `<path>.1` past this size; at most two files exist. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
/**
 * Append, create owner-only, and never follow a symlink someone planted at the path. Node types
 * declare `O_NOFOLLOW` everywhere, but it does not exist on Windows (where it is not needed).
 */
const NO_FOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW;

/**
 * Append-only JSONL audit file, owner-only (0600), size-capped with one rotation. Writes are
 * synchronous and tiny; any I/O failure disables the log instead of affecting the app.
 */
export class FileAuditLog implements AuditSink {
  readonly #path: string;
  readonly #maxBytes: number;
  #fd: number | undefined;
  #bytes = 0;

  constructor(options: FileAuditLogOptions) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#fd = this.#open();
  }

  record(entry: AuditEntry): void {
    if (this.#fd === undefined) return;
    const line = `${JSON.stringify(entry)}\n`;
    try {
      const fd = this.#bytes + Buffer.byteLength(line) > this.#maxBytes ? this.#rotate() : this.#fd;
      if (fd === undefined) return;
      this.#bytes += writeSync(fd, line);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.#fd === undefined) return;
    try {
      closeSync(this.#fd);
    } catch {
      // Already closed.
    }
    this.#fd = undefined;
  }

  #open(): number | undefined {
    try {
      const fd = openSync(this.#path, OPEN_FLAGS, 0o600);
      this.#bytes = fstatSync(fd).size;
      return fd;
    } catch {
      return undefined;
    }
  }

  /** Move the full file aside and start a new one; returns the new descriptor. */
  #rotate(): number | undefined {
    this.close();
    renameSync(this.#path, `${this.#path}.1`);
    this.#fd = this.#open();
    return this.#fd;
  }
}
