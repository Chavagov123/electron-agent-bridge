import { ActionSchema, WaitConditionSchema, type ActionType, type WaitCondition } from '@eab/core';
import { z } from 'zod';

/**
 * Small schemas advertised in the compact profile. They only document the input: every call is
 * validated against the full schema. Loose objects show that more fields are accepted than listed.
 */

/** A locator as one short line of schema: the fields, no per-field descriptions. */
export const CompactLocator = z
  .looseObject({
    ref: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
  })
  .describe('Element: ref (e12, preferred) or role+name, text, css; exact, nth optional.');

/** Taken from the full schemas, so the compact profile never lags behind core. */
const STEP_TYPES = ActionSchema.options.map((option) => option.shape.type.value);
const CONDITION_KINDS = WaitConditionSchema.options.map((option) => option.shape.kind.value);

/** One `act` step with its fields listed in prose instead of a discriminated union per type. */
export const CompactStep = z
  .looseObject({
    type: z.enum(STEP_TYPES as [ActionType, ...ActionType[]]),
    locator: CompactLocator.optional(),
  })
  .describe(
    'Fields by type: fill {locator,value}; type {text,locator?}; press {key e.g. "Control+S",locator?}; ' +
      'select {locator,values[]}; upload {locator,files[] absolute}; drag {from,to}; ' +
      'scroll {locator?,deltaX?,deltaY?}; fillForm {fields[{locator,value: string|boolean|string[]}]}; ' +
      'click {locator,button?,clickCount?,modifiers?[]}; hover/check/uncheck {locator}.',
  );

/** Paging fields without per-field descriptions (the tool descriptions explain newOnly). */
export const compactPaging = {
  newOnly: z.boolean().optional(),
  since: z.number().optional(),
  limit: z.number().optional(),
};

/** Wait conditions, flattened. */
export const CompactCondition = z
  .looseObject({ kind: z.enum(CONDITION_KINDS as [WaitCondition['kind'], ...WaitCondition['kind'][]]) })
  .describe(
    'element {locator,state?: visible|hidden|enabled|attached|detached}; text {text,present?}; ' +
      'url {contains}; networkIdle {idleMs?}; ipc {channel}; state {path,equals,store?}.',
  );
