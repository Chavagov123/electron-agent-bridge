import {
  BridgeError,
  LIMITATION_CODES,
  type Envelope,
  type Limitation,
  type MethodData,
  type MethodInput,
  type ResolvedElement,
  type StepResult,
} from '@eab/core';
import type { Settled, SnapshotResponse } from '@eab/page-agent';

import { ActionObserver } from '../observe/action-observer.js';
import type { AgentPool } from '../page/agent-pool.js';
import type { PageAgentClient } from '../page/page-agent-client.js';
import type { Clock } from '../ports/clock.js';
import type { IpcFeed } from '../ports/ipc-feed.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import type { InputRecorder } from '../record/input-recorder.js';
import { InputDriver } from './input-driver.js';
import { performStep } from './steps.js';

/** Default wait for each step's element to become actionable. */
export const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
/** After each step: wait for 50 ms without DOM changes, at most 500 ms (not counted as action time). */
const SETTLE_IDLE_MS = 50;
const SETTLE_CAP_MS = 500;
/**
 * After typing into a field that shows suggestions: they come after a debounce (300–500 ms is common)
 * and a lookup, so wait for a longer quiet spell (the cap grows with it).
 */
const SUGGEST_IDLE_MS = 600;
const TYPING = new Set(['type', 'fill', 'press']);

export interface ActionEngineDeps {
  readonly pool: AgentPool;
  readonly clock: Clock;
  /** The app's IPC, for "what did this action cause" (absent: no IPC observations). */
  readonly ipc?: IpcFeed;
  /** While recording: page input during a run is the agent's (dropped); the run is noted instead. */
  readonly recorder?: InputRecorder;
}

type RunParams = Omit<MethodInput<'action.run'>, 'target'>;
type RunData = MethodData<'action.run'>;

/**
 * Runs `action.run`: each step waits for its element to be actionable, acts with trusted input, then
 * lets the page settle. The result is a cause→effect trace: per-step outcome and timings, what the
 * page did in response (observations), and what changed on screen (snapshot delta).
 */
export class ActionEngine {
  readonly #deps: ActionEngineDeps;

  constructor(deps: ActionEngineDeps) {
    this.#deps = deps;
  }

  async run(target: TargetDescriptor, params: RunParams): Promise<Envelope<RunData>> {
    const resume = this.#deps.recorder?.suspend();
    try {
      return await this.#run(target, params);
    } finally {
      resume?.();
    }
  }

  async #run(target: TargetDescriptor, params: RunParams): Promise<Envelope<RunData>> {
    const client = this.#deps.pool.clientFor(target);
    // Pages in background windows think they are unfocused: emulate focus while automating.
    this.#deps.pool.emulateFocus(client);
    const before = params.delta === false ? undefined : await client.snapshot({});
    const observer = new ActionObserver(client, this.#deps.ipc);
    await observer.start();
    const notes: Limitation[] = [];
    const steps = await this.#steps(client, observer, params, notes);
    await this.#deps.recorder?.noteAgentRun(target.id, client, params.actions, steps);
    // Every step sampled the page after settling: nothing new to read before reporting.
    const observations = await observer.finish({ sampled: steps.length > 0 });
    const after = before === undefined ? undefined : await finalDelta(client, before.cursor, notes);
    return {
      data: { steps, observations, ...deltaOf(after) },
      limitations: notes,
      untrusted: true,
    };
  }

  async #steps(
    client: PageAgentClient,
    observer: ActionObserver,
    params: RunParams,
    notes: Limitation[],
  ): Promise<StepResult[]> {
    const { clock } = this.#deps;
    const input = new InputDriver(client.transport);
    const results: StepResult[] = [];
    for (const action of params.actions) {
      const started = clock.now();
      const deadline = started + (params.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
      let error: BridgeError | undefined;
      const resolved: ResolvedElement[] = [];
      try {
        await performStep(action, { client, input, clock, deadline, notes, resolved });
      } catch (failure) {
        error = BridgeError.from(failure);
      }
      const actionMs = clock.now() - started;
      const settle = [SETTLE_IDLE_MS, SETTLE_CAP_MS, ...(TYPING.has(action.type) ? [SUGGEST_IDLE_MS] : [])];
      const settled = await client.invoke<Settled>('settle', settle).catch(() => undefined);
      const settleMs = settled?.ms ?? 0;
      if (settled === undefined) await observer.sample();
      else observer.record(settled.live);
      results.push(withResolved(stepResult(action.type, actionMs, settleMs, error), resolved));
      if (error && params.continueOnError !== true) break;
    }
    return results;
  }
}

/** Attach what the step acted on; the list is deduplicated (a check re-locates its element). */
function withResolved(result: StepResult, resolved: readonly ResolvedElement[]): StepResult {
  const unique = resolved.filter(
    (element, index) => resolved.findIndex((other) => other.ref === element.ref) === index,
  );
  return unique.length === 0 ? result : { ...result, resolved: unique.slice(0, 50) };
}

function stepResult(
  type: string,
  actionMs: number,
  settleMs: number,
  error: BridgeError | undefined,
): StepResult {
  const timings = { actionMs: Math.round(actionMs), settleMs: Math.round(settleMs) };
  if (!error) return { type, ok: true, timings };
  const detail = {
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
  return { type, ok: false, error: detail, timings };
}

/** What changed, or nothing with a note when the page is gone (a step closed or reloaded it). */
async function finalDelta(
  client: PageAgentClient,
  since: string,
  notes: Limitation[],
): Promise<SnapshotResponse | undefined> {
  try {
    return await client.snapshot({ mode: 'delta', since });
  } catch (error) {
    notes.push({
      code: LIMITATION_CODES.partial,
      message: `Page changes unavailable: ${BridgeError.from(error).message}. The steps above did run.`,
    });
    return undefined;
  }
}

function deltaOf(after: SnapshotResponse | undefined): { delta?: string; cursor?: string } {
  if (!after) return {};
  if (after.kind === 'unchanged') return { delta: '', cursor: after.cursor };
  const prefix = after.kind === 'full' ? '(page changed too much for a diff; full snapshot)\n' : '';
  return { delta: `${prefix}${after.text}`, cursor: after.cursor };
}
