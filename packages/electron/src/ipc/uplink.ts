import type { IpcEvent } from '@electron-agent-bridge/core';

import type { CorrelationQueue } from './correlation.js';
import { keyOf, safely, senderOf } from './ipc-main-wrapper.js';
import type { IpcRecorder } from './ipc-recorder.js';

const MAX_BATCH = 500;
const MAX_CHANNEL = 256;
const MAX_SHAPE = 1_000;
const KINDS = new Set(['send', 'sendSync', 'invoke', 'postMessage', 'bridgeCall']);
const PHASES = new Set(['request', 'response', 'error']);
/** Renderer invoke ids remembered to give responses their request's correlation id. */
const MAX_PENDING = 2_000;

interface UplinkEvent {
  readonly sender?: {
    readonly id?: number;
    getLastWebPreferences?: () => { contextIsolation?: boolean } | null;
  };
  readonly frameId?: number;
}

export interface UplinkContext {
  readonly recorder: IpcRecorder;
  readonly correlation: CorrelationQueue;
}

/**
 * Records batches the preload reports. Everything from a renderer is validated and bounded (a page may
 * send anything on any channel); without context isolation the page itself could have written the
 * batch, so its records are `trust: 'low'`. Requests take the correlation id of the matching main-side
 * record (first in, first out per page, frame and channel); without one they are `heuristic`. When the
 * renderer dropped records, that frame's waiting ids are forgotten so later records never pair wrongly.
 */
export function createUplinkHandler(context: UplinkContext): (event: UplinkEvent, batch: unknown) => void {
  const pending = new Map<string, string>();
  return (event, batch) => {
    safely(() => {
      const parsed = batchOf(batch);
      if (!parsed) return;
      const trust: IpcEvent['trust'] =
        event.sender?.getLastWebPreferences?.()?.contextIsolation === false ? 'low' : 'high';
      for (const raw of parsed.records.slice(0, MAX_BATCH)) {
        const record = validated(raw);
        if (record) recordOne(record, event, trust, parsed.instance);
      }
      if (parsed.dropped > 0 || parsed.records.length > MAX_BATCH) {
        context.correlation.clearPrefix(`${event.sender?.id ?? '?'}:${event.frameId ?? '?'}:`);
      }
    });
  };

  function recordOne(
    record: Validated,
    event: UplinkEvent,
    trust: IpcEvent['trust'],
    instance: string,
  ): void {
    // Request ids are per preload instance: every frame, and every reload, counts from 1.
    const ridKey =
      record.rid === undefined
        ? undefined
        : `${event.sender?.id ?? '?'}:${event.frameId ?? '?'}:${instance}:${record.rid}`;
    const { corr, correlation } = correlate(record, event, ridKey);
    context.recorder.record({
      channel: record.channel,
      kind: record.kind,
      phase: record.phase,
      side: 'renderer',
      trust,
      correlation,
      argShape: record.argShape,
      ...(corr === undefined ? {} : { corr }),
      ...(record.durMs === undefined ? {} : { durMs: record.durMs }),
      ...senderOf(event),
    });
  }

  /** A request takes the matching main-side id (or a new one); a response, its request's. */
  function correlate(
    record: Validated,
    event: UplinkEvent,
    ridKey: string | undefined,
  ): { corr: string | undefined; correlation: IpcEvent['correlation'] } {
    if (record.phase === 'request') {
      // Calls into the preload's own API never reach main: nothing there to pair with.
      const taken =
        record.kind === 'bridgeCall' ? undefined : context.correlation.take(keyOf(event, record.channel));
      const corr = taken ?? context.recorder.newCorr();
      if (ridKey !== undefined) remember(ridKey, corr);
      return {
        corr,
        correlation: taken === undefined && record.kind !== 'bridgeCall' ? 'heuristic' : 'exact',
      };
    }
    if (ridKey === undefined) return { corr: undefined, correlation: 'exact' };
    const corr = pending.get(ridKey);
    pending.delete(ridKey);
    return { corr, correlation: corr === undefined ? 'heuristic' : 'exact' };
  }

  function remember(key: string, corr: string): void {
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value ?? key);
    pending.set(key, corr);
  }
}

function batchOf(batch: unknown): { instance: string; dropped: number; records: unknown[] } | undefined {
  if (typeof batch !== 'object' || batch === null) return undefined;
  const { instance, dropped, records } = batch as Record<string, unknown>;
  if (typeof instance !== 'string' || instance.length > 32 || !Array.isArray(records)) return undefined;
  return {
    instance,
    dropped: Number.isSafeInteger(dropped) && (dropped as number) > 0 ? (dropped as number) : 0,
    records,
  };
}

interface Validated {
  readonly rid?: number;
  readonly channel: string;
  readonly kind: IpcEvent['kind'];
  readonly phase: IpcEvent['phase'];
  readonly argShape: string;
  readonly durMs?: number;
}

function validated(raw: unknown): Validated | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { rid, channel, kind, phase, argShape, durMs } = raw as Record<string, unknown>;
  if (typeof channel !== 'string' || channel === '' || channel.length > MAX_CHANNEL) return undefined;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof phase !== 'string' || !PHASES.has(phase))
    return undefined;
  return {
    channel,
    kind: kind as IpcEvent['kind'],
    phase: phase as IpcEvent['phase'],
    argShape: typeof argShape === 'string' ? argShape.slice(0, MAX_SHAPE) : '?',
    ...(Number.isSafeInteger(rid) ? { rid: rid as number } : {}),
    ...(typeof durMs === 'number' && Number.isFinite(durMs) && durMs >= 0 ? { durMs } : {}),
  };
}
