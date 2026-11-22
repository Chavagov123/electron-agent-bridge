import { z } from 'zod';

import { LocatorSchema, RefSchema, TargetSelectorSchema } from '../../model/locator.js';
import { TargetInfoSchema } from '../../model/target.js';
import type { MethodDef } from '../method-def.js';

const SnapshotParams = z.object({
  target: TargetSelectorSchema,
  /** `delta` returns only what changed since `since` (falls back to full when it cannot). */
  mode: z.enum(['full', 'delta']).optional(),
  since: z.string().max(64).optional(),
  /** Snapshot only this subtree. */
  root: LocatorSchema.optional(),
  depth: z.number().int().min(1).max(100).optional(),
  maxLines: z.number().int().min(1).max(20_000).optional(),
  /** `ax`: Chromium's accessibility tree via CDP (slower, exact names). */
  fidelity: z.enum(['dom', 'ax']).optional(),
});

const SnapshotData = z.object({
  target: z.string(),
  url: z.string(),
  title: z.string(),
  kind: z.enum(['full', 'delta', 'unchanged']),
  /** Pass as `since` for the next delta. */
  cursor: z.string().optional(),
  /** Indented `- role "name" [ref]` lines (or +/~/- lines for a delta). Page-authored: untrusted. */
  text: z.string(),
  lineCount: z.number().int(),
});

const FindData = z.object({
  matches: z.array(z.object({ ref: RefSchema, role: z.string(), name: z.string(), line: z.string() })),
  total: z.number().int(),
});

const ScreenshotData = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  width: z.number().int(),
  height: z.number().int(),
  /** Inline image, or absent when spilled to `path`. */
  base64: z.string().optional(),
  path: z.string().optional(),
});

/** Pages and what is on them. */
export const pageMethods = {
  'targets.list': {
    params: z.object({}),
    data: z.object({ targets: z.array(TargetInfoSchema) }),
    capability: 'observe',
  },
  'snapshot.take': { params: SnapshotParams, data: SnapshotData, capability: 'observe' },
  'dom.find': {
    params: z.object({
      target: TargetSelectorSchema,
      locator: LocatorSchema,
      limit: z.number().int().min(1).max(200).optional(),
    }),
    data: FindData,
    capability: 'observe',
  },
  'screenshot.take': {
    params: z.object({
      target: TargetSelectorSchema,
      locator: LocatorSchema.optional(),
      format: z.enum(['png', 'jpeg']).optional(),
      quality: z.number().int().min(1).max(100).optional(),
    }),
    data: ScreenshotData,
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
