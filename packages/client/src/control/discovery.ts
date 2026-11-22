import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeError, HandshakeSchema, endpointDirectory, type Handshake } from '@electron-agent-bridge/core';

/** A running app that has the bridge enabled. */
export interface AppInstance {
  readonly handshakePath: string;
  readonly handshake: Handshake;
}

/** The per-user endpoint directory, computed exactly like the runtime does. */
export function defaultEndpointDirectory(): string {
  const uid = process.getuid?.();
  return endpointDirectory({
    platform: process.platform,
    env: process.env,
    tmpdir: tmpdir(),
    ...(uid === undefined ? {} : { uid }),
  });
}

/** Read and validate one handshake file. */
export function readHandshake(path: string): Handshake {
  let raw: string;
  try {
    assertPrivate(path, 0o077);
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('NOT_FOUND', `no handshake at ${path}`, { cause: error });
  }
  const parsed = HandshakeSchema.safeParse(safeJson(raw));
  if (!parsed.success) throw new BridgeError('INVALID_PARAMS', `malformed handshake at ${path}`);
  return parsed.data;
}

/** Running bridge-enabled apps of this user, newest first. Stale files (dead pids) are skipped. */
export function listInstances(directory: string = defaultEndpointDirectory()): AppInstance[] {
  const instances: AppInstance[] = [];
  try {
    assertPrivate(directory, 0o022);
  } catch {
    return instances;
  }
  for (const name of safeReaddir(directory)) {
    const filePid = /^(\d+)\.json$/.exec(name)?.[1];
    if (filePid === undefined) continue;
    const handshakePath = join(directory, name);
    try {
      const handshake = readHandshake(handshakePath);
      const genuine = handshake.pid === Number(filePid) && isAlive(handshake.pid);
      if (genuine) instances.push({ handshakePath, handshake });
    } catch {
      // Unreadable or half-written: not a usable instance.
    }
  }
  return instances.sort((a, b) => b.handshake.startedAt - a.handshake.startedAt);
}

/**
 * On POSIX, refuse files and directories that another user owns, that are symlinks, or that grant
 * `forbiddenMode` bits: a shared temp dir must not let someone else plant a handshake (Windows relies
 * on the per-user temp directory's ACL).
 */
function assertPrivate(path: string, forbiddenMode: number): void {
  if (process.platform === 'win32') return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & forbiddenMode) !== 0) {
    throw new BridgeError('UNAUTHORIZED', `${path} is not private to the current user`, {
      hint: 'Only handshakes written by your own user are trusted.',
    });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
