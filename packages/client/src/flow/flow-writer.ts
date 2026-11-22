import type { Action, Locator, RecordedEvent } from '@electron-agent-bridge/core';
import { stringify } from 'yaml';

import type { Flow, FlowApp, FlowStep } from './flow-schema.js';

/** Steps a flow may hold (the schema's limit). */
const MAX_STEPS = 500;

/** A flow as YAML that {@link parseFlow} reads back to the same flow. */
export function stringifyFlow(flow: Flow): string {
  // Fixed key order: what a reader looks for first comes first.
  const ordered = {
    name: flow.name,
    ...(flow.description === undefined ? {} : { description: flow.description }),
    ...(flow.app === undefined ? {} : { app: flow.app }),
    ...(flow.target === undefined ? {} : { target: flow.target }),
    ...(flow.timeoutMs === undefined ? {} : { timeoutMs: flow.timeoutMs }),
    steps: flow.steps,
  };
  return stringify(ordered, { lineWidth: 0 });
}

export interface RecordingToFlowOptions {
  readonly name: string;
  readonly description?: string;
  readonly app?: FlowApp;
}

/** What turning a recording into a flow left out or changed, for the user to look at. */
export interface RecordedFlow {
  readonly flow: Flow;
  /** Environment variables the flow reads for values that were not recorded (password fields). */
  readonly secrets: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Turn recorded actions (`record.events`) into a flow: one `act` step per action, in order. The page
 * most actions happened in becomes the flow's target; others get their own. Typing collapses into the
 * field's last value, a click followed by its double click into one double click, and password fields
 * read their value from an environment variable (`${env.FLOW_SECRET_1}`…) instead of the recording.
 */
export function flowFromRecording(
  events: readonly RecordedEvent[],
  options: RecordingToFlowOptions,
): RecordedFlow {
  const notes: string[] = [];
  const secrets: string[] = [];
  const target = mostCommon(events.map((event) => event.target));
  const steps: { target: string; action: Action }[] = [];
  for (const event of events) {
    let action = event.action;
    if (event.secret === true && action.type === 'fill') {
      const variable = `FLOW_SECRET_${secrets.length + 1}`;
      secrets.push(variable);
      action = { ...action, value: `\${env.${variable}}` };
    }
    const previous = steps.at(-1);
    if (previous?.target === event.target && replaces(previous.action, action)) {
      previous.action = action;
      continue;
    }
    steps.push({ target: event.target, action });
  }
  if (steps.length > MAX_STEPS) notes.push(`kept the first ${MAX_STEPS} of ${steps.length} steps`);
  if (steps.length === 0) notes.push('nothing was recorded');
  const flowSteps: FlowStep[] = steps.slice(0, MAX_STEPS).map((step) => ({
    ...(step.target === target ? {} : { target: step.target }),
    act: step.action,
  }));
  const flow: Flow = {
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.app === undefined ? {} : { app: options.app }),
    ...(target === undefined ? {} : { target }),
    // An empty recording still makes a valid flow file that says so.
    steps: flowSteps.length > 0 ? flowSteps : [{ name: 'nothing was recorded', reset: true }],
  };
  return { flow, secrets, notes };
}

/** `next` makes `previous` redundant: a field's later value, or the double click a click began. */
function replaces(previous: Action, next: Action): boolean {
  if (previous.type === 'fill' && next.type === 'fill') return sameLocator(previous.locator, next.locator);
  if (
    previous.type === 'click' &&
    next.type === 'click' &&
    next.clickCount === 2 &&
    previous.clickCount === undefined
  ) {
    return sameLocator(previous.locator, next.locator);
  }
  return false;
}

function sameLocator(a: Locator, b: Locator): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  for (const [value, count] of counts)
    if (best === undefined || count > (counts.get(best) ?? 0)) best = value;
  return best;
}
