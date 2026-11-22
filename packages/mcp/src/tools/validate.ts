import { BridgeError } from '@eab/core';
import type { z } from 'zod';

/**
 * Validate against the full schema (the compact one is looser), naming every problem. Unknown fields
 * are refused, not dropped: a misspelt option would otherwise be ignored without a word.
 */
export function parseInput(schema: z.ZodObject, raw: unknown): unknown {
  const parsed = schema.strict().safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const fields = Object.keys(schema.shape).join(', ');
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.join('.') || 'input';
    if (issue.code !== 'unrecognized_keys') return `${where}: ${issue.message}`;
    const keys = issue.keys.map((key) => `"${key}"`).join(', ');
    const known = issue.path.length === 0 ? `; fields: ${fields || 'none'}` : '';
    return `${where}: unknown field${issue.keys.length > 1 ? 's' : ''} ${keys}${known}`;
  });
  throw new BridgeError('INVALID_PARAMS', `invalid input: ${problems.join('; ')}`, {
    hint: 'Check the field names and types; EAB_TOOL_PROFILE=full lists every field of every tool.',
  });
}
