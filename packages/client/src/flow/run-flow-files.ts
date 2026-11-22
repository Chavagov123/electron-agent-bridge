import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError } from '@eab/core';

import type { BridgeClient } from '../api/bridge-client.js';
import type { ConnectOptions } from '../api/connect.js';
import type { LaunchOptions, LaunchedApp } from '../launch/launch.js';
import { parseFlow } from './flow-codec.js';
import { flowSlug, runFlow, type FlowResult, type StepOutcome } from './flow-runner.js';
import type { Flow } from './flow-schema.js';

/** In directories, flows are the `*.flow.yaml`, `*.flow.yml` and `*.flow.json` files. */
const FLOW_FILE = /\.flow\.(?:ya?ml|json)$/i;

/** How flows reach apps (the client's own `connect` / `launch`, or fakes in tests). */
export interface FlowApi {
  connect(options: ConnectOptions): Promise<BridgeClient>;
  launch(options: LaunchOptions): Promise<LaunchedApp>;
}

export interface RunFlowFilesOptions {
  readonly api: FlowApi;
  /** Overrides the flows' own `app` with a connection to this running app. */
  readonly pid?: number;
  readonly artifactsDir?: string;
  /** For `${env.NAME}` in flows. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onFlow?: (file: string, flow: Flow | undefined) => void;
  readonly onStep?: (outcome: StepOutcome) => void;
  /** After each flow, with its result (also for files that could not run). */
  readonly onFlowResult?: (result: FlowResult) => void;
}

/** Flow files named by `paths`: files as given; in directories (recursively) `*.flow.*` files, sorted. */
export function findFlowFiles(paths: readonly string[]): string[] {
  return paths.flatMap((path) => (statSync(path).isDirectory() ? flowsIn(path) : [path]));
}

function flowsIn(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : flowsIn(path);
    return entry.isFile() && FLOW_FILE.test(entry.name) ? [path] : [];
  });
}

/**
 * Run flow files one after another, each against its own connection (or app it launches, closed
 * afterwards). A file that does not parse, or an app that cannot be reached, is a failed flow with
 * the reason; the remaining files still run.
 */
export async function runFlowFiles(
  files: readonly string[],
  options: RunFlowFilesOptions,
): Promise<FlowResult[]> {
  const results: FlowResult[] = [];
  const folders = new Set<string>();
  const finish = (result: FlowResult): void => {
    results.push(result);
    options.onFlowResult?.(result);
  };
  for (const file of files) {
    let flow: Flow;
    try {
      flow = parseFlow(readFileSync(file, 'utf8'), { file, env: options.env ?? process.env });
    } catch (error) {
      options.onFlow?.(file, undefined);
      finish(failedFlow(file, file, error));
      continue;
    }
    options.onFlow?.(file, flow);
    finish(await runOne(file, flow, options, uniqueFolder(flowSlug(flow.name), folders)));
  }
  return results;
}

/** Flows with the same (or similar) names get their own artifact folders: `login`, `login-2`, … */
function uniqueFolder(base: string, taken: Set<string>): string {
  let name = base;
  for (let count = 2; taken.has(name); count++) name = `${base}-${count}`;
  taken.add(name);
  return name;
}

async function runOne(
  file: string,
  flow: Flow,
  options: RunFlowFilesOptions,
  artifactsName: string,
): Promise<FlowResult> {
  let session: { client: BridgeClient; close: () => Promise<void> };
  try {
    session = await open(flow, options);
  } catch (error) {
    return failedFlow(flow.name, file, error);
  }
  try {
    return await runFlow(flow, {
      client: session.client,
      file,
      artifactsName,
      ...(options.artifactsDir === undefined ? {} : { artifactsDir: options.artifactsDir }),
      ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    });
  } catch (error) {
    return failedFlow(flow.name, file, error);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function open(
  flow: Flow,
  options: RunFlowFilesOptions,
): Promise<{ client: BridgeClient; close: () => Promise<void> }> {
  const app = flow.app;
  if (options.pid === undefined && app !== undefined && 'launch' in app) {
    const { args, cwd, env, strategy, allowPackaged, allowEval, timeoutMs } = app.launch;
    const launched = await options.api.launch({
      executable: app.launch.executable,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(strategy === undefined ? {} : { strategy }),
      ...(allowPackaged === undefined ? {} : { allowPackaged }),
      ...(allowEval === undefined ? {} : { allowEval }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { client: launched.client, close: () => launched.close() };
  }
  const pid = options.pid ?? (app !== undefined && 'connect' in app ? app.connect.pid : undefined);
  const client = await options.api.connect(pid === undefined ? {} : { pid });
  return {
    client,
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

function failedFlow(name: string, file: string, error: unknown): FlowResult {
  const failure = BridgeError.from(error);
  return {
    name,
    file,
    passed: false,
    durationMs: 0,
    steps: [],
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.hint === undefined ? {} : { hint: failure.hint }),
    },
  };
}
