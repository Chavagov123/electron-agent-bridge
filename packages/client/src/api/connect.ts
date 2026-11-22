import {
  BridgeError,
  Methods,
  PROTOCOL_VERSION,
  envelopeSchema,
  type Capability,
  type Handshake,
  type MethodParams,
  type SessionRole,
} from '@electron-agent-bridge/core';

import { listInstances, readHandshake } from '../control/discovery.js';
import { RpcConnection } from '../control/rpc-connection.js';
import { BridgeClient } from './bridge-client.js';

export interface ConnectOptions {
  /** Connect to the app with this process id. */
  readonly pid?: number;
  /** Connect using this handshake file (Launch mode knows its path). */
  readonly handshakePath?: string;
  /** Directory to search for handshakes; defaults to the per-user endpoint directory. */
  readonly directory?: string;
  readonly timeoutMs?: number;
  /** Identifies the caller in the app's audit log. */
  readonly client?: { readonly name: string; readonly version: string };
  /** Ask for fewer capabilities than the app allows (least privilege). */
  readonly capabilities?: readonly Capability[];
  /** `observer` never takes control; default `controller` (downgraded if another client controls). */
  readonly role?: SessionRole;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Connect to a bridge-enabled app: by handshake path, by pid, or the most recently started app.
 * Authenticates with the token from the handshake and negotiates the protocol version.
 */
export async function connect(options: ConnectOptions = {}): Promise<BridgeClient> {
  const handshake = findHandshake(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connection = await RpcConnection.open(handshake.endpoint, timeoutMs);
  try {
    const params: MethodParams<'session.auth'> = {
      token: handshake.token,
      protocolVersion: PROTOCOL_VERSION,
      client: options.client ?? { name: '@electron-agent-bridge/client', version: PROTOCOL_VERSION },
      ...(options.capabilities ? { capabilities: [...options.capabilities] } : {}),
      ...(options.role ? { role: options.role } : {}),
    };
    const raw = await connection.call('session.auth', params, timeoutMs);
    const parsed = envelopeSchema(Methods['session.auth'].data).safeParse(raw);
    if (!parsed.success) {
      throw new BridgeError('INTERNAL', 'malformed session.auth result from the app', {
        hint: 'Client and runtime versions may differ.',
      });
    }
    return new BridgeClient(connection, parsed.data.data, handshake);
  } catch (error) {
    connection.close();
    throw error;
  }
}

function findHandshake(options: ConnectOptions): Handshake {
  if (options.handshakePath !== undefined) return readHandshake(options.handshakePath);
  const instances = listInstances(options.directory);
  const match =
    options.pid === undefined
      ? instances[0]
      : instances.find((instance) => instance.handshake.pid === options.pid);
  if (match) return match.handshake;
  throw new BridgeError(
    'NOT_FOUND',
    options.pid === undefined
      ? 'no bridge-enabled app is running'
      : `no bridge-enabled app with pid ${options.pid}`,
    { hint: 'Start the app with EAB_ENABLE=1 and the bridge imported first in its main process.' },
  );
}
