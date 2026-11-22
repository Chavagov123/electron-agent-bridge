import {
  ActionSchema,
  ByteRing,
  CAPS,
  LIMITATION_CODES,
  LocatorSchema,
  compactLimitations,
  droppedLimitation,
  ok,
  type Envelope,
  type MethodData,
  type Action,
  type Locator,
  type RecordedEvent,
  type ResolvedElement,
  type StepResult,
} from '@electron-agent-bridge/core';
import { RECORD_BINDING } from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import type { AgentPool } from '../page/agent-pool.js';
import { AGENT_WORLD, type PageAgentClient } from '../page/page-agent-client.js';
import type { CdpTransport, Disposable } from '../ports/cdp-transport.js';
import type { Clock } from '../ports/clock.js';
import { Gaps, type PageRange } from '../observe/gaps.js';

const BindingCalled = z.object({ name: z.string(), payload: z.string().max(16_384) });
const Reported = z.object({
  action: ActionSchema,
  url: z.string().max(2_000),
  secret: z.boolean().optional(),
});

/** Bytes of recorded events kept (oldest evicted, and counted). */
export const RECORDING_BYTES = 512 * 1024;

type Stored = Omit<RecordedEvent, 'seq'>;

interface Watched {
  readonly transport: CdpTransport;
  readonly dispose: () => void;
}

export interface InputRecorderDeps {
  readonly pool: AgentPool;
  readonly clock: Clock;
  readonly capacityBytes?: number;
}

export interface RecordPage {
  readonly items: RecordedEvent[];
  readonly nextSeq: number;
  readonly dropped: number;
  readonly more: boolean;
  readonly recording: boolean;
}

/**
 * Records what users do in the app's pages (protocol 1.1, `record.*`): while on, a CDP binding in the
 * agent's world receives each click, field change and command key, with a locator that outlives refs;
 * it exists from every new document's start, so navigations lose nothing. Actions an agent runs are
 * added from their results instead (`noteAgentRun`), and whatever the page reports while an action
 * runs is dropped: that input was the agent's, not a user's.
 */
export class InputRecorder {
  readonly #deps: InputRecorderDeps;
  readonly #ring: ByteRing<Stored>;
  readonly #pages = new Map<string, Watched>();
  #active = false;
  #suspended = 0;
  /** Reports from pages that did not validate (too large, malformed): counted, not recorded. */
  readonly #refused = new Gaps();

  constructor(deps: InputRecorderDeps) {
    this.#deps = deps;
    this.#ring = new ByteRing({ capacityBytes: deps.capacityBytes ?? RECORDING_BYTES });
  }

  get recording(): boolean {
    return this.#active;
  }

  /** Actions pages reported within `range` that could not be recorded (over the size limits, malformed). */
  refusedIn(range: PageRange): number {
    // A cursor past the end (from an earlier recorder) was read from the start.
    const since = range.since > this.#ring.stats.lastSeq ? 0 : range.since;
    return this.#refused.within({ ...range, since });
  }

  /** Follow a page from its creation (like the log collectors): bindings are armed while recording. */
  watch(targetId: string, transport: CdpTransport): Disposable {
    const events = transport.onEvent((event) => {
      if (event.method !== 'Runtime.bindingCalled' || event.sessionId !== undefined) return;
      this.#onBinding(targetId, event.params);
    });
    // A fresh CDP session has no binding: arm it again (whichever listener the session reset runs first).
    const attached = transport.onAttach(() => {
      if (!this.#active) return;
      this.#client(targetId, transport).forget('Runtime.addBinding', bindingParams());
      this.#arm(targetId, transport);
    });
    const watched: Watched = {
      transport,
      dispose: () => {
        events.dispose();
        attached.dispose();
      },
    };
    this.#pages.set(targetId, watched);
    if (this.#active) this.#arm(targetId, transport);
    return {
      dispose: () => {
        watched.dispose();
        this.#pages.delete(targetId);
      },
    };
  }

  /** Start recording in every page; pages already loaded start capturing right away. */
  async start(): Promise<number> {
    this.#active = true;
    await Promise.all([...this.#pages].map(([id, page]) => this.#startIn(id, page.transport)));
    return this.#ring.stats.lastSeq + 1;
  }

  async stop(): Promise<void> {
    this.#active = false;
    await Promise.all(
      [...this.#pages].map(async ([id, { transport }]) => {
        if (!transport.attached) return;
        const client = this.#client(id, transport);
        client.forget('Runtime.addBinding', bindingParams());
        transport.post('Runtime.removeBinding', { name: RECORD_BINDING });
        await client.invoke('recordStop', []).catch(() => undefined);
      }),
    );
  }

  /** Drop what pages report until the returned function is called (an agent's action is running). */
  suspend(): () => void {
    this.#suspended++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.#suspended--;
    };
  }

  /**
   * Add the actions an agent ran, with each element's ref replaced by its most stable locator (asked
   * of the page, which still knows the element). Steps that failed are left out.
   */
  async noteAgentRun(
    targetId: string,
    client: PageAgentClient,
    actions: readonly Action[],
    results: readonly StepResult[],
  ): Promise<void> {
    if (!this.#active) return;
    for (const [index, action] of actions.entries()) {
      const result = results[index];
      if (result?.ok !== true) continue;
      const locators = await Promise.all(
        (result.resolved ?? []).map((element) => stableLocator(client, element)),
      );
      this.#push({
        ts: this.#deps.clock.now(),
        target: targetId,
        source: 'agent',
        action: withLocators(action, locators),
      });
    }
  }

  query(query: { readonly since?: number; readonly limit?: number } = {}): RecordPage {
    const page = this.#ring.read(query.since ?? 0, query.limit ?? CAPS.pageItems);
    return {
      items: page.entries.map(({ seq, item }) => ({ seq, ...item })),
      nextSeq: page.nextSeq,
      dropped: page.dropped,
      more: page.more,
      recording: this.#active,
    };
  }

  async #startIn(targetId: string, transport: CdpTransport): Promise<void> {
    if (!transport.attached) return;
    this.#arm(targetId, transport);
    await this.#client(targetId, transport)
      .invoke('recordStart', [])
      .catch(() => undefined);
  }

  /** The binding for this and every later document; the agent installs itself in each (fire-and-forget). */
  #arm(targetId: string, transport: CdpTransport): void {
    if (!transport.attached) return;
    const client = this.#client(targetId, transport);
    client.ensure('Runtime.addBinding', bindingParams());
    client.install();
  }

  #client(targetId: string, transport: CdpTransport): PageAgentClient {
    return this.#deps.pool.clientFor({
      id: targetId,
      kind: 'other',
      title: '',
      url: '',
      focused: false,
      transport,
    });
  }

  #onBinding(targetId: string, params: unknown): void {
    if (!this.#active || this.#suspended > 0) return;
    const call = BindingCalled.safeParse(params);
    if (!call.success || call.data.name !== RECORD_BINDING) return;
    let json: unknown;
    try {
      json = JSON.parse(call.data.payload);
    } catch {
      this.#refused.note(this.#ring.stats.lastSeq);
      return;
    }
    const reported = Reported.safeParse(json);
    if (!reported.success) {
      this.#refused.note(this.#ring.stats.lastSeq);
      return;
    }
    const { action, url, secret } = reported.data;
    this.#push({
      ts: this.#deps.clock.now(),
      target: targetId,
      source: 'user',
      action,
      url,
      ...(secret === true ? { secret } : {}),
    });
  }

  #push(event: Stored): void {
    this.#ring.push(event);
  }
}

function bindingParams(): { name: string; executionContextName: string } {
  return { name: RECORD_BINDING, executionContextName: AGENT_WORLD };
}

/** The page's stable locator for an element an action resolved; role and exact name when it cannot say. */
async function stableLocator(client: PageAgentClient, element: ResolvedElement): Promise<Locator> {
  try {
    return LocatorSchema.parse(await client.invoke<unknown>('locatorFor', [element.ref]));
  } catch {
    if (element.name === '') return { role: element.role };
    // A `generic` element (a div with a click listener) is found by its text, not by a role.
    return element.role === 'generic'
      ? { text: element.name, exact: true }
      : { role: element.role, name: element.name, exact: true };
  }
}

/** The action with its element locators (in `resolved` order) swapped for stable ones. */
function withLocators(action: Action, locators: readonly Locator[]): Action {
  const [first, second] = locators;
  if (first === undefined) return action;
  if (action.type === 'drag') return { ...action, from: first, to: second ?? action.to };
  if (action.type === 'fillForm') {
    const fields = action.fields.map((field, index) => ({
      ...field,
      locator: locators[index] ?? field.locator,
    }));
    return { ...action, fields };
  }
  // Every other action has at most one locator; a key press or scroll without one stays without.
  return 'locator' in action && action.locator !== undefined ? { ...action, locator: first } : action;
}

/** `record.events`: one page of recorded actions, with page names and what was evicted unread. */
export function queryRecorded(
  recorder: InputRecorder,
  targets: { list(): readonly { readonly id: string; readonly name: string }[] },
  input: { readonly since?: number | undefined; readonly limit?: number | undefined },
): Envelope<MethodData<'record.events'>> {
  const page = recorder.query({
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const names = new Map(targets.list().map((target) => [target.id, target.name]));
  const items = page.items.map((event) => ({ ...event, target: names.get(event.target) ?? event.target }));
  const count = recorder.refusedIn({ since: input.since ?? 0, nextSeq: page.nextSeq });
  const refused =
    count > 0
      ? {
          code: LIMITATION_CODES.dropped,
          message: `${count} recorded action(s) were left out: too large or malformed.`,
        }
      : undefined;
  return ok(
    { ...page, items },
    compactLimitations([droppedLimitation('recorded actions', page.dropped), refused]),
  );
}
