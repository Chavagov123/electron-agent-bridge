import { describe, expect, it } from 'vitest';

import { envelopeSchema, ok } from './envelope.js';
import {
  LIMITATION_CODES,
  compactLimitations,
  droppedLimitation,
  redactedLimitation,
  truncatedLimitation,
} from './limitations.js';
import { z } from 'zod';

describe('limitations', () => {
  it('builds well-known limitations and omits empty ones', () => {
    expect(truncatedLimitation('Snapshot', 10, 40, 'lines')).toEqual({
      code: LIMITATION_CODES.truncated,
      message: 'Snapshot: kept 10 of 40 lines.',
    });
    expect(droppedLimitation('IPC events', 0)).toBeUndefined();
    expect(droppedLimitation('IPC events', 3)?.code).toBe('dropped');
    expect(redactedLimitation(0)).toBeUndefined();
    expect(redactedLimitation(2)?.message).toContain('2 value(s)');
    expect(compactLimitations([undefined, redactedLimitation(1), undefined])).toHaveLength(1);
  });
});

describe('envelope', () => {
  it('wraps data and validates envelopes from the wire', () => {
    const envelope = ok({ n: 1 });
    expect(envelope).toEqual({ data: { n: 1 }, limitations: [] });
    const schema = envelopeSchema(z.object({ n: z.number() }));
    expect(schema.safeParse({ ...envelope, untrusted: true }).success).toBe(true);
    expect(schema.safeParse({ data: { n: 'x' }, limitations: [] }).success).toBe(false);
  });
});
