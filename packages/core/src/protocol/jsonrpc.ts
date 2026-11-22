import { z } from 'zod';

import type { BridgeErrorData } from '../errors/bridge-error.js';

/** JSON-RPC 2.0 error codes used by the bridge. Bridge failures always use `bridge` plus a typed `data.code`. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  bridge: -32000,
} as const;

const IdSchema = z.union([z.number().int(), z.string().max(64)]);

/** A JSON-RPC request. Notifications (no id) are not used by the bridge protocol. */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: IdSchema,
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

/** The error object of a failed response; `data` carries the typed bridge error. */
export interface RpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: BridgeErrorData;
}

/**
 * Error data as received. `code` is a plain string so that codes added by a newer peer still parse;
 * receivers map unknown codes themselves instead of dropping the response.
 */
const WireErrorDataSchema = z.object({ code: z.string().max(64), hint: z.string().optional() });

/** A JSON-RPC response (success or failure). */
export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: IdSchema, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: IdSchema.nullable(),
    error: z.object({ code: z.number().int(), message: z.string(), data: WireErrorDataSchema.optional() }),
  }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Build a success response. */
export function rpcResult(id: RpcRequest['id'], result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build a failure response. `id` is null when the request could not be parsed. */
export function rpcError(id: RpcRequest['id'] | null, error: RpcErrorObject): RpcResponse {
  return { jsonrpc: '2.0', id, error };
}
