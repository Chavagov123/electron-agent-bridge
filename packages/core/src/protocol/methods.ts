import type { z } from 'zod';

import { CapabilitySchema, type Capability, type MethodDef } from './method-def.js';
import { interactMethods } from './methods/interact.js';
import { mainMethods } from './methods/main.js';
import { observeMethods } from './methods/observe.js';
import { pageMethods } from './methods/page.js';
import { recordMethods } from './methods/record.js';
import { sessionMethods } from './methods/session.js';
import { stateMethods } from './methods/state.js';

export { CapabilitySchema, type Capability, type MethodDef };

/**
 * The protocol table: the single source of truth for method names, payloads and capabilities.
 * The runtime validates params with it and answers `UNSUPPORTED` for methods it does not implement
 * yet; the client derives its typed API from it.
 */
export const Methods = {
  ...sessionMethods,
  ...pageMethods,
  ...interactMethods,
  ...observeMethods,
  ...stateMethods,
  ...mainMethods,
  ...recordMethods,
} as const satisfies Record<string, MethodDef>;

export type MethodName = keyof typeof Methods;
/** Params a caller passes for method `M`. */
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
/** The validated params a handler receives for method `M`. */
export type MethodInput<M extends MethodName> = z.output<(typeof Methods)[M]['params']>;
/** The `data` payload method `M` returns inside its envelope. */
export type MethodData<M extends MethodName> = z.output<(typeof Methods)[M]['data']>;

/** Whether `name` is a known protocol method. */
export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(Methods, name);
}

/** Methods a session with these capabilities may call. */
export function methodsAllowed(capabilities: readonly Capability[]): MethodName[] {
  return (Object.keys(Methods) as MethodName[]).filter((name) =>
    capabilities.includes(Methods[name].capability),
  );
}
