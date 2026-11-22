import {
  BridgeError,
  LIMITATION_CODES,
  globMatcher,
  ok,
  type Envelope,
  type MethodData,
  type MethodInput,
  type WaitCondition,
} from '@electron-agent-bridge/core';
import type { ConditionCheck } from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import type { AgentPool } from '../page/agent-pool.js';
import type { PageAgentClient } from '../page/page-agent-client.js';
import type { CdpEvent } from '../ports/cdp-transport.js';
import type { Clock } from '../ports/clock.js';
import type { IpcFeed } from '../ports/ipc-feed.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import type { StateReader } from '../state/state-reader.js';

/** Default for `wait.for` when no timeout is given. */
export const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 100;
const DEFAULT_IDLE_MS = 500;

export interface WaiterDeps {
  readonly pool: AgentPool;
  readonly clock: Clock;
  /** Needed for `ipc` conditions. */
  readonly ipc?: IpcFeed;
  /** Needed for `state` conditions. */
  readonly state?: StateReader;
}

type WaitParams = Omit<MethodInput<'wait.for'>, 'target'>;

const RequestId = z.object({ requestId: z.string() });

/**
 * `wait.for`: polls a condition until it holds or the timeout expires. A timeout says what was last
 * observed ("2 matches, 0 visible"), so the agent can tell a slow page from a wrong expectation.
 */
export class Waiter {
  readonly #deps: WaiterDeps;

  constructor(deps: WaiterDeps) {
    this.#deps = deps;
  }

  async waitFor(target: TargetDescriptor, params: WaitParams): Promise<Envelope<MethodData<'wait.for'>>> {
    const { condition } = params;
    const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
    if (condition.kind === 'ipc') return this.#poll(this.#ipcCheck(condition.channel), condition, timeoutMs);
    if (condition.kind === 'state')
      return this.#poll(this.#stateCheck(target, condition), condition, timeoutMs);
    const client = this.#deps.pool.clientFor(target);
    if (condition.kind !== 'networkIdle') {
      return this.#poll(() => client.invoke<ConditionCheck>('check', [condition]), condition, timeoutMs);
    }
    const network = this.#networkIdle(client, condition.idleMs ?? DEFAULT_IDLE_MS);
    try {
      const result = await this.#poll(network.check, condition, timeoutMs);
      if (!network.monitoringStartedNow) return result;
      return {
        ...result,
        limitations: [
          ...result.limitations,
          {
            code: LIMITATION_CODES.partial,
            message:
              'Network monitoring started with this wait: requests already running before it were not seen. ' +
              'Waits after an act see everything the act started.',
          },
        ],
      };
    } finally {
      network.dispose();
    }
  }

  async #poll(
    check: () => Promise<ConditionCheck>,
    condition: WaitCondition,
    timeoutMs: number,
  ): Promise<Envelope<MethodData<'wait.for'>>> {
    const { clock } = this.#deps;
    const started = clock.now();
    let last: string;
    for (;;) {
      try {
        const result = await check();
        last = result.observed;
        if (result.met) return ok({ elapsedMs: clock.now() - started, observed: result.observed });
      } catch (error) {
        // The page may be navigating; keep trying until the deadline.
        last = BridgeError.from(error).message;
      }
      if (clock.now() - started >= timeoutMs) {
        throw new BridgeError(
          'TIMEOUT',
          `${describe(condition)} not met within ${timeoutMs} ms (last: ${last})`,
          {
            hint: 'Check the condition against a fresh snapshot, or raise timeoutMs if the page is just slow.',
          },
        );
      }
      await clock.sleep(POLL_MS);
    }
  }

  /** A store value at a path equals the expected one (compared as JSON, key order ignored). */
  #stateCheck(
    target: TargetDescriptor,
    condition: Extract<WaitCondition, { kind: 'state' }>,
  ): () => Promise<ConditionCheck> {
    const reader = this.#deps.state;
    if (!reader) throw new BridgeError('UNSUPPORTED', 'this runtime does not read state');
    const expected = stableJson(condition.equals);
    return async () => {
      const { data } = await reader.read(target, {
        path: condition.path,
        ...(condition.store === undefined ? {} : { store: condition.store }),
      });
      // No store yet (page still starting, or no hook): never met, whatever was expected.
      if (data.store === undefined) return { met: false, observed: 'no stores registered yet' };
      const actual = stableJson(data.value);
      return { met: actual === expected, observed: `${condition.path} = ${actual.slice(0, 120)}` };
    };
  }

  /** A message on a channel (glob) after the wait started; the page does not matter. */
  #ipcCheck(channel: string): () => Promise<ConditionCheck> {
    const feed = this.#deps.ipc;
    if (!feed) throw new BridgeError('UNSUPPORTED', 'this runtime does not record IPC');
    const matches = globMatcher(channel);
    let cursor = feed.lastSeq();
    let seen = 0;
    return () => {
      const { items, nextSeq } = feed.since(cursor, 500);
      cursor = nextSeq;
      seen += items.length;
      const hit = items.find((item) => matches(item.channel));
      if (hit)
        return Promise.resolve({
          met: true,
          observed: `${hit.kind} on ${JSON.stringify(hit.channel)} (#${hit.seq})`,
        });
      return Promise.resolve({
        met: false,
        observed: `${seen} other message(s), none on ${JSON.stringify(channel)}`,
      });
    };
  }

  /** No request started or finished for `idleMs` and none in flight (counted from the start of the wait). */
  #networkIdle(
    client: PageAgentClient,
    idleMs: number,
  ): { check: () => Promise<ConditionCheck>; dispose: () => void; monitoringStartedNow: boolean } {
    const monitoringStartedNow = client.ensure('Network.enable');
    const inflight = new Set<string>();
    let lastActivity = this.#deps.clock.now();
    const subscription = client.transport.onEvent((event: CdpEvent) => {
      const parsed = RequestId.safeParse(event.params);
      if (!parsed.success || event.sessionId !== undefined) return;
      if (event.method === 'Network.requestWillBeSent') inflight.add(parsed.data.requestId);
      else if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
        inflight.delete(parsed.data.requestId);
      } else return;
      lastActivity = this.#deps.clock.now();
    });
    const check = (): Promise<ConditionCheck> => {
      const quietFor = this.#deps.clock.now() - lastActivity;
      const met = inflight.size === 0 && quietFor >= idleMs;
      return Promise.resolve({
        met,
        observed: `${inflight.size} request(s) in flight, quiet for ${quietFor} ms`,
      });
    };
    return {
      check,
      monitoringStartedNow,
      dispose: () => {
        subscription.dispose();
      },
    };
  }
}

function describe(condition: WaitCondition): string {
  switch (condition.kind) {
    case 'element':
      return `element ${JSON.stringify(condition.locator)} ${condition.state ?? 'visible'}`;
    case 'text':
      return `text ${JSON.stringify(condition.text)} ${condition.present === false ? 'absent' : 'present'}`;
    case 'url':
      return `url containing ${JSON.stringify(condition.contains)}`;
    case 'networkIdle':
      return `network idle for ${condition.idleMs ?? DEFAULT_IDLE_MS} ms`;
    case 'ipc':
      return `an IPC message on ${JSON.stringify(condition.channel)}`;
    case 'state':
      return condition.kind;
  }
}

/** JSON with object keys sorted, so `{a, b}` equals `{b, a}`. */
function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}
