import { BridgeError, ERROR_CODES, type ErrorCode, type WaitCondition } from '@electron-agent-bridge/core';

import type { BridgeClient } from '../api/bridge-client.js';
import type { Expectation, FlowStep } from './flow-schema.js';

/** Where the flow started reading IPC and logs: checks "since the flow started" count from here. */
export interface FlowCursors {
  ipc: number;
  logs: number;
}

export interface StepContext {
  readonly client: BridgeClient;
  readonly target: string | undefined;
  readonly timeoutMs: number;
  readonly cursors: FlowCursors;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Save a screenshot (inline, or a file the runtime spilled) into the artifacts; returns its path. */
  readonly saveScreenshot: (
    image: { readonly base64?: string | undefined; readonly path?: string | undefined },
    file: string | undefined,
  ) => string | undefined;
}

const POLL_MS = 100;
/** RPC deadline beyond the step's own timeout (the runtime reports its own TIMEOUT first). */
const RPC_MARGIN_MS = 5_000;

type Handler<K extends string> = (
  step: Extract<FlowStep, Record<K, unknown>>,
  context: StepContext,
) => Promise<string[]>;

const none = (): string[] => [];

/** One handler per step kind; each resolves with the files it wrote. */
const HANDLERS: { [K in StepKindKey]: Handler<K> } = {
  act: async (step, context) => {
    const actions = Array.isArray(step.act) ? step.act : [step.act];
    const { data } = await context.client.call(
      'action.run',
      { ...targetOf(context), actions, timeoutMs: context.timeoutMs, delta: false },
      // The timeout applies to each action (plus up to 500 ms settling each).
      { timeoutMs: actions.length * (context.timeoutMs + 500) + RPC_MARGIN_MS },
    );
    const failed = data.steps.find((result) => !result.ok);
    if (failed?.error) {
      const { code, message, hint } = failed.error;
      throw new BridgeError(asCode(code), `${failed.type}: ${message}`, hint === undefined ? {} : { hint });
    }
    return none();
  },
  wait: (step, context) => wait(context, step.wait).then(none),
  expect: (step, context) => expectThat(context, step.expect).then(none),
  stub: (step, context) => context.client.call('dialog.stub', { ...step.stub }, rpcOf(context)).then(none),
  menu: async (step, context) => {
    const item = Array.isArray(step.menu) ? { path: step.menu } : { id: step.menu.id };
    // Apps often build their menu after the window opens: a missing item is retried until the timeout.
    const deadline = context.now() + context.timeoutMs;
    for (;;) {
      try {
        await context.client.call('menu.click', item, rpcOf(context));
        return none();
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'NOT_FOUND' || context.now() >= deadline)
          throw error;
        await context.sleep(POLL_MS);
      }
    }
  },
  window: async (step, context) => {
    const { action, bounds } = step.window;
    const window = step.window.id ?? (await windowOf(context));
    await context.client.call(
      'window.control',
      { window, action, ...(bounds === undefined ? {} : { bounds }) },
      rpcOf(context),
    );
    return none();
  },
  reset: (_step, context) => context.client.call('session.reset', {}, rpcOf(context)).then(none),
  screenshot: async (step, context) => {
    const shot = await context.client.call('screenshot.take', targetOf(context), rpcOf(context));
    const saved = context.saveScreenshot(shot.data, step.screenshot.file);
    return saved === undefined ? [] : [saved];
  },
};

type StepKindKey = 'act' | 'wait' | 'expect' | 'stub' | 'menu' | 'window' | 'reset' | 'screenshot';

/** Run one step; resolves with artifact paths it produced, rejects with a BridgeError on failure. */
export function runStep(step: FlowStep, context: StepContext): Promise<string[]> {
  const kind = (Object.keys(HANDLERS) as StepKindKey[]).find((key) => key in step);
  if (kind === undefined) return Promise.reject(new BridgeError('INVALID_PARAMS', 'unknown step'));
  return (HANDLERS[kind] as Handler<StepKindKey>)(step as never, context);
}

/** The step's timeout for one RPC (the runtime reports its own errors first). */
function rpcOf(context: StepContext): { timeoutMs: number } {
  return { timeoutMs: context.timeoutMs + RPC_MARGIN_MS };
}

function targetOf(context: StepContext): { target?: string } {
  return context.target === undefined ? {} : { target: context.target };
}

function wait(context: StepContext, condition: WaitCondition): Promise<unknown> {
  const target = context.target === undefined ? {} : { target: context.target };
  return context.client.call(
    'wait.for',
    { ...target, condition, timeoutMs: context.timeoutMs },
    { timeoutMs: context.timeoutMs + RPC_MARGIN_MS },
  );
}

/** Every expectation waits up to the step timeout; only "no console errors" is checked at once. */
async function expectThat(context: StepContext, expectation: Expectation): Promise<void> {
  if ('element' in expectation) {
    await wait(context, {
      kind: 'element',
      locator: expectation.element,
      ...(expectation.state ? { state: expectation.state } : {}),
    });
  } else if ('text' in expectation) {
    await wait(context, {
      kind: 'text',
      text: expectation.text,
      ...(expectation.present === undefined ? {} : { present: expectation.present }),
    });
  } else if ('url' in expectation) {
    await wait(context, { kind: 'url', contains: expectation.url.contains });
  } else if ('state' in expectation) {
    await wait(context, { kind: 'state', ...expectation.state });
  } else if ('ipc' in expectation) {
    await expectIpc(context, expectation.ipc.channel, expectation.ipc.min ?? 1);
  } else {
    await expectNoConsoleErrors(context);
  }
}

async function expectIpc(context: StepContext, channel: string, min: number): Promise<void> {
  const deadline = context.now() + context.timeoutMs;
  let cursor = context.cursors.ipc;
  let seen = 0;
  for (;;) {
    const page = await context.client.call('ipc.query', { channel, since: cursor, limit: 500 });
    seen += page.data.items.length;
    cursor = page.data.nextSeq;
    if (seen >= min) return;
    if (page.data.more) continue;
    if (context.now() >= deadline) {
      throw new BridgeError(
        'TIMEOUT',
        `expected ${min} IPC message(s) on ${channel} since the flow started, saw ${seen}`,
        {
          hint: 'Check the channel name with the ipc tool (its catalogue lists every channel seen).',
        },
      );
    }
    await context.sleep(POLL_MS);
  }
}

async function expectNoConsoleErrors(context: StepContext): Promise<void> {
  const page = await context.client.call('logs.query', {
    source: 'renderer',
    minLevel: 'error',
    since: context.cursors.logs,
    limit: 5,
  });
  const [first] = page.data.items;
  if (first) {
    const more = page.data.items.length > 1 || page.data.more ? ' (and more)' : '';
    throw new BridgeError(
      'INTERNAL',
      `console error since the flow started: ${first.text.split('\n')[0] ?? ''}${more}`,
      {
        hint: 'See the logs tool for all of them.',
      },
    );
  }
}

/** The window showing the step's page (or the focused / first window). */
async function windowOf(context: StepContext): Promise<number> {
  const [{ data: info }, { data: targets }] = await Promise.all([
    context.client.call('app.info', {}),
    context.client.call('targets.list', {}),
  ]);
  const page = targets.targets.find(
    (target) => target.id === context.target || target.name === context.target,
  );
  const window =
    info.windows.find((entry) => page !== undefined && entry.target === page.id) ??
    info.windows.find((entry) => entry.focused) ??
    info.windows[0];
  if (!window) throw new BridgeError('NOT_FOUND', 'the app has no windows');
  return window.id;
}

function asCode(code: string): ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'INTERNAL';
}
