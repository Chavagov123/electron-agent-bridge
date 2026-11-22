import { BridgeError } from '@electron-agent-bridge/core';
import type { LaunchOptions } from '@electron-agent-bridge/client';

import { renderError } from '../render/text.js';
import type { ClientApi } from '../session/session-manager.js';
import type { CliIo } from './io.js';

const STRATEGIES = new Set(['auto', 'node-options', 'inspector']);

/**
 * `eab launch <executable> [--allow-packaged] [--strategy auto|node-options|inspector] [--timeoutMs N]
 * [-- app args…]`: start an unmodified app with the bridge injected and leave it running.
 */
export async function launchCommand(argv: readonly string[], api: ClientApi, io: CliIo): Promise<number> {
  let options: LaunchOptions;
  try {
    options = parseLaunch(argv);
  } catch (error) {
    io.stderr(renderError(error));
    return 2;
  }
  try {
    const app = await api.launch(options);
    const { pid, strategy } = app;
    app.detach();
    io.stdout(
      `Launched pid ${pid} (bridge injected via ${strategy}); the app keeps running.\n` +
        `Use it with e.g. \`eab snapshot --pid ${pid}\`; its output is in ${app.logPath}.`,
    );
    return 0;
  } catch (error) {
    io.stderr(renderError(error));
    return 1;
  }
}

interface Flags {
  allowPackaged: boolean;
  allowEval: boolean;
  stateShim: boolean;
  strategy?: NonNullable<LaunchOptions['strategy']>;
  timeoutMs?: number;
}

/** Flags taking a value: each stores it and says whether it was valid. */
const VALUE_FLAGS: Record<string, (value: string, flags: Flags) => boolean> = {
  '--strategy': (value, flags) => {
    if (!STRATEGIES.has(value)) return false;
    flags.strategy = value as NonNullable<LaunchOptions['strategy']>;
    return true;
  },
  '--timeoutMs': (value, flags) => {
    if (!/^[1-9]\d*$/.test(value)) return false;
    flags.timeoutMs = Number(value);
    return true;
  },
};

function parseLaunch(argv: readonly string[]): LaunchOptions {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const appArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const flags: Flags = { allowPackaged: false, allowEval: false, stateShim: false };
  let executable: string | undefined;
  for (let index = 0; index < own.length; index++) {
    const token = own[index] ?? '';
    const readValue = VALUE_FLAGS[token];
    if (token === '--allow-packaged') flags.allowPackaged = true;
    else if (token === '--allow-eval') flags.allowEval = true;
    else if (token === '--state-shim') flags.stateShim = true;
    else if (readValue?.(own[index + 1] ?? '', flags)) index++;
    else if (!token.startsWith('-') && executable === undefined) executable = token;
    else throw usageError(`unexpected or invalid argument ${JSON.stringify(token)}`);
  }
  if (executable === undefined) throw usageError('launch needs the app executable');
  return { executable, args: appArgs, ...flags };
}

function usageError(message: string): BridgeError {
  return new BridgeError('INVALID_PARAMS', message, {
    hint:
      'eab launch <executable> [--allow-packaged] [--allow-eval] [--state-shim] [--strategy auto|node-options|inspector] [--timeoutMs N] ' +
      '[-- app args…], e.g. eab launch ./node_modules/.bin/electron -- ./my-app',
  });
}
