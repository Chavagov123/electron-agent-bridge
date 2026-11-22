import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError } from '@eab/core';

import type { BridgeClient } from '../api/bridge-client.js';
import type { Flow, FlowStep } from './flow-schema.js';
import { runStep, type FlowCursors, type StepContext } from './flow-steps.js';

/** Step timeout when neither the step nor the flow sets one. */
export const DEFAULT_STEP_TIMEOUT_MS = 10_000;

export interface StepOutcome {
  readonly index: number;
  /** The step's `name`, or a description of it. */
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string };
  /** Files written for this step (screenshots, failure snapshots, logs). */
  readonly artifacts: readonly string[];
}

export interface FlowResult {
  readonly name: string;
  readonly file?: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly steps: readonly StepOutcome[];
  /** Why the flow could not run at all (invalid file, app unreachable); it then has no steps. */
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string };
}

export interface RunFlowOptions {
  readonly client: BridgeClient;
  /** Where screenshots and failure artifacts go; without it, failures record no files. */
  readonly artifactsDir?: string;
  /** This flow's folder in `artifactsDir`; default: from its name (callers running several keep them unique). */
  readonly artifactsName?: string;
  readonly file?: string;
  readonly onStep?: (outcome: StepOutcome) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a flow against a connected app: steps in order, each with its own timeout; the first failure
 * (unless the step says `continueOnError`) skips the rest. A failed step leaves a snapshot, a
 * screenshot and the recent warnings and errors in the artifacts directory.
 */
export async function runFlow(flow: Flow, options: RunFlowOptions): Promise<FlowResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const directory =
    options.artifactsDir === undefined
      ? undefined
      : join(options.artifactsDir, options.artifactsName ?? flowSlug(flow.name));
  const cursors = await startCursors(options.client, flow);
  const steps: StepOutcome[] = [];
  let stopped = false;
  for (const [index, step] of flow.steps.entries()) {
    const name = step.name ?? describeStep(step);
    if (stopped) {
      steps.push(record(options, { index, name, status: 'skipped', durationMs: 0, artifacts: [] }));
      continue;
    }
    const context: StepContext = {
      client: options.client,
      target: step.target ?? flow.target,
      timeoutMs: step.timeoutMs ?? flow.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      cursors,
      sleep,
      now,
      saveScreenshot: (image, file) => saveImage(directory ?? '.', file ?? `step-${index + 1}.png`, image),
    };
    const begun = now();
    try {
      const artifacts = await runStep(step, context);
      steps.push(record(options, { index, name, status: 'passed', durationMs: now() - begun, artifacts }));
    } catch (caught) {
      const artifacts =
        directory === undefined ? [] : await failureArtifacts(options.client, context, directory, index);
      const failed = { index, name, status: 'failed' as const, durationMs: now() - begun, artifacts };
      steps.push(record(options, { ...failed, error: errorOf(caught) }));
      if (step.continueOnError !== true) stopped = true;
    }
  }
  return {
    name: flow.name,
    ...(options.file === undefined ? {} : { file: options.file }),
    // A `continueOnError` failure lets the flow go on, but it still fails the flow (a soft assertion).
    passed: steps.every((step) => step.status === 'passed'),
    durationMs: now() - started,
    steps,
  };
}

function errorOf(caught: unknown): NonNullable<StepOutcome['error']> {
  const error = BridgeError.from(caught);
  return {
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

function record(options: RunFlowOptions, outcome: StepOutcome): StepOutcome {
  options.onStep?.(outcome);
  return outcome;
}

/**
 * Cursors at the end of the IPC and log rings ("since the flow started"; failure logs use the log
 * cursor too). The IPC ring is read only when the flow checks IPC.
 */
async function startCursors(client: BridgeClient, flow: Flow): Promise<FlowCursors> {
  const checksIpc = flow.steps.some((step) => 'expect' in step && 'ipc' in step.expect);
  const [ipc, logs] = await Promise.all([
    checksIpc ? endOf((since) => client.call('ipc.query', { since, limit: 500 })) : Promise.resolve(0),
    endOf((since) => client.call('logs.query', { since, limit: 500 })).catch(() => 0),
  ]);
  return { ipc, logs };
}

async function endOf(
  read: (since: number) => Promise<{ data: { nextSeq: number; more: boolean } }>,
): Promise<number> {
  let cursor = 0;
  for (;;) {
    const { data } = await read(cursor);
    cursor = data.nextSeq;
    if (!data.more) return cursor;
  }
}

/** Best effort: whatever can be captured is, a failure to capture never hides the step's own error. */
async function failureArtifacts(
  client: BridgeClient,
  context: StepContext,
  directory: string,
  index: number,
): Promise<string[]> {
  const target = context.target === undefined ? {} : { target: context.target };
  const stem = `step-${index + 1}-failed`;
  const files: string[] = [];
  const attempts: (() => Promise<void>)[] = [
    async () => {
      const { data } = await client.call('snapshot.take', target);
      files.push(save(directory, `${stem}.snapshot.txt`, `${data.title} — ${data.url}\n\n${data.text}\n`));
    },
    async () => {
      const { data } = await client.call('screenshot.take', target);
      const saved = saveImage(directory, `${stem}.png`, data);
      if (saved !== undefined) files.push(saved);
    },
    async () => {
      const { data } = await client.call('logs.query', {
        minLevel: 'warn',
        since: context.cursors.logs,
        limit: 100,
      });
      const lines = data.items.map((entry) => `${entry.level} ${entry.source}: ${entry.text}`);
      files.push(save(directory, `${stem}.logs.txt`, `${lines.join('\n')}\n`));
    },
  ];
  for (const attempt of attempts) await attempt().catch(() => undefined);
  return files;
}

function save(directory: string, file: string, content: string | Buffer): string {
  const path = join(directory, safeFileName(file));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** An inline image, or a copy of the file the runtime spilled a large one to. */
function saveImage(
  directory: string,
  file: string,
  image: { readonly base64?: string | undefined; readonly path?: string | undefined },
): string | undefined {
  if (image.base64 !== undefined) return save(directory, file, Buffer.from(image.base64, 'base64'));
  if (image.path === undefined) return undefined;
  const path = join(directory, safeFileName(file));
  mkdirSync(directory, { recursive: true });
  copyFileSync(image.path, path);
  return path;
}

/** A step-supplied file name that stays a plain file inside the directory on every OS. */
export function safeFileName(file: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
  const cleaned = file.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return cleaned === '' ? 'file' : cleaned;
}

export function describeStep(step: FlowStep): string {
  if ('act' in step) {
    const actions = Array.isArray(step.act) ? step.act : [step.act];
    return actions.map((action) => action.type).join(', ');
  }
  if ('wait' in step) return `wait for ${step.wait.kind}`;
  if ('expect' in step) return `expect ${Object.keys(step.expect)[0] ?? ''}`;
  if ('stub' in step) return `stub ${step.stub.method}`;
  if ('menu' in step) return `menu ${Array.isArray(step.menu) ? step.menu.join(' › ') : step.menu.id}`;
  if ('window' in step) return `window ${step.window.action}`;
  if ('reset' in step) return 'reset';
  return 'screenshot';
}

/** A folder name for a flow: letters and digits of any script, the rest as dashes. */
export function flowSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'flow'
  );
}
