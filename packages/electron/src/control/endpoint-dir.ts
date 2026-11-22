import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError } from '@electron-agent-bridge/core';

/**
 * Create (or verify) the per-user endpoint directory. On POSIX it must be a real directory owned by
 * this user with no group/other access, otherwise another local user could squat or read endpoints.
 * Windows relies on the per-user temp directory ACLs and random pipe names (ADR-0001).
 */
export function ensureEndpointDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new BridgeError('UNSUPPORTED', `${directory} is not a plain directory`, {
      hint: 'Remove it, or point XDG_RUNTIME_DIR/TMPDIR elsewhere.',
    });
  }
  if (stats.uid !== process.getuid?.()) {
    throw new BridgeError('UNSUPPORTED', `${directory} is owned by another user`, {
      hint: 'Point XDG_RUNTIME_DIR or TMPDIR at a directory you own.',
    });
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700);
}

/**
 * For a user-chosen location (e.g. `EAB_HANDSHAKE`): on POSIX the directory must be a real directory
 * owned by this user that nobody else can write to, or someone could swap the file under us.
 */
export function assertPrivateDir(directory: string): void {
  if (process.platform === 'win32') return;
  const stats = lstatSync(directory);
  const private_ = !stats.isSymbolicLink() && stats.isDirectory() && stats.uid === process.getuid?.();
  if (!private_ || (stats.mode & 0o022) !== 0) {
    throw new BridgeError('UNSUPPORTED', `${directory} is not a private directory`, {
      hint: 'Use a directory you own that group/others cannot write to.',
    });
  }
}

/** Audit logs of exited processes are kept this long for inspection, then removed. */
export const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove handshake files and sockets left behind by processes that no longer exist, and their
 * audit logs once older than {@link AUDIT_RETENTION_MS}. Best effort: anything unexpected is left alone.
 */
export function sweepStaleEndpoints(
  directory: string,
  isAlive: (pid: number) => boolean,
  now: number = Date.now(),
): void {
  for (const name of safeReaddir(directory)) {
    const endpoint = /^(\d+)\.json$/.exec(name) ?? /^eab-(\d+)-[A-Za-z0-9_-]+\.sock$/.exec(name);
    const audit = /^audit-(\d+)\.jsonl(?:\.1)?$/.exec(name);
    const pid = Number((endpoint ?? audit)?.[1]);
    if ((!endpoint && !audit) || pid === process.pid || isAlive(pid)) continue;
    const path = join(directory, name);
    if (audit && now - modifiedAt(path) < AUDIT_RETENTION_MS) continue;
    rmSync(path, { force: true });
  }
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** Whether a process with this pid exists (signal 0 probes without delivering a signal). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
