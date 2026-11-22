import { BridgeError } from '@eab/core';

import type { LaunchStrategy } from './environment.js';

/** What one strategy attempt observed. */
export type AttemptOutcome =
  /** The bridge never loaded: the app ignored NODE_OPTIONS or --inspect-brk. */
  | { readonly kind: 'no-effect' }
  /** The inspector opened but the app's first script never ran past it. */
  | { readonly kind: 'no-user-script' }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  /** The bridge loaded but its gate refused (e.g. a packaged app without allowPackaged). */
  | { readonly kind: 'off'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  /** The app's own main process threw (Electron then blocks on an error box). */
  | { readonly kind: 'crashed'; readonly crash: string }
  | { readonly kind: 'timeout'; readonly stage: string }
  /** Not tried: the binary's fuse for this strategy is off (read from the binary before launching). */
  | { readonly kind: 'fuse-off'; readonly fuse: string };

export interface Attempt {
  readonly strategy: LaunchStrategy;
  readonly outcome: AttemptOutcome;
}

const CAUSES: Record<LaunchStrategy, string> = {
  'node-options':
    'NODE_OPTIONS had no effect (the EnableNodeOptionsEnvironmentVariable fuse is probably off)',
  inspector: '--inspect-brk was ignored (the EnableNodeCliInspectArguments fuse is probably off)',
};

const INTEGRATED_HINT =
  "Use Integrated mode: add `import '@eab/electron/register'` as the first import of the app's main " +
  'process and start it with EAB_ENABLE=1 (docs/modes.md).';

/**
 * Turn what the attempts saw into one error an agent can act on. A refusal by the bridge's own gate is
 * `NOT_ENABLED` (a decision, not a blocked binary); everything else that kept the bridge out is
 * `LAUNCH_BLOCKED` with each strategy's likely cause and the Integrated-mode fallback.
 */
export function diagnose(executable: string, attempts: readonly Attempt[], outputTail: string): BridgeError {
  const refused = attempts.find((attempt) => attempt.outcome.kind === 'off');
  if (refused?.outcome.kind === 'off') {
    const packaged = refused.outcome.reason.includes('packaged');
    return new BridgeError(
      'NOT_ENABLED',
      `the bridge refused to start in ${executable}: ${refused.outcome.reason}`,
      {
        hint: packaged
          ? 'This is a packaged build. To automate it anyway, launch with allowPackaged (eab launch --allow-packaged).'
          : 'Check the EAB_* variables passed to the app.',
      },
    );
  }
  const causes = attempts.map((attempt) => `${attempt.strategy}: ${describe(attempt)}`);
  const tail = outputTail.trim() === '' ? '' : `\nApp output (last lines):\n${outputTail.trim()}`;
  const crashed = attempts.some((attempt) => attempt.outcome.kind === 'crashed');
  return new BridgeError(
    'LAUNCH_BLOCKED',
    `could not start the bridge in ${executable}. ${causes.join('; ')}.${tail}`,
    {
      hint: crashed
        ? 'The app failed on its own (e.g. a missing native module): it fails the same way without the bridge. Fix the app, then launch again.'
        : INTEGRATED_HINT,
    },
  );
}

function describe({ strategy, outcome }: Attempt): string {
  switch (outcome.kind) {
    case 'no-effect':
      return CAUSES[strategy];
    case 'no-user-script':
      return "the inspector never reached the app's own code (packaged CommonJS apps on Electron 35)";
    case 'exited':
      return `the app exited before the bridge started (${outcome.signal ?? `code ${String(outcome.code)}`})`;
    case 'failed':
      return `the bridge failed to start: ${outcome.reason}`;
    case 'crashed':
      return `the app's main process threw (${outcome.crash.split('\n')[0] ?? ''})`;
    case 'timeout':
      return `timed out waiting for ${outcome.stage}`;
    case 'off':
      return `refused: ${outcome.reason}`;
    case 'fuse-off':
      return `not tried: the ${outcome.fuse} fuse of this binary is off`;
  }
}
