import { STATE_HOOK_BUNDLE } from '../generated/state-hook-source.js';
import type { StateHookConfig } from './entry.js';

/** The main-world hook as one script for `Page.addScriptToEvaluateOnNewDocument`, configured. */
export function stateHookSource(config: StateHookConfig = {}): string {
  return `(function(){${STATE_HOOK_BUNDLE}\neabStateHook.install(${JSON.stringify(config)});})();`;
}
