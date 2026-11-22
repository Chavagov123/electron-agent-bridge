import {
  BridgeError,
  LIMITATION_CODES,
  type Action,
  type ActionType,
  type Limitation,
  type Locator,
  type ResolvedElement,
} from '@eab/core';
import type { ActionTarget, ControlState, Requirements } from '@eab/page-agent';
import { z } from 'zod';

import type { PageAgentClient } from '../page/page-agent-client.js';
import type { Clock } from '../ports/clock.js';
import type { InputDriver } from './input-driver.js';
import { waitForTarget } from './locate.js';

/** Everything one step needs. `notes` collects limitations (fallbacks used, refs healed). */
export interface StepContext {
  readonly client: PageAgentClient;
  readonly input: InputDriver;
  readonly clock: Clock;
  readonly deadline: number;
  readonly notes: Limitation[];
  /** Elements this step acted on, filled in as they are located (bounded by the step's locators). */
  readonly resolved?: ResolvedElement[];
}

const CLICKABLE: Requirements = { enabled: true, hitTest: true };
const FOCUSABLE: Requirements = { enabled: true, hitTest: false };
const VISIBLE: Requirements = { enabled: false, hitTest: false };
/** File inputs are usually hidden behind a styled label; files are set through CDP, not input. */
const PRESENT: Requirements = { enabled: true, hitTest: false, visible: false };

const LayoutMetrics = z.object({
  cssVisualViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
});

type Performer<T extends ActionType> = (
  action: Extract<Action, { type: T }>,
  context: StepContext,
) => Promise<void>;

/** One performer per action type; adding an action type without one is a type error. */
const PERFORMERS: { readonly [T in ActionType]: Performer<T> } = {
  click: (action, context) =>
    click(action.locator, context, {
      ...(action.button === undefined ? {} : { button: action.button }),
      ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
      ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }),
    }),
  hover: async (action, context) => {
    const target = await locate(action.locator, { enabled: false, hitTest: true }, context);
    await context.input.move(target);
  },
  fill: (action, context) => fill(action.locator, action.value, context),
  fillForm: async (action, context) => {
    for (const field of action.fields) await fillField(field.locator, field.value, context);
  },
  type: async (action, context) => {
    if (action.locator) await focusOn(action.locator, false, context);
    await context.input.insertText(action.text);
  },
  press: async (action, context) => {
    if (action.locator) await focusOn(action.locator, false, context);
    await context.input.press(action.key);
  },
  check: (action, context) => setChecked(action.locator, true, context),
  uncheck: (action, context) => setChecked(action.locator, false, context),
  select: (action, context) => select(action.locator, action.values, context),
  scroll: (action, context) => scroll(action, context),
  upload: (action, context) => upload(action.locator, action.files, context),
  drag: (action, context) => drag(action.from, action.to, context),
};

/** Perform one action. Throws a `BridgeError` with a precise code on failure. */
export function performStep(action: Action, context: StepContext): Promise<void> {
  // The table is keyed by the action's own type; TypeScript cannot correlate the two by itself.
  const performer = PERFORMERS[action.type] as Performer<ActionType>;
  return performer(action, context);
}

async function locate(
  locator: Locator,
  requirements: Requirements,
  context: StepContext,
): Promise<ActionTarget> {
  const target = await waitForTarget(context.client, context.clock, {
    locator,
    requirements,
    deadline: context.deadline,
  });
  context.resolved?.push({ ref: target.ref, role: target.role, name: target.name });
  if (target.healed && locator.ref !== undefined) {
    context.notes.push({
      code: LIMITATION_CODES.approximate,
      message: `${locator.ref} was stale; acted on ${target.ref}, the only element with the same role and name.`,
    });
  }
  return target;
}

async function click(
  locator: Locator,
  context: StepContext,
  options: Parameters<InputDriver['click']>[1],
): Promise<void> {
  const target = await locate(locator, CLICKABLE, context);
  await context.input.click(target, options);
}

async function focusOn(locator: Locator, selectAll: boolean, context: StepContext): Promise<ActionTarget> {
  const target = await locate(locator, FOCUSABLE, context);
  await context.client.invoke('focus', [target.ref, selectAll]);
  return target;
}

/** Replace the field's content: select all, then trusted text input; verify, else fall back to JS. */
async function fill(locator: Locator, value: string, context: StepContext): Promise<void> {
  const target = await locate(locator, FOCUSABLE, context);
  if (target.tag === 'select') return selectValues(target, [value], context);
  if (!target.editable) {
    throw new BridgeError('INVALID_PARAMS', `fill needs a text field; ${target.ref} is a ${target.role}`, {
      hint: 'Use check/uncheck for checkboxes, select for dropdowns, upload for file inputs.',
    });
  }
  await context.client.invoke('focus', [target.ref, true]);
  if (value === '') await context.input.press('Delete');
  else await context.input.insertText(value);
  const state = await context.client.invoke<ControlState>('state', [target.ref]);
  if (normalise(state.value) === normalise(value)) return;
  // Masked inputs and custom editors may reject or transform typed text: set the value directly.
  await context.client.invoke('setValue', [target.ref, value]);
  context.notes.push({
    code: LIMITATION_CODES.approximate,
    message: `Typing into ${target.ref} did not produce the value; it was set directly (untrusted input events).`,
  });
}

async function fillField(
  locator: Locator,
  value: string | boolean | readonly string[],
  context: StepContext,
): Promise<void> {
  if (typeof value === 'boolean') return setChecked(locator, value, context);
  if (Array.isArray(value)) return select(locator, value, context);
  return fill(locator, value as string, context);
}

async function setChecked(locator: Locator, wanted: boolean, context: StepContext): Promise<void> {
  const target = await locate(locator, CLICKABLE, context);
  const before = await context.client.invoke<ControlState>('state', [target.ref]);
  if (before.checked === wanted) return;
  if (!wanted && target.inputType === 'radio') {
    throw new BridgeError(
      'INVALID_PARAMS',
      'a radio button cannot be unchecked; check another option instead',
    );
  }
  await context.input.click(target);
  const after = await context.client.invoke<ControlState>('state', [target.ref]);
  if (after.checked !== wanted) {
    throw new BridgeError('INTERNAL', `clicking ${target.ref} did not ${wanted ? 'check' : 'uncheck'} it`, {
      hint: 'The page may control this state itself; check the snapshot for what changed.',
    });
  }
}

async function select(locator: Locator, values: readonly string[], context: StepContext): Promise<void> {
  const target = await locate(locator, FOCUSABLE, context);
  await selectValues(target, values, context);
}

async function selectValues(
  target: ActionTarget,
  values: readonly string[],
  context: StepContext,
): Promise<void> {
  await context.client.invoke('selectOptions', [target.ref, values]);
}

async function scroll(action: Extract<Action, { type: 'scroll' }>, context: StepContext): Promise<void> {
  const point = action.locator
    ? await locate(action.locator, VISIBLE, context)
    : await viewportCentre(context);
  if (action.deltaX === undefined && action.deltaY === undefined) return;
  await context.input.wheel(point, action.deltaX ?? 0, action.deltaY ?? 0);
}

async function viewportCentre(context: StepContext): Promise<{ x: number; y: number }> {
  const metrics = LayoutMetrics.parse(await context.client.transport.send('Page.getLayoutMetrics'));
  return { x: metrics.cssVisualViewport.clientWidth / 2, y: metrics.cssVisualViewport.clientHeight / 2 };
}

async function upload(locator: Locator, files: readonly string[], context: StepContext): Promise<void> {
  const target = await locate(locator, PRESENT, context);
  if (target.inputType !== 'file') {
    throw new BridgeError(
      'INVALID_PARAMS',
      `upload needs an <input type=file>; ${target.ref} is a ${target.role}`,
    );
  }
  await context.client.withElements([target.ref], async ([objectId]) => {
    if (objectId === undefined) throw new BridgeError('STALE_REF', `${target.ref} disappeared`);
    try {
      await context.client.transport.send('DOM.setFileInputFiles', { files, objectId });
    } catch (error) {
      throw new BridgeError('INVALID_PARAMS', `could not set files: ${BridgeError.from(error).message}`, {
        hint: 'Paths must be absolute and exist on the machine running the app.',
      });
    }
  });
}

async function drag(from: Locator, to: Locator, context: StepContext): Promise<void> {
  const source = await locate(from, CLICKABLE, context);
  const destination = await locate(to, VISIBLE, context);
  if (!source.draggable) return context.input.drag(source, destination);
  // Chromium does not start native HTML5 drag-and-drop from CDP mouse events.
  await context.client.invoke('drag', [source.ref, destination.ref]);
  context.notes.push({
    code: LIMITATION_CODES.approximate,
    message: `${source.ref} uses HTML5 drag and drop; it was simulated with synthetic drag events (untrusted).`,
  });
}

function normalise(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}
