import { LocatorError } from './find.js';

/** Result of an agent call: plain JSON, never an exception across the world boundary. */
export type AgentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly code: string };

/** A failure with a bridge error code (`NOT_FOUND`, `HIDDEN`…), reported to the engine as data. */
export class AgentFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function toResult(error: unknown): AgentResult<never> {
  if (error instanceof AgentFailure) return { ok: false, code: error.code, error: error.message };
  if (error instanceof LocatorError) return { ok: false, code: 'INVALID_PARAMS', error: error.message };
  return { ok: false, code: 'INTERNAL', error: error instanceof Error ? error.message : String(error) };
}

/** Run a synchronous agent operation, turning failures into data. */
export function guard<T>(run: () => T): AgentResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return toResult(error);
  }
}

/** Run an asynchronous agent operation, turning failures into data. */
export async function guardAsync<T>(run: () => Promise<T>): Promise<AgentResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return toResult(error);
  }
}
