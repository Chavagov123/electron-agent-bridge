import { BridgeError, type TargetKind } from '@eab/core';
import { LATE, withDeadline } from '@eab/engine';

import type { MethodHandlers } from '../control/rpc-session.js';
import type { SyncWait, SyncWaits } from '../ipc/sync-waits.js';

/** Methods that run in a page: a page blocked on `sendSync` cannot answer them. */
const PAGE_METHODS = [
  'snapshot.take',
  'dom.find',
  'action.run',
  'wait.for',
  'screenshot.take',
  'state.read',
  'state.dispatch',
  'state.component',
] as const;

/** A `sendSync` unanswered for this long, with a window opened meanwhile (its dialog): blocked. */
export const BLOCKED_AFTER_MS = 1_000;
/** Unanswered this long, a page is blocked even with no new window (slow sync handlers end sooner). */
export const BLOCKED_ANYWAY_MS = 5_000;
/** How long a blocked page's renderer gets to answer a trivial evaluation before it counts as stuck. */
export const PROBE_MS = 300;
const CHECK_EVERY_MS = 100;
const OTHERS_SHOWN = 5;

interface PageTarget {
  readonly id: string;
  readonly name: string;
  readonly kind: TargetKind;
  /** To confirm the page is stuck before refusing it (absent: the wait record is trusted). */
  readonly transport?: { send(method: string, params?: object): Promise<unknown> };
}

export interface BlockedPagesDeps {
  readonly waits: SyncWaits;
  readonly targets: {
    resolve(selector?: string): PageTarget;
    list(): readonly PageTarget[];
  };
  readonly now?: () => number;
}

type Handler = (input: unknown) => unknown;

/**
 * Make page methods fail fast, saying why, when their page is blocked on an unanswered
 * `ipcRenderer.sendSync` (typically while the app shows a dialog before replying): such a page runs no
 * script and takes no input, so the call would otherwise hang until the client gives up.
 *
 * A page counts as blocked only when its oldest wait is over {@link BLOCKED_AFTER_MS} old and a window
 * opened meanwhile, or over {@link BLOCKED_ANYWAY_MS} old; and when it then fails to answer a trivial
 * evaluation within {@link PROBE_MS}. A page that answers was not blocked: its waits are dropped (they
 * were answered in a way the wrappers could not see). A call to a page already blocked is not run; one
 * that the page stops answering partway (a click that opens the dialog) fails, noting that it may have
 * taken effect. `wait.for` an IPC condition needs no page and is left alone.
 */
export function guardBlockedPages(handlers: MethodHandlers, deps: BlockedPagesDeps): MethodHandlers {
  const guarded: Record<string, Handler> = { ...(handlers as Record<string, Handler>) };
  for (const method of PAGE_METHODS) {
    const handler = guarded[method];
    if (handler === undefined) continue;
    guarded[method] = (input) =>
      needsPage(input) ? whileResponsive(method, input, () => handler(input), deps) : handler(input);
  }
  return guarded;
}

function needsPage(input: unknown): boolean {
  return (input as { condition?: { kind?: string } }).condition?.kind !== 'ipc';
}

async function whileResponsive(
  method: string,
  input: unknown,
  run: () => unknown,
  deps: BlockedPagesDeps,
): Promise<unknown> {
  const check = blockCheck((input as { target?: string }).target, deps);
  const already = await check();
  if (already) throw blockedError({ method, ...already, started: false }, deps);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearInterval(timer);
      return true;
    };
    const timer = setInterval(() => {
      void check().then((found) => {
        if (found && finish()) reject(blockedError({ method, ...found, started: true }, deps));
      });
    }, CHECK_EVERY_MS);
    timer.unref();
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

interface Found {
  readonly page: PageTarget;
  readonly wait: SyncWait;
  readonly now: number;
}

/**
 * Whether the call's page is blocked now. The default target follows focus, so it is fixed at once; a
 * named one is looked up only once some page waits (usually none does, and listing targets costs).
 * One probe at a time; once a probe times out the page stays blocked for this call, and once one
 * cannot be sent the guard stands aside for it.
 */
function blockCheck(selector: string | undefined, deps: BlockedPagesDeps): () => Promise<Found | undefined> {
  const now = deps.now ?? Date.now;
  let page = selector === undefined || deps.waits.pending ? pageOf(selector, deps) : undefined;
  let lookedUp = page !== undefined;
  let probing = false;
  let stuck = false;
  let unknown = false;
  return async () => {
    if (!deps.waits.pending || probing) return undefined;
    if (!lookedUp) {
      page = pageOf(selector, deps);
      lookedUp = true;
    }
    const wait = page === undefined ? undefined : deps.waits.oldest(page.id);
    if (page === undefined || wait === undefined) return undefined;
    const age = now() - wait.since;
    const suspect = age >= BLOCKED_ANYWAY_MS || (age >= BLOCKED_AFTER_MS && deps.waits.openedDuring(wait));
    if (!suspect) return undefined;
    if (unknown) return undefined;
    if (!stuck) {
      probing = true;
      const answer = await probe(page);
      probing = false;
      if (answer === 'answers') {
        deps.waits.clear(page.id);
        return undefined;
      }
      // The probe could not be sent (debugger detached, DevTools took over): no evidence either way,
      // so the call runs as it would without the guard.
      if (answer === 'unknown') {
        unknown = true;
        return undefined;
      }
      stuck = true;
    }
    return { page, wait, now: now() };
  };
}

/**
 * Whether the page's renderer runs a trivial evaluation in time: a page blocked on sendSync cannot
 * (`stuck`). A probe that fails outright says nothing about the renderer (`unknown`).
 */
async function probe(page: PageTarget): Promise<'answers' | 'stuck' | 'unknown'> {
  if (page.transport === undefined) return 'stuck';
  const sent = (async () => {
    await page.transport?.send('Runtime.evaluate', { expression: '0', returnByValue: true });
    return true as const;
  })();
  const result = await withDeadline(sent, PROBE_MS);
  if (result === LATE) return 'stuck';
  return result === undefined ? 'unknown' : 'answers';
}

/** `undefined` for an unknown target: the handler reports it. */
function pageOf(selector: string | undefined, deps: BlockedPagesDeps): PageTarget | undefined {
  try {
    return deps.targets.resolve(selector);
  } catch {
    return undefined;
  }
}

interface Blocked extends Found {
  readonly method: string;
  /** The call was already running when the page stopped answering. */
  readonly started: boolean;
}

function blockedError({ method, page, wait, now, started }: Blocked, deps: BlockedPagesDeps): BridgeError {
  const seconds = ((now - wait.since) / 1000).toFixed(1);
  const state = started ? 'stopped responding' : 'is blocked';
  const outcome = started
    ? `${method} may already have taken effect (a click that opened a dialog, say).`
    : `${method} was not run.`;
  const others = deps.targets
    .list()
    .filter((target) => target.id !== page.id && target.kind !== 'worker' && target.kind !== 'serviceWorker')
    .slice(0, OTHERS_SHOWN)
    .map((target) => `${target.name} (${target.id})`);
  const where = others.length === 0 ? '' : ` Other targets: ${others.join(', ')}.`;
  return new BridgeError(
    'TIMEOUT',
    `"${page.name}" (${page.id}) ${state}: it is waiting for the main process to answer ` +
      `ipcRenderer.sendSync("${wait.channel}") (${seconds} s so far). ${outcome}`,
    {
      hint:
        'A page runs nothing until its sendSync is answered, usually when the dialog the app opened for ' +
        `it is closed. Answer that dialog (its own target) first, then retry.${where}`,
    },
  );
}
