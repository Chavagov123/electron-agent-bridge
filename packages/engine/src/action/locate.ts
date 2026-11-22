import { BridgeError, type ErrorCode, type Locator } from '@eab/core';
import type { ActionTarget, Requirements } from '@eab/page-agent';

import { detachedError } from '../page/agent-pool.js';
import type { PageAgentClient } from '../page/page-agent-client.js';
import type { Clock } from '../ports/clock.js';

/** Conditions that may resolve by themselves (the page is still rendering): keep checking. */
const TRANSIENT = new Set<ErrorCode>([
  'NOT_FOUND',
  'HIDDEN',
  'DISABLED',
  'OCCLUDED',
  'OFF_SCREEN',
  'DETACHED',
  'TIMEOUT',
]);
const POLL_MS = 50;

const HINTS: Partial<Record<ErrorCode, string>> = {
  NOT_FOUND:
    'Take a fresh snapshot or use find to get a current ref. While a dialog is open, the page behind it is hidden (aria-hidden) until the dialog closes.',
  HIDDEN: 'Open whatever reveals the element first (a menu, tab or dialog), or wait for it.',
  DISABLED: 'Fill in what the form requires first, or wait until the element is enabled.',
  OCCLUDED: 'Close the overlay (dialog, popup, cookie banner) that covers the element.',
  OFF_SCREEN: 'Scroll its container, or use a ref of an element that is in view.',
  DETACHED: 'The element was removed while acting on it; take a fresh snapshot.',
  TIMEOUT: 'The element kept moving (animation); retry, or raise timeoutMs.',
  AMBIGUOUS: 'Use a ref from a snapshot, add nth, or make the name exact.',
  STALE_REF: 'Take a fresh snapshot to get current refs.',
};

/**
 * Wait until the element is actionable (auto-wait), up to `deadline`. Transient problems (not yet
 * rendered, hidden, disabled, covered, moving) are retried; on timeout the last problem is reported
 * with its own code and a hint, so the agent knows why rather than just "timed out".
 */
export async function waitForTarget(
  client: PageAgentClient,
  clock: Clock,
  request: { locator: Locator; requirements: Requirements; deadline: number },
): Promise<ActionTarget> {
  for (;;) {
    try {
      return await client.invoke<ActionTarget>('actionTarget', [request.locator, request.requirements]);
    } catch (error) {
      const failure = BridgeError.from(error);
      // DETACHED is transient for an element being re-rendered, final for the page itself.
      if (!client.transport.attached) throw detachedError('the page', client.transport);
      // TIMEOUT from the agent means "still moving": worth another look until the deadline.
      if (!TRANSIENT.has(failure.code) || clock.now() >= request.deadline) {
        throw withHint(failure.code, failure.message);
      }
      await clock.sleep(POLL_MS);
    }
  }
}

/** Attach the standard hint for an action failure code. */
export function withHint(code: ErrorCode, message: string): BridgeError {
  const hint = HINTS[code];
  return new BridgeError(code, message.replace(/^page agent: /, ''), hint === undefined ? {} : { hint });
}
