import { z } from 'zod';

/**
 * Turn command-line strings into the types a tool's schema wants: a value stays a string where the
 * schema accepts one (`--contains 404`, `--text true`), and is read as JSON otherwise (`--depth 3`,
 * `--values '["a"]'`). Nested objects (`--locator.nth 2`) follow their own schema.
 */
export function coerce(schema: z.ZodType, value: unknown): unknown {
  const inner = unwrap(schema);
  if (typeof value === 'string') return acceptsString(inner) ? value : parsedOrRaw(value);
  if (isPlainObject(value) && inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>;
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, coerce(shape[key] ?? z.unknown(), field)]),
    );
  }
  return value;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function acceptsString(schema: z.ZodType): boolean {
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return true;
  if (schema instanceof z.ZodLiteral) return typeof schema.value === 'string';
  if (schema instanceof z.ZodUnion)
    return schema.options.some((option) => acceptsString(unwrap(option as z.ZodType)));
  return false;
}

function parsedOrRaw(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
