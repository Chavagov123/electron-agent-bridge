import {
  BridgeError,
  LIMITATION_CODES,
  compactLimitations,
  droppedLimitation,
  ok,
  type Envelope,
  type Limitation,
  type MethodData,
  type MethodInput,
} from '@electron-agent-bridge/core';

import { CONSOLE_RATE_PER_SECOND, type ConsoleCollector } from '../observe/console-collector.js';
import type { LogBook } from '../observe/log-book.js';
import { MAX_IN_FLIGHT, type NetworkLog } from '../observe/network-log.js';
import { mapEntries } from '../observe/map-stack.js';
import type { StackMapper } from '../ports/stack-mapper.js';
import type { TargetRegistry } from '../targets/target-registry.js';

export interface RecordQueryDeps {
  readonly targets: TargetRegistry;
  readonly logs: LogBook;
  readonly console: ConsoleCollector;
  readonly network: NetworkLog;
  /** Maps stack frames to original sources when logs are read (absent: stacks as recorded). */
  readonly stacks?: StackMapper;
}

/** `logs.query`: renderer capture starts on the first call (with the pages' stored messages). */
export async function queryLogs(
  deps: RecordQueryDeps,
  input: MethodInput<'logs.query'>,
): Promise<Envelope<MethodData<'logs.query'>>> {
  const started = await deps.console.activate();
  // Gaps of a flood still going on get their entry now, so this read counts them.
  deps.console.flush();
  const targetId = targetIdOf(deps.targets, input.target);
  const page = deps.logs.query({
    ...paging(input),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.minLevel === undefined ? {} : { minLevel: input.minLevel }),
    ...(input.contains === undefined ? {} : { contains: input.contains }),
    ...(targetId === undefined ? {} : { targetId }),
  });
  const names = namesOf(deps.targets);
  const mapped =
    deps.stacks === undefined
      ? { items: page.items, late: false }
      : await mapEntries(page.items, deps.stacks);
  const items = mapped.items.map((entry) =>
    entry.target === undefined ? entry : { ...entry, target: names.get(entry.target) ?? entry.target },
  );
  // A cursor past the end (from an earlier runtime) was read from the start.
  const since = (input.since ?? 0) > deps.logs.lastSeq() ? 0 : (input.since ?? 0);
  const range = { since, nextSeq: page.nextSeq };
  const capped = deps.console.cappedIn(range, targetId);
  const limitations = compactLimitations([
    droppedLimitation('log entries', page.dropped),
    capped > 0
      ? {
          code: LIMITATION_CODES.dropped,
          message: `${capped} console message(s) were not recorded: a page logged faster than ${CONSOLE_RATE_PER_SECOND}/s.`,
        }
      : undefined,
    mapped.late
      ? {
          code: LIMITATION_CODES.partial,
          message:
            'Source maps are still loading (large bundles): stacks and locations are as recorded. ' +
            'Query again in a moment for original sources.',
        }
      : undefined,
    started
      ? {
          code: LIMITATION_CODES.partial,
          message:
            'Renderer console capture started with this query: earlier messages come from what each page ' +
            'stored since its last load, with only the top stack frame (their location may be a console wrapper). ' +
            'Workers and cross-origin iframes are listed under their own ids (wc3:w1).',
        }
      : undefined,
  ]);
  return ok({ ...page, items }, limitations);
}

/** `network.query`: recording starts on the first call; earlier requests are only there if an action had it on. */
export async function queryNetwork(
  deps: RecordQueryDeps,
  input: MethodInput<'network.query'>,
): Promise<Envelope<MethodData<'network.query'>>> {
  const started = await deps.network.activate();
  const targetId = targetIdOf(deps.targets, input.target);
  const { inFlight, ...page } = deps.network.query({
    ...paging(input),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.failedOnly === undefined ? {} : { failedOnly: input.failedOnly }),
    ...(targetId === undefined ? {} : { targetId }),
  });
  const names = namesOf(deps.targets);
  const items = page.items.map((record) => ({
    ...record,
    target: names.get(record.target) ?? record.target,
  }));
  const limitations: Limitation[] = compactLimitations([
    droppedLimitation('network records', page.dropped),
    started
      ? {
          code: LIMITATION_CODES.partial,
          message:
            'Network recording started with this query: requests made before it are missing ' +
            '(repeat the action to capture them).',
        }
      : undefined,
    inFlight > 0
      ? {
          code: LIMITATION_CODES.partial,
          message: `${inFlight} request(s) still in flight are listed once they finish.`,
        }
      : undefined,
    deps.network.forgotten > 0
      ? {
          code: LIMITATION_CODES.dropped,
          message: `${deps.network.forgotten} request(s) were forgotten unfinished (over ${MAX_IN_FLIGHT} in flight).`,
        }
      : undefined,
  ]);
  return ok({ ...page, items }, limitations);
}

function paging(input: { readonly since?: number | undefined; readonly limit?: number | undefined }) {
  return {
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

/** Records keep the page id; a selector may be its name, or the id of a page already closed. */
function targetIdOf(targets: TargetRegistry, selector: string | undefined): string | undefined {
  if (selector === undefined) return undefined;
  try {
    return targets.resolve(selector).id;
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'NOT_FOUND') return selector;
    throw error;
  }
}

function namesOf(targets: TargetRegistry): Map<string, string> {
  return new Map(targets.list().map((target) => [target.id, target.name]));
}
