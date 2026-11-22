/** Inputs to the enable decision. Pure so it can be tested without Electron. */
export interface GateInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  /** Set only through code (`enableAgentBridge({ allowPackaged: true })`), never through the environment. */
  readonly allowPackaged: boolean;
}

export type GateDecision = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

/**
 * The bridge runs only when `EAB_ENABLE=1` **and** the app is unpackaged or the app itself opted in.
 * Anything else means: no hooks, no socket, no files.
 */
export function evaluateGate({ env, isPackaged, allowPackaged }: GateInput): GateDecision {
  if (env['EAB_ENABLE'] !== '1') return { enabled: false, reason: 'EAB_ENABLE is not "1"' };
  if (env['EAB_DISABLE'] === '1') return { enabled: false, reason: 'EAB_DISABLE=1 (kill switch)' };
  if (isPackaged && !allowPackaged) {
    return { enabled: false, reason: 'packaged app without enableAgentBridge({ allowPackaged: true })' };
  }
  return { enabled: true };
}
