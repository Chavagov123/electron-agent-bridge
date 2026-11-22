import {
  BridgeError,
  CAPS,
  ERROR_CODES,
  compactLimitations,
  ok,
  redact,
  redactedLimitation,
  type Envelope,
  type ErrorCode,
  type MethodData,
  type MethodInput,
} from '@eab/core';
import { COMPONENT_READER_FUNCTION } from '@eab/page-agent';
import { z } from 'zod';

import type { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';

type ComponentParams = Omit<MethodInput<'state.component'>, 'target'>;

const Described = z.object({ node: z.object({ backendNodeId: z.number() }) });
const Resolved = z.object({ object: z.object({ objectId: z.string() }) });
const Called = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.object({ text: z.string() }).optional(),
});
/** What the page may answer: checked and capped (page scripts run in the same world). */
const Answer = z.union([
  z.object({
    found: z.literal(true),
    framework: z.enum(['react', 'vue']),
    chain: z.array(z.string().max(200)).max(20),
    name: z.string().max(200),
    value: z.unknown(),
    truncated: z.boolean(),
  }),
  z.object({
    found: z.literal(false),
    error: z.object({ code: z.string(), message: z.string().max(500), hint: z.string().max(500).optional() }),
  }),
]);
const KNOWN_CODES = new Set<string>(ERROR_CODES);

/**
 * `state.component` (protocol 1.1): the React or Vue 3 component state behind an element. The element is
 * found by the page agent (isolated world), handed to the page's main world by its DOM node (only there
 * are the framework's handles visible), and read there by a small reader sent with the call. Values are
 * redacted and bounded like store state.
 */
export class ComponentReader {
  readonly #pool: AgentPool;

  constructor(pool: AgentPool) {
    this.#pool = pool;
  }

  async read(
    target: TargetDescriptor,
    params: ComponentParams,
  ): Promise<Envelope<MethodData<'state.component'>>> {
    const client = this.#pool.clientFor(target);
    const { matches, total } = await client.find(params.locator, 2);
    const ref = matches[0]?.ref;
    if (ref === undefined) throw new BridgeError('NOT_FOUND', 'no element matches the locator');
    if (total > 1 && params.locator.nth === undefined && params.locator.ref === undefined) {
      throw new BridgeError('AMBIGUOUS', `${total} elements match`, { hint: 'Use a ref, or add nth.' });
    }
    const request = {
      ...(params.path === undefined ? {} : { path: params.path }),
      ...(params.component === undefined ? {} : { component: params.component }),
      ...(params.maxDepth === undefined ? {} : { maxDepth: params.maxDepth }),
    };
    const raw = await client.withElements([ref], async ([objectId]) => {
      if (objectId === undefined) throw new BridgeError('STALE_REF', `${ref} is not in the page any more`);
      const { transport } = client;
      const described = Described.parse(await transport.send('DOM.describeNode', { objectId }));
      // Resolved in the page's main world (the default for a node), where the app's frameworks live.
      const resolved = Resolved.parse(
        await transport.send('DOM.resolveNode', { backendNodeId: described.node.backendNodeId }),
      );
      try {
        const called = Called.parse(
          await transport.send('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            functionDeclaration: COMPONENT_READER_FUNCTION,
            arguments: [{ value: request }],
            returnByValue: true,
            silent: true,
          }),
        );
        if (called.exceptionDetails) {
          throw new BridgeError('INTERNAL', `reading the component failed: ${called.exceptionDetails.text}`);
        }
        return called.result.value;
      } finally {
        transport.post('Runtime.releaseObject', { objectId: resolved.object.objectId });
      }
    });
    const answer = Answer.safeParse(raw);
    if (!answer.success)
      throw new BridgeError('INTERNAL', 'the page answered a component read with unexpected data');
    if (!answer.data.found) {
      const { code, message, hint } = answer.data.error;
      const known: ErrorCode = KNOWN_CODES.has(code) ? (code as ErrorCode) : 'INTERNAL';
      throw new BridgeError(known, message, hint === undefined ? {} : { hint });
    }
    const { framework, chain, name, value, truncated } = answer.data;
    const redacted = redact(value, CAPS.value);
    const data = {
      framework,
      chain,
      name,
      ...(params.path === undefined ? {} : { path: params.path }),
      value: redacted.value,
      truncated: truncated || redacted.truncated,
    };
    // Component state comes from the page: untrusted, like snapshot text.
    return { ...ok(data, compactLimitations([redactedLimitation(redacted.redactions)])), untrusted: true };
  }
}
