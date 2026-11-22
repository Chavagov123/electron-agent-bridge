/**
 * Bundle entry: installs the agent as `__eab` in the isolated world it is evaluated in. Idempotent:
 * re-evaluating (e.g. `runImmediately` plus a recovery injection) keeps the first instance and its refs;
 * only an agent of another version is replaced.
 */
import { createAgent } from './agent.js';

declare const __EAB_AGENT_VERSION__: string;

const KEY = '__eab';
const scope = globalThis as unknown as Record<string, unknown>;
const installed = scope[KEY] as
  { readonly version?: unknown; recordStart?: () => unknown; recordStop?: () => unknown } | undefined;
// An agent of another version (an older bridge's, in a page that kept running) gives way to this one.
if (installed?.version !== __EAB_AGENT_VERSION__) {
  try {
    installed?.recordStop?.();
  } catch {
    // The old agent's listeners are its own concern.
  }
  const agent = createAgent(window, __EAB_AGENT_VERSION__);
  try {
    Object.defineProperty(scope, KEY, {
      value: agent,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    // While the engine records, its binding exists in this world from the document's start on.
    agent.recordStart();
  } catch {
    // An agent from before replacing was possible cannot be redefined: it stays, as it was.
    installed?.recordStart?.();
  }
}
