import { z } from 'zod';

import { BridgeError } from '../errors/bridge-error.js';
import { utf8Length } from '../util/utf8.js';

/**
 * Name of the directory that holds handshake files and Unix sockets. Kept short: macOS temp paths are
 * long and socket paths are limited to ~104 bytes.
 */
export const ENDPOINT_DIR_NAME = 'eab-bridge';

/** macOS limits `sun_path` to 104 bytes including the terminator; Linux to 108. Use the smaller. */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Contents of `<endpoint dir>/<pid>.json`, written by the runtime and read by clients. Owner-only. */
export const HandshakeSchema = z.object({
  schema: z.literal(1),
  protocolVersion: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.number().int(),
  endpoint: z.string().min(1),
  token: z.string().min(1),
  app: z.object({ name: z.string(), version: z.string() }),
  electron: z.string(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

export interface EndpointDirInput {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tmpdir: string;
  /** Current user id on POSIX (`process.getuid()`); makes a shared temp dir per-user. */
  readonly uid?: number;
}

/**
 * Per-user endpoint directory.
 * - Windows: `<per-user temp>\eab-bridge`.
 * - POSIX with `$XDG_RUNTIME_DIR` (already per-user, 0700): `$XDG_RUNTIME_DIR/eab-bridge`.
 * - POSIX otherwise: `<temp>/eab-bridge-<uid>`, because `/tmp` is shared between users and a fixed
 *   name could be pre-created by someone else.
 */
export function endpointDirectory({ platform, env, tmpdir, uid }: EndpointDirInput): string {
  if (platform === 'win32') return `${trimSeparators(tmpdir)}\\${ENDPOINT_DIR_NAME}`;
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  if (runtimeDir !== undefined && runtimeDir !== '') {
    return `${trimSeparators(runtimeDir)}/${ENDPOINT_DIR_NAME}`;
  }
  const suffix = uid === undefined ? '' : `-${uid}`;
  return `${trimSeparators(tmpdir)}/${ENDPOINT_DIR_NAME}${suffix}`;
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

export interface SocketPathInput {
  readonly platform: string;
  readonly directory: string;
  readonly pid: number;
  /** Random, unguessable suffix so other users cannot pre-create the endpoint. */
  readonly nonce: string;
}

/** Named pipe on Windows, Unix domain socket elsewhere. Throws `UNSUPPORTED` when the path is too long. */
export function socketPath({ platform, directory, pid, nonce }: SocketPathInput): string {
  if (platform === 'win32') return `\\\\.\\pipe\\eab-${pid}-${nonce}`;
  const path = `${directory}/eab-${pid}-${nonce}.sock`;
  if (utf8Length(path) > MAX_SOCKET_PATH_BYTES) {
    throw new BridgeError('UNSUPPORTED', `socket path is too long (${path})`, {
      hint: 'Set XDG_RUNTIME_DIR or TMPDIR to a shorter directory.',
    });
  }
  return path;
}

/** File name of the handshake for a process. */
export function handshakeFileName(pid: number): string {
  return `${pid}.json`;
}
