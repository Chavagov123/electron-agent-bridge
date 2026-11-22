import type { Locator, WaitCondition } from '@electron-agent-bridge/core';

import {
  actionTarget,
  type ActionTarget,
  type ActionabilityContext,
  type Requirements,
} from './actionability.js';
import {
  dragAndDrop,
  focusForInput,
  readState,
  selectOptions,
  setValueDirectly,
  type ControlState,
} from './editing.js';
import { elementBox, type ElementBox } from './box.js';
import { AgentFailure, guard, guardAsync, type AgentResult } from './failure.js';
import {
  checkCondition,
  liveState,
  quiet,
  showsSuggestions,
  type ConditionCheck,
  type LiveState,
} from './observe.js';
import { parseRef } from './refs.js';

/** The agent operations behind actions and waits. All results are plain JSON. */
export interface ActionApi {
  /** Resolve and check one element for an action; the point is in top-level viewport CSS px. */
  actionTarget(locator: Locator, requirements: Requirements): Promise<AgentResult<ActionTarget>>;
  focus(ref: string, selectAll: boolean): AgentResult<true>;
  state(ref: string): AgentResult<ControlState>;
  setValue(ref: string, value: string): AgentResult<ControlState>;
  selectOptions(ref: string, values: readonly string[]): AgentResult<string[]>;
  drag(from: string, to: string): AgentResult<true>;
  live(): AgentResult<LiveState>;
  /** `suggestIdleMs`: the idle time to wait instead while focus is in a field that shows suggestions. */
  quiet(idleMs: number, capMs: number, suggestIdleMs?: number): Promise<AgentResult<number>>;
  /** `quiet`, then `live`: what a step needs after it acted, in one call (protocol 1.1 engines). */
  settle(idleMs: number, capMs: number, suggestIdleMs?: number): Promise<AgentResult<Settled>>;
  check(condition: WaitCondition): AgentResult<ConditionCheck>;
  box(locator: Locator): AgentResult<ElementBox>;
}

/** How long the page took to settle after a step, and its live regions and dialogs then. */
export interface Settled {
  readonly ms: number;
  readonly live: LiveState;
}

export type { ActionTarget, ControlState, ConditionCheck, ElementBox, LiveState, Requirements };

export function createActionApi(win: Window, context: ActionabilityContext): ActionApi {
  const byRef = (ref: string): Element => {
    const id = parseRef(ref);
    const el = id === undefined ? undefined : context.refs.element(id);
    if (!el) throw new AgentFailure('STALE_REF', `${ref} no longer exists; take a new snapshot`);
    return el;
  };
  const settleFor = (idleMs: number, capMs: number, suggestIdleMs: number | undefined): Promise<number> => {
    if (suggestIdleMs === undefined || !showsSuggestions(win.document)) return quiet(win, idleMs, capMs);
    const idle = Math.max(idleMs, suggestIdleMs);
    return quiet(win, idle, Math.max(capMs, 2 * idle));
  };
  return {
    actionTarget: (locator, requirements) => guardAsync(() => actionTarget(locator, requirements, context)),
    focus: (ref, selectAll) =>
      guard(() => {
        focusForInput(byRef(ref), selectAll);
        return true as const;
      }),
    state: (ref) => guard(() => readState(byRef(ref))),
    setValue: (ref, value) =>
      guard(() => {
        const el = byRef(ref);
        setValueDirectly(el, value);
        return readState(el);
      }),
    selectOptions: (ref, values) => guard(() => selectOptions(byRef(ref), values)),
    drag: (from, to) =>
      guard(() => {
        dragAndDrop(byRef(from), byRef(to));
        return true as const;
      }),
    live: () => guard(() => liveState(win.document, context.refs)),
    quiet: (idleMs, capMs, suggestIdleMs) => guardAsync(() => settleFor(idleMs, capMs, suggestIdleMs)),
    settle: (idleMs, capMs, suggestIdleMs) =>
      guardAsync(async () => {
        const ms = await settleFor(idleMs, capMs, suggestIdleMs);
        return { ms, live: liveState(win.document, context.refs) };
      }),
    check: (condition) => guard(() => checkCondition(condition, win.document, context)),
    box: (locator) => guard(() => elementBox(locator, context)),
  };
}
