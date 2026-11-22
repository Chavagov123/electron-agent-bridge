import { writeFileSync } from 'node:fs';

import { flowFromRecording, stringifyFlow, type AppInstance, type BridgeClient } from '@eab/client';
import { BridgeError, type RecordedEvent } from '@eab/core';
import { z } from 'zod';

import { untrusted } from '../render/text.js';
import { definedOf } from './defined.js';
import { defineTool } from './tool.js';
import { appKey } from './cursor-key.js';

export const sessionTool = defineTool({
  name: 'session',
  description:
    'Manage the connection to an Electron app. action=list shows running bridge-enabled apps; connect ' +
    'attaches (newest app, or the given pid); launch starts an unmodified app with the bridge injected ' +
    '(executable + args; the app is closed with the session); status; close. recordStart records what ' +
    'users do in the app and what you run with act; recordStop returns it as a flow (YAML for eab run), ' +
    'also written to `out` when given.',
  inputSchema: {
    action: z.enum(['list', 'connect', 'launch', 'attach', 'status', 'close', 'recordStart', 'recordStop']),
    port: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .optional()
      .describe('For attach: the app’s --remote-debugging-port (renderers only; needs --allow-eval).'),
    out: z.string().min(1).optional().describe('For recordStop: also write the flow to this file.'),
    name: z.string().min(1).max(200).optional().describe('For recordStop: the flow name.'),
    pid: z.number().int().positive().optional().describe('App process id for connect; default: newest app.'),
    role: z
      .enum(['controller', 'observer'])
      .optional()
      .describe(
        'For connect: observer only watches; default controller (observer if another client controls).',
      ),
    executable: z
      .string()
      .min(1)
      .optional()
      .describe('For launch: the app executable, or the Electron binary with the app folder in args.'),
    args: z.array(z.string()).max(100).optional().describe('For launch: arguments for the app.'),
    cwd: z.string().optional(),
    strategy: z.enum(['auto', 'node-options', 'inspector']).optional(),
    allowPackaged: z
      .boolean()
      .optional()
      .describe('For launch: allow the bridge in a packaged (production) build.'),
    allowEval: z
      .boolean()
      .optional()
      .describe('For launch: grant eval (needs a server started with --allow-eval).'),
    stateShim: z
      .boolean()
      .optional()
      .describe('For launch: let stores built with Redux DevTools support register for `state`.'),
  },
  async handle(input, { sessions, cursors }) {
    switch (input.action) {
      case 'attach': {
        if (input.port === undefined) throw new BridgeError('INVALID_PARAMS', 'attach needs `port`');
        const client = await sessions.attach({ port: input.port });
        return `Attached to renderers on port ${input.port} (no IPC, main logs or main control).\n${describeClient(client)}`;
      }
      case 'recordStart':
        return startRecording(await sessions.current(), cursors);
      case 'recordStop':
        return stopRecording(await sessions.current(), cursors, input);
      case 'list':
        return renderInstances(sessions.list());
      case 'connect': {
        const client = await sessions.connect({
          ...(input.pid === undefined ? {} : { pid: input.pid }),
          ...(input.role === undefined ? {} : { role: input.role }),
        });
        return `Connected.\n${describeClient(client)}`;
      }
      case 'launch': {
        if (input.executable === undefined) {
          throw new BridgeError('INVALID_PARAMS', 'launch needs `executable`', {
            hint: 'e.g. {"action":"launch","executable":"/path/to/electron","args":["/path/to/app"]}',
          });
        }
        const app = await sessions.launch({
          executable: input.executable,
          ...definedOf({
            args: input.args,
            cwd: input.cwd,
            strategy: input.strategy,
            allowPackaged: input.allowPackaged,
            allowEval: input.allowEval,
            stateShim: input.stateShim,
            role: input.role,
          }),
        });
        return `Launched pid ${app.pid} (bridge injected via ${app.strategy}).\n${describeClient(app.client)}`;
      }
      case 'status': {
        const client = sessions.status();
        if (!client) return 'Not connected.';
        const launched = sessions.launchedApp();
        const owned = launched === undefined ? '' : `\nLaunched by this session: pid ${launched.pid}`;
        return `${describeClient(client)}${owned}`;
      }
      case 'close':
        sessions.close();
        return 'Disconnected.';
    }
  },
});

function renderInstances(instances: AppInstance[]): string {
  if (instances.length === 0) return 'No bridge-enabled apps are running (start one with EAB_ENABLE=1).';
  return instances
    .map(({ handshake }) => {
      const started = new Date(handshake.startedAt).toISOString();
      return `pid ${handshake.pid}: ${handshake.app.name} ${handshake.app.version} (Electron ${handshake.electron}, started ${started})`;
    })
    .join('\n');
}

function describeClient(client: BridgeClient): string {
  const { app, capabilities, protocolVersion, role } = client.session;
  const state = client.closed ? 'closed' : 'open';
  const observerNote =
    role === 'observer' ? ' (another client controls the app; actions are not allowed)' : '';
  return [
    `App: ${app.name} ${app.version} (pid ${app.pid}, Electron ${app.electron})`,
    `Role: ${role}${observerNote}`,
    `Capabilities: ${capabilities.join(', ')}`,
    `Protocol: ${protocolVersion}; connection ${state}`,
  ].join('\n');
}

function recordingKey(client: BridgeClient): string {
  return `record:${appKey(client.handshake)}`;
}

async function recordedSince(client: BridgeClient, since: number): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [];
  let cursor = since;
  for (;;) {
    const page = await client.call('record.events', { since: cursor, limit: 500 });
    events.push(...page.data.items);
    cursor = page.data.nextSeq;
    if (!page.data.more) return events;
  }
}

async function startRecording(client: BridgeClient, cursors: Map<string, string>): Promise<string> {
  const started = await client.call('record.start', {});
  cursors.set(recordingKey(client), String(started.data.nextSeq - 1));
  return 'Recording. Use the app (or act); then call session with action recordStop.';
}

async function stopRecording(
  client: BridgeClient,
  cursors: Map<string, string>,
  input: { readonly out?: string | undefined; readonly name?: string | undefined },
): Promise<string> {
  const key = recordingKey(client);
  await client.call('record.stop', {});
  const events = await recordedSince(client, Number(cursors.get(key) ?? '0'));
  cursors.delete(key);
  const { flow, secrets, notes } = flowFromRecording(events, { name: input.name ?? 'Recorded flow' });
  const yaml = stringifyFlow(flow);
  if (input.out !== undefined) writeFileSync(input.out, yaml);
  const extra = [
    ...(secrets.length > 0 ? [`Password fields read ${secrets.join(', ')} from the environment.`] : []),
    ...notes.map((note) => `Note: ${note}.`),
    ...(input.out === undefined ? [] : [`Written to ${input.out}.`]),
  ];
  return [`Recorded ${events.length} action(s).`, ...extra, untrusted(yaml)].join(String.fromCharCode(10));
}
