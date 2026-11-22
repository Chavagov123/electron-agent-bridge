/**
 * Drop `undefined` fields: tool inputs have optional fields that may be `undefined`, while protocol
 * params use exact optional properties (absent, never `undefined`).
 */
export function definedOf<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
