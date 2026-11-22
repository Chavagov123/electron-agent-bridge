import {
  BridgeError,
  FEATURES,
  Methods,
  PROTOCOL_VERSION,
  RPC_ERROR,
  RpcRequestSchema,
  isMethodName,
  ok,
  rpcError,
  rpcResult,
  type Capability,
  type ConnectionMode,
  type Envelope,
  type MethodData,
  type MethodInput,
  type MethodName,
  type RpcRequest,
  type RpcResponse,
} from '@electron-agent-bridge/core';

import type { AuditSink } from '../audit/audit-log.js';
import type { Authenticator } from './authenticator.js';
import { forClient } from './compat.js';
import type { OpenSession, SessionRegistry } from './session-registry.js';

type HandledMethod = Exclude<MethodName, 'session.auth'>;

/**
 * Handlers for the protocol methods this runtime implements (auth is handled by the session itself).
 * Methods without a handler answer `UNSUPPORTED`, so the protocol table can run ahead of the runtime.
 */
export type MethodHandlers = {
  readonly [M in HandledMethod]?: (
    input: MethodInput<M>,
  ) => Envelope<MethodData<M>> | Promise<Envelope<MethodData<M>>>;
};

/** What to send back, and whether to hang up afterwards (failed auth, garbage before auth). */
export interface SessionReply {
  readonly response: RpcResponse;
  readonly close: boolean;
}

export interface RpcSessionDeps {
  readonly authenticator: Authenticator;
  readonly sessions: SessionRegistry;
  readonly audit: AuditSink;
  readonly handlers: MethodHandlers;
  readonly app: MethodData<'session.auth'>['app'];
  /** How the runtime got into the app; reported to clients at auth. */
  readonly mode?: ConnectionMode;
}

interface Granted extends OpenSession {
  readonly capabilities: readonly Capability[];
  readonly client: string;
  /** The protocol the client speaks: results are shaped for it. */
  readonly protocolVersion: string;
}

/**
 * Protocol state of one client connection. Transport-free: takes a line, returns a reply.
 * The first call must be `session.auth`; every later call is checked against the granted
 * capabilities, and every call is audited (metadata only).
 */
export class RpcSession {
  readonly #deps: RpcSessionDeps;
  #granted: Granted | undefined;

  constructor(deps: RpcSessionDeps) {
    this.#deps = deps;
  }

  get authenticated(): boolean {
    return this.#granted !== undefined;
  }

  async handleLine(line: string): Promise<SessionReply> {
    const request = parseRequest(line);
    if ('response' in request) return { response: request.response, close: !this.authenticated };
    const started = performance.now();
    try {
      const result = await this.#dispatch(request);
      this.#audit(request, started);
      return { response: rpcResult(request.id, result), close: false };
    } catch (error) {
      const bridgeError = BridgeError.from(error);
      this.#audit(request, started, bridgeError);
      const response = rpcError(request.id, {
        code: RPC_ERROR.bridge,
        message: bridgeError.message,
        data: bridgeError.toData(),
      });
      return { response, close: !this.authenticated };
    }
  }

  /** The connection closed: free the controller slot if this session held it. */
  dispose(): void {
    if (this.#granted) this.#deps.sessions.close(this.#granted.sessionId);
  }

  async #dispatch(request: RpcRequest): Promise<Envelope<unknown>> {
    const method = request.method;
    if (!isMethodName(method)) {
      // A newer client (same major) may know methods this runtime does not: unsupported, not missing.
      throw new BridgeError(
        'UNSUPPORTED',
        `method "${method}" is not known to this runtime (protocol ${PROTOCOL_VERSION})`,
        {
          hint: `The app runs an older bridge than the client. Known methods: ${Object.keys(Methods).join(', ')}.`,
        },
      );
    }
    if (method !== 'session.auth' && this.#granted === undefined) {
      throw new BridgeError('UNAUTHORIZED', 'call session.auth first');
    }
    const parsed = Methods[method].params.safeParse(request.params ?? {});
    if (!parsed.success) {
      throw new BridgeError('INVALID_PARAMS', `invalid params for ${method}: ${parsed.error.message}`);
    }
    if (method === 'session.auth') return this.#authenticate(parsed.data as MethodInput<'session.auth'>);
    this.#requireCapability(Methods[method].capability, method);
    // The params were validated against this method's own schema above, so the cast is sound.
    const handler = this.#deps.handlers[method] as
      ((input: unknown) => Envelope<unknown> | Promise<Envelope<unknown>>) | undefined;
    if (!handler) {
      throw new BridgeError('UNSUPPORTED', `${method} is not implemented by this runtime yet`, {
        hint: `Implemented: ${Object.keys(this.#deps.handlers).join(', ')}.`,
      });
    }
    const result = await handler(parsed.data);
    return this.#granted === undefined ? result : forClient(this.#granted.protocolVersion, method, result);
  }

  #authenticate(params: MethodInput<'session.auth'>): Envelope<MethodData<'session.auth'>> {
    if (this.#granted !== undefined) throw new BridgeError('INVALID_PARAMS', 'session already authenticated');
    const allowed = this.#deps.authenticator.authenticate(params);
    // Only a session that could act may take the single controller slot.
    const canAct = allowed.some((capability) => capability !== 'observe');
    const session = this.#deps.sessions.open(params.role !== 'observer' && canAct);
    // Observers watch; they never act on the app, whatever they asked for.
    const capabilities =
      session.role === 'observer' ? allowed.filter((capability) => capability === 'observe') : allowed;
    this.#granted = {
      ...session,
      capabilities,
      client: params.client.name,
      protocolVersion: params.protocolVersion,
    };
    return ok({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      role: session.role,
      capabilities,
      app: this.#deps.app,
      mode: this.#deps.mode ?? 'integrated',
      features: [...FEATURES],
    });
  }

  #requireCapability(needed: Capability, method: string): void {
    const granted = this.#granted;
    if (granted?.capabilities.includes(needed)) return;
    const hint =
      granted?.role === 'observer'
        ? 'This session is an observer because another client controls the app; reconnect once it disconnects.'
        : 'The app limits capabilities through enableAgentBridge({ capabilities }), or the client asked for fewer.';
    throw new BridgeError('CAPABILITY_DENIED', `${method} needs the "${needed}" capability`, { hint });
  }

  #audit(request: RpcRequest, started: number, error?: BridgeError): void {
    const granted = this.#granted;
    this.#deps.audit.record({
      ts: Date.now(),
      method: request.method.slice(0, 64),
      ok: error === undefined,
      ms: Math.round((performance.now() - started) * 10) / 10,
      ...(granted ? { session: granted.sessionId, client: granted.client } : {}),
      ...(error ? { code: error.code } : {}),
    });
  }
}

function parseRequest(line: string): RpcRequest | { response: RpcResponse } {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { response: rpcError(null, { code: RPC_ERROR.parse, message: 'invalid JSON' }) };
  }
  const parsed = RpcRequestSchema.safeParse(message);
  if (parsed.success) return parsed.data;
  return {
    response: rpcError(null, { code: RPC_ERROR.invalidRequest, message: 'not a JSON-RPC 2.0 request' }),
  };
}
