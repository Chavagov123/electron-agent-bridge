import { timingSafeEqual } from 'node:crypto';

import {
  BridgeError,
  PROTOCOL_VERSION,
  isProtocolCompatible,
  type Capability,
  type MethodInput,
} from '@electron-agent-bridge/core';

export interface AuthenticatorDeps {
  readonly token: string;
  /** The app's ceiling: no session ever gets more. */
  readonly capabilities: readonly Capability[];
}

/** Verifies a `session.auth` request and computes the capabilities it may have. */
export class Authenticator {
  readonly #deps: AuthenticatorDeps;
  readonly #expected: Buffer;

  constructor(deps: AuthenticatorDeps) {
    this.#deps = deps;
    this.#expected = Buffer.from(deps.token, 'utf8');
  }

  /**
   * @returns the capabilities granted: the app's ceiling, narrowed to what the client asked for.
   * @throws `UNAUTHORIZED` for a wrong token, `VERSION_MISMATCH` for an incompatible protocol.
   */
  authenticate(params: MethodInput<'session.auth'>): Capability[] {
    if (!this.#tokenMatches(params.token)) {
      throw new BridgeError('UNAUTHORIZED', 'invalid token', {
        hint: 'Read the token from the handshake file of this app instance.',
      });
    }
    if (!isProtocolCompatible(params.protocolVersion, PROTOCOL_VERSION)) {
      throw new BridgeError(
        'VERSION_MISMATCH',
        `client protocol ${params.protocolVersion} is incompatible with runtime protocol ${PROTOCOL_VERSION}`,
        { hint: 'Install matching versions of the client and the in-app runtime.' },
      );
    }
    const requested = params.capabilities ?? this.#deps.capabilities;
    return this.#deps.capabilities.filter((capability) => requested.includes(capability));
  }

  #tokenMatches(token: string): boolean {
    const actual = Buffer.from(token, 'utf8');
    return actual.length === this.#expected.length && timingSafeEqual(actual, this.#expected);
  }
}
