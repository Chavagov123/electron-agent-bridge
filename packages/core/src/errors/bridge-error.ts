import { z } from 'zod';

import { ErrorCodeSchema, type ErrorCode } from './error-code.js';

/** Serializable form of a {@link BridgeError}; travels in JSON-RPC `error.data`. */
export interface BridgeErrorData {
  readonly code: ErrorCode;
  readonly hint?: string;
}

/** Validator for {@link BridgeErrorData} received from the wire. */
export const BridgeErrorDataSchema = z.object({ code: ErrorCodeSchema, hint: z.string().optional() });

export interface BridgeErrorOptions {
  /** What the caller can do about it. Shown to agents verbatim. */
  readonly hint?: string;
  readonly cause?: unknown;
}

/** The only error type the bridge throws on purpose. */
export class BridgeError extends Error {
  override readonly name = 'BridgeError';
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: BridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.hint = options.hint;
  }

  /** Wire form; never includes the stack or the cause. */
  toData(): BridgeErrorData {
    return this.hint === undefined ? { code: this.code } : { code: this.code, hint: this.hint };
  }

  /** Keep a BridgeError as-is; wrap anything else as `INTERNAL`. */
  static from(error: unknown): BridgeError {
    if (error instanceof BridgeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new BridgeError('INTERNAL', message, { cause: error });
  }
}
