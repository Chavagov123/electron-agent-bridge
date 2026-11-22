import { z } from 'zod';

import { LocatorSchema, TargetSelectorSchema } from '../../model/locator.js';
import type { MethodDef } from '../method-def.js';

const StoreInfo = z.object({
  name: z.string(),
  kind: z.enum(['redux', 'zustand', 'mobx', 'generic']),
  actions: z.number().int().optional(),
});

/** Renderer application state (FR6). Values are redacted and size-bounded. */
export const stateMethods = {
  'state.read': {
    params: z.object({
      target: TargetSelectorSchema,
      store: z.string().max(128).optional(),
      /** Dot/bracket path into the state, e.g. `orders.items[0].id`. */
      path: z.string().max(500).optional(),
      maxDepth: z.number().int().min(1).max(20).optional(),
    }),
    data: z.object({
      stores: z.array(StoreInfo),
      store: z.string().optional(),
      path: z.string().optional(),
      value: z.unknown(),
      truncated: z.boolean(),
    }),
    capability: 'observe',
  },
  'state.dispatch': {
    params: z.object({
      target: TargetSelectorSchema,
      store: z.string().max(128).optional(),
      action: z.record(z.string(), z.unknown()),
    }),
    data: z.object({ dispatched: z.literal(true) }),
    capability: 'interact',
  },
  /** Since protocol 1.1: the React or Vue 3 component state behind an element. */
  'state.component': {
    params: z.object({
      target: TargetSelectorSchema,
      locator: LocatorSchema,
      /** Path into the component's `{ props, state, hooks }`, e.g. `hooks[0]` or `props.label`. */
      path: z.string().max(500).optional(),
      /** 0: the nearest component around the element (default); 1: its parent component… */
      component: z.number().int().min(0).max(9).optional(),
      maxDepth: z.number().int().min(1).max(20).optional(),
    }),
    data: z.object({
      framework: z.enum(['react', 'vue']),
      /** Component names around the element, nearest first. */
      chain: z.array(z.string()),
      name: z.string(),
      path: z.string().optional(),
      value: z.unknown(),
      truncated: z.boolean(),
    }),
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
