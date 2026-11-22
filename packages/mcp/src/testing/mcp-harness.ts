import type { BridgeClient, LaunchedApp, LaunchOptions } from '@eab/client';
import { PROTOCOL_VERSION, type Handshake } from '@eab/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { SpillSink } from '../output/spill.js';
import { createBridgeMcpServer, type BridgeMcpServerOptions } from '../server.js';
import type { ClientApi } from '../session/session-manager.js';

export const handshake: Handshake = {
  schema: 1,
  protocolVersion: PROTOCOL_VERSION,
  pid: 4242,
  startedAt: 0,
  endpoint: 'pipe',
  token: 't',
  app: { name: 'demo', version: '1.2.3' },
  electron: '45.0.0',
};

/** Every call the fake client received, for asserting what tools send. */
export const calls: { method: string; params: unknown }[] = [];

const DEFAULT_RESPONSES: Record<string, unknown> = {
  'dom.find': {
    data: { matches: [{ ref: 'e2', role: 'button', name: 'Go', line: 'button "Go" [e2]' }], total: 3 },
    limitations: [{ code: 'truncated', message: 'Showing 1 of 3 matches.' }],
    untrusted: true,
  },
  'targets.list': {
    data: {
      targets: [{ id: 'wc1', name: 'main', kind: 'window', title: 'Main', url: 'file:///a', attached: true }],
    },
    limitations: [],
  },
  'snapshot.take': {
    data: {
      target: 'wc1',
      url: 'file:///a',
      title: 'Main',
      kind: 'full',
      cursor: 'c1',
      text: '- button "Go"',
      lineCount: 1,
    },
    limitations: [{ code: 'naive-snapshot', message: 'skeleton' }],
    untrusted: true,
  },
};

/** A connected bridge client answering each method with a canned (or overridden) response. */
export function fakeClient(
  overrides: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
): BridgeClient {
  const responses = { ...DEFAULT_RESPONSES, ...overrides };
  const client = {
    closed: false,
    handshake,
    session: {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's1',
      role: 'controller',
      capabilities: ['observe'],
      app: { name: 'demo', version: '1.2.3', electron: '45.0.0', pid: 4242 },
      ...session,
    },
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(responses[method]);
    },
    close: () => undefined,
  };
  return client as unknown as BridgeClient;
}

/** Launches the fake API was asked for, and how many launched apps were closed or detached. */
export const launches: { options: LaunchOptions; closed: boolean; detached: boolean }[] = [];

/** A launched app answering like {@link fakeClient}. */
export function fakeLaunch(options: LaunchOptions): Promise<LaunchedApp> {
  const record = { options, closed: false, detached: false };
  launches.push(record);
  return Promise.resolve({
    pid: 4242,
    strategy: 'node-options',
    client: fakeClient(),
    logPath: '/tmp/eab-launch/node-options.log',
    outputTail: () => '',
    exited: new Promise(() => undefined),
    close: () => {
      record.closed = true;
      return Promise.resolve();
    },
    detach: () => {
      record.detached = true;
    },
  });
}

export const api: ClientApi = {
  connect: () => Promise.resolve(fakeClient()),
  listInstances: () => [{ handshakePath: '/x/4242.json', handshake }],
  launch: fakeLaunch,
};

/** Spilled output by path, instead of files. */
export const spilledFiles = new Map<string, string>();
const memorySpill: SpillSink = {
  write: (text) => {
    const path = `/spill/${spilledFiles.size + 1}.txt`;
    spilledFiles.set(path, text);
    return path;
  },
};

let mcpClient: Client | undefined;

/** An MCP client wired to a fresh server in memory. Close it with {@link closeClient}. */
export async function connectedClient(
  clientApi: ClientApi = api,
  options: Omit<BridgeMcpServerOptions, 'api'> = {},
): Promise<Client> {
  const { server } = createBridgeMcpServer({ api: clientApi, spill: memorySpill, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  mcpClient = new Client({ name: 'test', version: '0' });
  await mcpClient.connect(clientSide);
  return mcpClient;
}

export async function closeClient(): Promise<void> {
  await mcpClient?.close();
  mcpClient = undefined;
}

/** Calls a tool and joins its text output. */
export async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((part) => part.text).join(''), isError: result.isError === true };
}
