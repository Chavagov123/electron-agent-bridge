import { z } from 'zod';

import { CapabilitySchema, ConnectionModeSchema, type MethodDef } from '../method-def.js';

/**
 * One client at a time controls the app; others observe. An observer never gets more than
 * `observe`, so two agents cannot fight over the same window.
 */
export const SessionRoleSchema = z.enum(['controller', 'observer']);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

/** Handshake and per-session housekeeping. */
export const sessionMethods = {
  /** Must be the first call on a connection. */
  'session.auth': {
    params: z.object({
      token: z.string().min(1).max(256),
      protocolVersion: z.string().max(32),
      client: z.object({ name: z.string().max(64), version: z.string().max(32) }),
      /** Ask for less than the app allows (least privilege). Default: everything allowed. */
      capabilities: z.array(CapabilitySchema).max(3).optional(),
      /** Default `controller`; downgraded to `observer` while another controller is connected. */
      role: SessionRoleSchema.optional(),
    }),
    data: z.object({
      protocolVersion: z.string(),
      sessionId: z.string(),
      role: SessionRoleSchema,
      capabilities: z.array(CapabilitySchema),
      app: z.object({ name: z.string(), version: z.string(), electron: z.string(), pid: z.number().int() }),
      /** Since protocol 1.1. Absent from older runtimes, which are always `integrated` or `launch`. */
      mode: ConnectionModeSchema.optional(),
      /** Since protocol 1.1: feature groups this connection serves (see `FEATURES`); absent means all. */
      features: z.array(z.string().max(32)).max(32).optional(),
    }),
    capability: 'observe',
  },
  /** Undo automation side effects: dialog stubs, focus emulation, snapshot cursors. */
  'session.reset': {
    params: z.object({}),
    data: z.object({ reset: z.literal(true) }),
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
