import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  flowFromRecording,
  parseFlow,
  stringifyFlow,
  toPlaywright,
  type BridgeClient,
} from '@electron-agent-bridge/client';
import { BridgeError, type RecordedEvent } from '@electron-agent-bridge/core';

import { renderError } from '../render/text.js';
import type { ClientApi } from '../session/session-manager.js';
import type { CliIo } from './io.js';

/** How often recorded actions are collected while recording. */
const POLL_MS = 250;

const RECORD_USAGE =
  'eab record --out <flow.yaml> [--name NAME] [--pid N] [--duration ms]\n' +
  'Records what you do in the app (clicks, field values, command keys) and what agents run, until you ' +
  'press Enter or Ctrl+C (or for --duration), then writes it as a flow for eab run.';
const EXPORT_USAGE =
  'eab export <flow.yaml> --playwright [--out file.spec.ts]\n' +
  'Writes the flow as a Playwright test for Electron (bridge-only checks become comments).';

interface RecordFlags {
  out?: string;
  name?: string;
  pid?: number;
  duration?: number;
}

/** `eab record`: record a session into a flow file. */
export async function recordCommand(argv: readonly string[], api: ClientApi, io: CliIo): Promise<number> {
  let flags: RecordFlags;
  try {
    flags = parseFlags(argv, ['--out', '--name', '--pid', '--duration']);
    if (flags.out === undefined)
      throw new BridgeError('INVALID_PARAMS', '--out names the flow file to write');
  } catch (error) {
    io.stderr(`${renderError(error)}\n\n${RECORD_USAGE}`);
    return 2;
  }
  let client: BridgeClient | undefined;
  try {
    client = await api.connect({ role: 'observer', ...(flags.pid === undefined ? {} : { pid: flags.pid }) });
    const events = await record(client, io, flags.duration);
    const name = flags.name ?? basename(flags.out, '.flow.yaml').replace(/\.ya?ml$/, '');
    const { flow, secrets, notes } = flowFromRecording(events, { name });
    io.writeFile(flags.out, Buffer.from(stringifyFlow(flow)));
    io.stdout(`Recorded ${events.length} action(s) into ${flags.out}.`);
    if (secrets.length > 0) io.stdout(`Password fields read ${secrets.join(', ')} from the environment.`);
    for (const note of notes) io.stdout(`Note: ${note}.`);
    return 0;
  } catch (error) {
    io.stderr(renderError(error));
    return 1;
  } finally {
    client?.close();
  }
}

async function record(
  client: BridgeClient,
  io: CliIo,
  duration: number | undefined,
): Promise<RecordedEvent[]> {
  const started = await client.call('record.start', {});
  io.stdout(
    duration === undefined ? 'Recording… press Enter or Ctrl+C to stop.' : `Recording for ${duration} ms…`,
  );
  const events: RecordedEvent[] = [];
  let since = started.data.nextSeq - 1;
  const drain = async (): Promise<void> => {
    for (;;) {
      const page = await client.call('record.events', { since, limit: 500 });
      events.push(...page.data.items);
      since = page.data.nextSeq;
      if (page.data.dropped > 0)
        io.stderr(`${page.data.dropped} recorded action(s) were lost (recording too fast).`);
      if (!page.data.more) return;
    }
  };
  const state = { stopped: false };
  const stop = (duration === undefined ? (io.untilStopped?.() ?? Promise.resolve()) : sleep(duration)).then(
    () => {
      state.stopped = true;
    },
  );
  while (!state.stopped) {
    await Promise.race([stop, sleep(POLL_MS)]);
    await drain();
  }
  await client.call('record.stop', {});
  await drain();
  return events;
}

/** `eab export`: a flow as a Playwright test. */
export function exportCommand(argv: readonly string[], io: CliIo): number {
  const [file, ...rest] = argv;
  let out: string | undefined;
  try {
    if (file === undefined || file.startsWith('--'))
      throw new BridgeError('INVALID_PARAMS', 'name the flow file');
    if (!rest.includes('--playwright'))
      throw new BridgeError('INVALID_PARAMS', '--playwright is the export format');
    out = parseFlags(
      rest.filter((token) => token !== '--playwright'),
      ['--out'],
    ).out;
  } catch (error) {
    io.stderr(`${renderError(error)}\n\n${EXPORT_USAGE}`);
    return 2;
  }
  try {
    const flow = parseFlow(readFileSync(file, 'utf8'), {
      file,
      env: new Proxy({}, { get: (_target, key) => `\${env.${String(key)}}` }),
    });
    const { code, warnings } = toPlaywright(flow);
    for (const warning of warnings) io.stderr(`Warning: ${warning}`);
    if (out === undefined) io.stdout(code);
    else {
      io.writeFile(out, Buffer.from(code));
      io.stdout(`Wrote ${out}${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}.`);
    }
    return 0;
  } catch (error) {
    io.stderr(renderError(error));
    return 1;
  }
}

function parseFlags(argv: readonly string[], allowed: readonly string[]): RecordFlags {
  const flags: RecordFlags = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? '';
    const value = argv[index + 1];
    if (!allowed.includes(token)) throw new BridgeError('INVALID_PARAMS', `unknown option ${token}`);
    if (value === undefined || value.startsWith('--'))
      throw new BridgeError('INVALID_PARAMS', `${token} needs a value`);
    index++;
    if (token === '--out') flags.out = value;
    else if (token === '--name') flags.name = value;
    else if (/^[1-9]\d*$/.test(value)) {
      if (token === '--pid') flags.pid = Number(value);
      else flags.duration = Number(value);
    } else throw new BridgeError('INVALID_PARAMS', `${token} needs a positive number`);
  }
  return flags;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
