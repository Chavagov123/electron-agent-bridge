import { z } from 'zod';

import type { MethodDef } from '../method-def.js';

const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const WindowInfo = z.object({
  id: z.number().int(),
  /** Target id of the window's page, when it has one. */
  target: z.string().optional(),
  title: z.string(),
  visible: z.boolean(),
  focused: z.boolean(),
  minimized: z.boolean(),
  bounds: Bounds,
});

/** Main-process control (FR9). */
export const mainMethods = {
  'app.info': {
    params: z.object({}),
    data: z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
      isPackaged: z.boolean(),
      pid: z.number().int(),
      windows: z.array(WindowInfo),
    }),
    capability: 'observe',
  },
  'window.control': {
    params: z.object({
      window: z.number().int(),
      action: z.enum(['focus', 'show', 'hide', 'minimize', 'maximize', 'restore', 'close', 'setBounds']),
      bounds: Bounds.partial().optional(),
    }),
    data: z.object({ window: WindowInfo.optional() }),
    capability: 'interact',
  },
  /** Click an application-menu item by id or by label path (`['File', 'Open…']`). */
  'menu.click': {
    params: z
      .object({
        id: z.string().max(256).optional(),
        path: z.array(z.string().max(256)).min(1).max(10).optional(),
      })
      .refine((params) => (params.id === undefined) !== (params.path === undefined), {
        message: 'pass exactly one of id or path',
      }),
    data: z.object({ label: z.string() }),
    capability: 'interact',
  },
  /** Queue answers for native dialogs so flows do not block on them; restored on reset/disconnect. */
  'dialog.stub': {
    params: z.object({
      method: z.enum(['showOpenDialog', 'showSaveDialog', 'showMessageBox']),
      response: z.record(z.string(), z.unknown()),
      times: z.number().int().min(1).max(100).optional(),
    }),
    data: z.object({ queued: z.number().int() }),
    capability: 'eval',
  },
  /** Evaluate JavaScript in the main process. Only when the app grants `eval`. */
  'main.eval': {
    params: z.object({
      expression: z.string().min(1).max(10_000),
      timeoutMs: z.number().int().min(0).max(60_000).optional(),
    }),
    data: z.object({ type: z.string(), value: z.unknown(), truncated: z.boolean() }),
    capability: 'eval',
  },
} as const satisfies Record<string, MethodDef>;
