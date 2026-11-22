import {
  BridgeError,
  CAPS,
  ERROR_CODES,
  LIMITATION_CODES,
  compactLimitations,
  ok,
  redact,
  redactedLimitation,
  type Envelope,
  type ErrorCode,
  type MethodData,
  type MethodInput,
} from '@electron-agent-bridge/core';
import { STATE_KEY } from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import { detachedError } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';

type ReadParams = Omit<MethodInput<'state.read'>, 'target'>;
type DispatchParams = Omit<MethodInput<'state.dispatch'>, 'target'>;

const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.object({ text: z.string() }).optional(),
});
/** What a page registry may answer: checked and capped, since page scripts could replace the registry. */
const ReadAnswer = z.object({
  stores: z
    .array(
      z.object({
        name: z.string().max(128),
        kind: z.enum(['redux', 'zustand', 'mobx', 'generic']),
        actions: z.number().int().min(0).optional(),
      }),
    )
    .max(50),
  store: z.string().max(128).optional(),
  path: z.string().max(500).optional(),
  value: z.unknown(),
  truncated: z.boolean(),
});
const Failure = z.object({
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
});

const NO_HOOK = {
  code: LIMITATION_CODES.partial,
  message:
    'This page has no state hook: it is a <webview>, or it loaded before the bridge started (reload it). ' +
    'Stores appear once the app registers them (registerState) or builds them with devtools support.',
};

/**
 * `state.read` / `state.dispatch` (FR6): calls the page's main-world registry (the state hook) with
 * `Runtime.evaluate`. The page bounds what it returns; values are redacted here, like IPC values.
 */
export class StateReader {
  async read(target: TargetDescriptor, params: ReadParams): Promise<Envelope<MethodData<'state.read'>>> {
    const answer = await this.#call(target, 'read', params);
    if (answer === null) return ok({ stores: [], value: null, truncated: false }, [NO_HOOK]);
    const parsed = ReadAnswer.safeParse(answer);
    if (!parsed.success)
      throw new BridgeError('INTERNAL', 'the page answered a state read with unexpected data');
    const result = parsed.data;
    const redacted = redact(result.value, CAPS.value);
    return ok(
      {
        stores: result.stores.map(({ name, kind, actions }) =>
          actions === undefined ? { name, kind } : { name, kind, actions },
        ),
        ...(result.store === undefined ? {} : { store: result.store }),
        ...(result.path === undefined ? {} : { path: result.path }),
        value: redacted.value,
        truncated: result.truncated || redacted.truncated,
      },
      compactLimitations([redactedLimitation(redacted.redactions)]),
    );
  }

  async dispatch(
    target: TargetDescriptor,
    params: DispatchParams,
  ): Promise<Envelope<MethodData<'state.dispatch'>>> {
    const answer = await this.#call(target, 'dispatch', params);
    if (answer === null)
      throw new BridgeError('NOT_FOUND', 'this page has no state hook', { hint: NO_HOOK.message });
    return ok({ dispatched: true });
  }

  /** The registry's answer, `null` without a hook; a failure it reports becomes a BridgeError. */
  async #call(target: TargetDescriptor, method: 'read' | 'dispatch', params: object): Promise<unknown> {
    const { transport } = target;
    if (!transport.attached) throw detachedError(`state of ${target.id}`, transport);
    const expression =
      `(() => { const registry = globalThis[Symbol.for(${JSON.stringify(STATE_KEY)})];` +
      ` return registry === undefined ? null : registry.${method}(${JSON.stringify(params)}); })()`;
    const evaluated = Evaluated.parse(
      await transport.send('Runtime.evaluate', { expression, returnByValue: true, silent: true }),
    );
    if (evaluated.exceptionDetails) {
      throw new BridgeError(
        'INTERNAL',
        `state ${method} failed in the page: ${evaluated.exceptionDetails.text}`,
      );
    }
    const value = evaluated.result.value ?? null;
    const failure = Failure.safeParse(value);
    if (failure.success) {
      const { code, message, hint } = failure.data.error;
      const known = (ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'INTERNAL';
      throw new BridgeError(known, message, hint === undefined ? {} : { hint });
    }
    return value;
  }
}
