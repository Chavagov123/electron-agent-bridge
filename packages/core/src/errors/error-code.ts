import { z } from 'zod';

/** Stable error codes. Callers branch on these, never on messages. */
export const ERROR_CODES = [
  'NOT_FOUND',
  'AMBIGUOUS',
  'HIDDEN',
  'DISABLED',
  'OCCLUDED',
  'OFF_SCREEN',
  'DETACHED',
  'TIMEOUT',
  'STALE_REF',
  'TARGET_GONE',
  'TRANSPORT_CLOSED',
  'UNAUTHORIZED',
  'CAPABILITY_DENIED',
  'NOT_ENABLED',
  'LAUNCH_BLOCKED',
  'UNSUPPORTED',
  'VERSION_MISMATCH',
  'HOST_DEBUGGER',
  'BUDGET_EXCEEDED',
  'INVALID_PARAMS',
  'INTERNAL',
] as const;

/** One of {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Runtime validator for {@link ErrorCode}. */
export const ErrorCodeSchema = z.enum(ERROR_CODES);
