import { z } from 'zod';

/** Element ref from a snapshot: `e12`, or `f2:e7` for an element inside frame 2. */
export const RefSchema = z.string().regex(/^(f\d+:)?e\d+$/, 'expected a ref like e12 or f2:e7');

/**
 * How to point at an element. Prefer `ref` (from the latest snapshot); otherwise role + name, text,
 * or CSS as a last resort. `nth` picks among several matches (0-based); without it, several
 * matches are an `AMBIGUOUS` error.
 */
export const LocatorSchema = z
  .object({
    ref: RefSchema.optional(),
    role: z.string().min(1).max(64).optional(),
    name: z.string().max(500).optional(),
    /** Match `name`/`text` exactly instead of case-insensitive substring. */
    exact: z.boolean().optional(),
    text: z.string().min(1).max(500).optional(),
    css: z.string().min(1).max(500).optional(),
    nth: z.number().int().min(0).max(10_000).optional(),
  })
  .refine(
    (locator) =>
      locator.ref !== undefined ||
      locator.role !== undefined ||
      locator.text !== undefined ||
      locator.css !== undefined,
    { message: 'a locator needs ref, role, text or css' },
  );
export type Locator = z.infer<typeof LocatorSchema>;

/** Selects a target (page) by id or name; omitted means the focused window. */
export const TargetSelectorSchema = z.string().min(1).max(128).optional();
