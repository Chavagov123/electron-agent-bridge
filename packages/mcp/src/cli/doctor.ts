import { existsSync } from 'node:fs';

import {
  STRATEGY_FUSES,
  asarOf,
  blockedStrategies,
  defaultEndpointDirectory,
  readFuses,
  type LaunchStrategy,
} from '@eab/client';

import { renderError } from '../render/text.js';
import type { ClientApi } from '../session/session-manager.js';
import type { CliIo } from './io.js';

/**
 * `eab doctor`: where the bridge looks for apps, and whether each running app answers (connects as an
 * observer, so it never takes control from a running agent). Exit 1 when an app cannot be reached.
 */
export async function doctor(api: ClientApi, io: CliIo): Promise<number> {
  const lines = [`Endpoint directory: ${defaultEndpointDirectory()}`];
  const instances = api.listInstances();
  if (instances.length === 0) {
    lines.push(
      'No bridge-enabled apps are running. Start the app with EAB_ENABLE=1 (and the bridge installed).',
    );
    io.stdout(lines.join('\n'));
    return 0;
  }
  let failures = 0;
  for (const { handshake, handshakePath } of instances) {
    const label = `pid ${handshake.pid} ${handshake.app.name} ${handshake.app.version} (Electron ${handshake.electron})`;
    try {
      const client = await api.connect({ handshakePath, role: 'observer' });
      const { protocolVersion, capabilities } = client.session;
      client.close();
      lines.push(`OK   ${label}: protocol ${protocolVersion}, capabilities ${capabilities.join(', ')}`);
    } catch (error) {
      failures++;
      lines.push(`FAIL ${label}: ${renderError(error).replace(/\n/g, '\n     ')}`);
    }
  }
  io.stdout(lines.join('\n'));
  return failures === 0 ? 0 : 1;
}

/**
 * `eab doctor <executable>`: what Launch mode will meet in this app before starting it — the fuses
 * written in the binary, whether the app is packaged as asar, and which launch strategies can work.
 * Exit 1 when no strategy can (Integrated mode is then the way in).
 */
export async function doctorExecutable(executable: string, io: CliIo): Promise<number> {
  if (!existsSync(executable)) {
    io.stderr(`No such file: ${executable}`);
    return 2;
  }
  const report = await readFuses(executable);
  const lines = [`Executable: ${executable}`];
  if (report === undefined) {
    lines.push('Fuses: none found (not an Electron binary, Electron older than 12, or unreadable).');
  } else {
    lines.push(`Fuses (wire v${report.wireVersion}, read from ${report.file}):`);
    for (const [name, state] of Object.entries(report.fuses)) lines.push(`  ${name}: ${state}`);
  }
  const asar = asarOf(executable);
  lines.push(
    existsSync(asar) ? `App code: packaged (${asar})` : 'App code: not packaged as app.asar next to it',
  );
  const blocked = new Set(blockedStrategies(report));
  const strategies = Object.keys(STRATEGY_FUSES) as LaunchStrategy[];
  lines.push('Launch mode:');
  for (const strategy of strategies) {
    lines.push(
      blocked.has(strategy)
        ? `  ${strategy}: blocked (${STRATEGY_FUSES[strategy]} is off)`
        : `  ${strategy}: possible${report === undefined ? ' (fuses unknown)' : ''}`,
    );
  }
  const none = strategies.every((strategy) => blocked.has(strategy));
  if (none) {
    lines.push(
      "Neither strategy can work: use Integrated mode (import '@eab/electron/register' first in main, start with EAB_ENABLE=1).",
    );
  }
  lines.push(
    'Note: --remote-debugging-port is not controlled by a fuse; attaching to renderers that way gives full control of them (treat it as eval).',
  );
  io.stdout(lines.join('\n'));
  return none ? 1 : 0;
}
