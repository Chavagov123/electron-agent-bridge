import { runInThisContext } from 'node:vm';

import {
  BridgeError,
  CAPS,
  ok,
  redact,
  type Envelope,
  type MethodData,
  type MethodInput,
} from '@electron-agent-bridge/core';

/** Default limit for one evaluation, synchronous part and awaited result together. */
export const DEFAULT_EVAL_TIMEOUT_MS = 5_000;

const CALL_KEY = Symbol.for('electron-agent-bridge.v1.eval-call');
type Compiled = (...values: unknown[]) => unknown;

/** What an expression can use besides the main process's globals. */
export interface EvalScope {
  /** `require` resolving from the app (its own dependencies and `electron`). */
  readonly require: (id: string) => unknown;
  readonly electron: unknown;
}

/**
 * `main.eval` (capability `eval`): run JavaScript in the main process. An expression (`app.getName()`)
 * or a function body (`const w = …; return w.id`); `require`, `electron` and `app` are in scope.
 * Synchronous code runs under a `vm` timeout (an endless loop is interrupted); a returned promise is
 * awaited within the same limit. Code after an `await` cannot be interrupted (it runs on the main
 * event loop); the limit then only stops waiting for it. The result is JSON-safe, bounded and redacted; a throw is reported
 * as `type: "error"`.
 */
export async function evaluateInMain(
  scope: EvalScope,
  input: MethodInput<'main.eval'>,
): Promise<Envelope<MethodData<'main.eval'>>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
  const compiled = compile(input.expression);
  const app = (scope.electron as { app?: unknown }).app;
  let outcome: { value: unknown } | { error: unknown };
  try {
    outcome = {
      value: await settle(runBounded(compiled, [scope.require, scope.electron, app], timeoutMs), timeoutMs),
    };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    outcome = { error };
  }
  if ('error' in outcome) return ok(describeError(outcome.error));
  const { value, truncated } = redact(outcome.value, CAPS.value);
  return ok({ type: typeOf(outcome.value), value, truncated });
}

function compile(expression: string): Compiled {
  const params = ['require', 'electron', 'app'];
  const expressionBody = `return (${expression}\n);`;
  // Synchronous forms first: the whole run is then under the vm timeout. Only code using `await`
  // gets an async wrapper, whose part after the first `await` the timeout cannot interrupt.
  const forms = [expressionBody, expression].flatMap((body) => [
    body,
    `return (async () => {\n${body}\n})();`,
  ]);
  let last: SyntaxError | undefined;
  for (const body of forms) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- main.eval exists to run caller code (eval tier)
      return new Function(...params, body) as Compiled;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      last = error;
    }
  }
  throw new BridgeError('INVALID_PARAMS', `syntax error: ${last?.message ?? 'could not compile'}`);
}

/** Call under a `vm` timeout: synchronous code running too long is interrupted. */
function runBounded(compiled: Compiled, values: unknown[], timeoutMs: number): unknown {
  const slot = globalThis as unknown as Record<symbol, (() => unknown) | undefined>;
  slot[CALL_KEY] = () => compiled(...values);
  try {
    return runInThisContext(`globalThis[Symbol.for(${JSON.stringify(CALL_KEY.description)})]()`, {
      timeout: Math.max(1, timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Script execution timed out')) {
      throw new BridgeError('TIMEOUT', `evaluation did not finish within ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    Reflect.deleteProperty(slot, CALL_KEY);
  }
}

async function settle(result: unknown, timeoutMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BridgeError('TIMEOUT', `the returned promise did not settle within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([result, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeError(error: unknown): MethodData<'main.eval'> {
  const value =
    error instanceof Error
      ? { name: error.name, message: error.message, ...stackOf(error) }
      : { message: String(error) };
  return { type: 'error', value: redact(value).value, truncated: false };
}

/** A frame in the compiled expression: `eval (eval at compile (…/inject.cjs:1:2), <anonymous>:3:24)`. */
const EXPRESSION_FRAME = /\(eval at [^()]*(?:\([^()]*\))?, <anonymous>:\d+:\d+\)/;

/**
 * The stack as the caller wrote it: from the `Name: message` line (Node may put the failing source
 * line above it), through the last frame in the expression, shown as `(main.eval)`; the bridge's own
 * frames after it are left out.
 */
function stackOf(error: Error): { stack?: string } {
  const lines = (error.stack ?? '').split('\n');
  const head = lines.findIndex((line) => line.startsWith(`${error.name}:`) || line === error.name);
  const frames = lines.slice(Math.max(0, head));
  let last = -1;
  frames.forEach((line, index) => {
    if (EXPRESSION_FRAME.test(line)) last = index;
  });
  const kept = (last === -1 ? frames : frames.slice(0, last + 1)).slice(0, 6);
  const stack = kept.map((line) => line.replace(EXPRESSION_FRAME, '(main.eval)')).join('\n');
  return stack === '' ? {} : { stack };
}
