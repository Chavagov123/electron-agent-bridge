import {
  LAUNCH_OPTIONS_ENV,
  LaunchBridgeOptionsSchema,
  type LaunchBridgeOptions,
} from '@electron-agent-bridge/core';

/** How the bridge gets into the app's main process. */
export type LaunchStrategy = 'node-options' | 'inspector';

export interface LaunchEnvironmentInput {
  /** The launcher's own environment (the app needs PATH, HOME, DISPLAY…). */
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** Caller-supplied variables; win over the parent's. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly strategy: LaunchStrategy;
  /** Absolute path of `@electron-agent-bridge/electron/inject`. */
  readonly injectPath: string;
  /** File the inject reports its progress to. */
  readonly statusPath: string;
  readonly allowPackaged: boolean;
  /** Raise the app's capability ceiling to include `eval` (main-process code execution). */
  readonly allowEval?: boolean;
  /** Turn on the state devtools shim in the app's pages. */
  readonly stateShim?: boolean;
  /** Runtime options passed through `EAB_OPTIONS` (validated by the inject). */
  readonly options?: LaunchBridgeOptions;
}

/**
 * The app's environment: the parent's minus anything bridge-related it may carry (a stale token, a
 * handshake path, another launch's NODE_OPTIONS), plus what this launch needs. The `EAB_DISABLE`
 * kill switch is kept: an operator who set it means it. With `node-options`, our `--require` comes
 * first and the user's own NODE_OPTIONS follow; the inject removes exactly that entry again.
 */
export function launchEnvironment(input: LaunchEnvironmentInput): Record<string, string> {
  const env = withoutBridgeVariables(input);
  env['EAB_ENABLE'] = '1';
  env['EAB_LAUNCH_STATUS'] = input.statusPath;
  if (input.allowPackaged) env['EAB_ALLOW_PACKAGED'] = '1';
  if (input.allowEval === true) env['EAB_ALLOW_EVAL'] = '1';
  if (input.stateShim === true) env['EAB_STATE_SHIM'] = '1';
  if (input.options !== undefined && Object.keys(input.options).length > 0) {
    env[LAUNCH_OPTIONS_ENV] = JSON.stringify(LaunchBridgeOptionsSchema.parse(input.options));
  }
  const userOptions = input.extra?.['NODE_OPTIONS'] ?? input.parent['NODE_OPTIONS'] ?? '';
  const ours = input.strategy === 'node-options' ? requireOption(input.injectPath) : '';
  const nodeOptions = [ours, userOptions.trim()].filter((part) => part !== '').join(' ');
  if (nodeOptions !== '') env['NODE_OPTIONS'] = nodeOptions;
  if (ours !== '') env['EAB_LAUNCH_REQUIRE'] = ours;
  return env;
}

/** Parent and caller variables without bridge leftovers; the caller's own EAB_* and the kill switch stay. */
function withoutBridgeVariables(input: LaunchEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...input.parent, ...input.extra })) {
    if (value !== undefined && !key.startsWith('EAB_') && key !== 'NODE_OPTIONS') env[key] = value;
  }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (key.startsWith('EAB_') && !RESERVED.has(key)) env[key] = value;
  }
  const killSwitch = input.extra?.['EAB_DISABLE'] ?? input.parent['EAB_DISABLE'];
  if (killSwitch !== undefined) env['EAB_DISABLE'] = killSwitch;
  return env;
}

/** Variables the launcher owns; a caller cannot override them through `extra`. */
const RESERVED = new Set([
  'EAB_ENABLE',
  'EAB_LAUNCH_STATUS',
  'EAB_ALLOW_PACKAGED',
  'EAB_ALLOW_EVAL',
  'EAB_STATE_SHIM',
  'EAB_OPTIONS',
  'EAB_TOKEN',
  'EAB_HANDSHAKE',
  'EAB_LAUNCH_REQUIRE',
]);

/**
 * `--require <path>` as Electron's NODE_OPTIONS parser accepts it: forward slashes on every platform
 * (backslashes are dropped on Windows, ADR-0004), quoted when the path has spaces.
 */
export function requireOption(path: string): string {
  const forward = path.replaceAll('\\', '/');
  return /\s/.test(forward) ? `--require "${forward}"` : `--require ${forward}`;
}
