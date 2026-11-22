import { BridgeError, ERROR_CODES, type ErrorCode, type Locator } from '@electron-agent-bridge/core';
import type {
  AgentResult,
  Match,
  SnapshotRequest,
  SnapshotResponse,
} from '@electron-agent-bridge/page-agent';
import { z } from 'zod';

import type { CdpEvent, CdpTransport } from '../ports/cdp-transport.js';

/** Name of the isolated world the agent lives in (page scripts cannot see or tamper with it). */
export const AGENT_WORLD = '__eab';

/** The agent bundle to install (from `@electron-agent-bridge/page-agent`; injectable for tests). */
export interface AgentBundle {
  readonly source: string;
  readonly version: string;
}

const ContextCreated = z.object({
  context: z.object({
    id: z.number(),
    name: z.string(),
    auxData: z.object({ frameId: z.string().optional() }).optional(),
  }),
});
const ContextDestroyed = z.object({ executionContextId: z.number() });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const IsolatedWorld = z.object({ executionContextId: z.number() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }),
  exceptionDetails: z
    .object({ text: z.string(), exception: z.object({ description: z.string().optional() }).optional() })
    .optional(),
});

/** Marker returned when the agent is not (yet) installed in a context. */
const MISSING = '__eabMissing';
/** Context lost (navigation) twice in a row is tolerated; a third time is an error. */
const MAX_ATTEMPTS = 3;
/** Element handles requested concurrently. */
const HANDLE_BATCH = 100;

/**
 * Talks to the page agent of one page (top frame) through CDP:
 * - bootstraps lazily and again after every re-attach (fresh CDP session): posts `Runtime.enable` and
 *   registers the agent for every new document in its isolated world (`runImmediately` covers the
 *   current one);
 * - tracks the agent world's execution context per frame from `Runtime` events;
 * - when the context is missing (navigation in progress, page loaded before the bridge), creates the
 *   world itself and installs the agent; the agent's install is idempotent.
 */
export class PageAgentClient {
  readonly #transport: CdpTransport;
  readonly #bundle: AgentBundle;
  readonly #contexts = new Map<string, number>();
  /** Contexts holding an older agent that could not be replaced: used as they are, never reinstalled. */
  readonly #keptOld = new Set<number>();
  #mainFrame: string | undefined;
  #bootstrapped = false;
  /** Commands already sent once in this CDP session (domains enabled, emulation set). */
  readonly #ensured = new Set<string>();

  constructor(transport: CdpTransport, bundle: AgentBundle) {
    this.#transport = transport;
    this.#bundle = bundle;
    transport.onEvent((event) => {
      this.#onEvent(event);
    });
    transport.onAttach(() => {
      this.#bootstrapped = false;
      this.#ensured.clear();
      this.#mainFrame = undefined;
      this.#contexts.clear();
    });
  }

  snapshot(request: SnapshotRequest): Promise<SnapshotResponse> {
    return this.#callAgent<SnapshotResponse>('snapshot', [request]);
  }

  find(locator: Locator, limit: number): Promise<{ matches: Match[]; total: number }> {
    return this.#callAgent('find', [locator, limit]);
  }

  /** Refs of the page tree (or of `root`'s subtree), in document order. */
  async refs(limit: number, root?: Locator): Promise<string[]> {
    const refs = await this.#callAgent<unknown>('refs', root === undefined ? [limit] : [limit, root]);
    return z.array(z.string()).parse(refs);
  }

  /** Call any page agent operation (sync or async) and unwrap its result. */
  invoke<T>(method: string, args: readonly unknown[]): Promise<T> {
    return this.#callAgent<T>(method, args);
  }

  /**
   * Send a setup command once per CDP session (e.g. `Accessibility.enable`, `Network.enable`): it stays
   * in effect until the session ends, and is sent again after a re-attach. Fire-and-forget.
   * Returns `true` when the command was sent now (the first time on this session).
   */
  ensure(method: string, params?: object): boolean {
    const key = `${method} ${JSON.stringify(params ?? {})}`;
    if (this.#ensured.has(key)) return false;
    this.#ensured.add(key);
    this.#transport.post(method, params);
    return true;
  }

  /** Undo the memory of an {@link ensure} (after the caller reverted the command's effect). */
  forget(method: string, params?: object): void {
    this.#ensured.delete(`${method} ${JSON.stringify(params ?? {})}`);
  }

  /**
   * Install the agent in the page now and in every later document (fire-and-forget), without waiting
   * for a first call: for features that must see the page from its start (recording).
   */
  install(): void {
    this.#bootstrap();
  }

  /** The CDP transport of this page (for input and domain commands). */
  get transport(): CdpTransport {
    return this.#transport;
  }

  /**
   * Run `use` with a remote object handle for each ref's element (for CDP calls that need a node,
   * like `Accessibility.getPartialAXTree`). Handles are fetched in batches and released afterwards.
   */
  async withElements<T>(
    refs: readonly string[],
    use: (objectIds: (string | undefined)[]) => Promise<T>,
  ): Promise<T> {
    const contextId = await this.#contextId();
    const group = `eab-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const ids: (string | undefined)[] = [];
      for (let start = 0; start < refs.length; start += HANDLE_BATCH) {
        const batch = refs.slice(start, start + HANDLE_BATCH);
        ids.push(...(await Promise.all(batch.map((ref) => this.#handle(contextId, group, ref)))));
      }
      return await use(ids);
    } finally {
      this.#transport.post('Runtime.releaseObjectGroup', { objectGroup: group });
    }
  }

  async #handle(contextId: number, group: string, ref: string): Promise<string | undefined> {
    const response = Evaluated.parse(
      await this.#transport.send('Runtime.evaluate', {
        expression: `globalThis.__eab ? globalThis.__eab.element(${JSON.stringify(ref)}) : null`,
        contextId,
        objectGroup: group,
        silent: true,
      }),
    );
    return response.result.objectId;
  }

  async #callAgent<T>(method: string, args: readonly unknown[]): Promise<T> {
    const call = `globalThis.__eab.${method}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
    // An agent of another version (left by an older bridge in a page that kept running) is replaced; one
    // that cannot be (older agents could not be redefined) is used as it is after the install attempt.
    const current = `globalThis.__eab && globalThis.__eab.version === ${JSON.stringify(this.#bundle.version)}`;
    const result = (await this.#evaluate(
      `${current} ? ${call} : '${MISSING}'`,
      `globalThis.__eab ? ${call} : '${MISSING}'`,
    )) as AgentResult<T>;
    if (result.ok) return result.value;
    throw new BridgeError(toErrorCode(result.code), `page agent: ${result.error}`);
  }

  /**
   * Evaluate in the agent world, installing the agent when it is missing and moving to a fresh context
   * when the current one dies (navigation). An install is always followed by another evaluation, of
   * `afterInstall` (by default the same expression).
   */
  async #evaluate(expression: string, afterInstall = expression): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const contextId = await this.#contextId();
      try {
        const first = this.#keptOld.has(contextId) ? afterInstall : expression;
        const value = await this.#evaluateIn(contextId, first);
        if (value !== MISSING) return value;
        await this.#evaluateIn(contextId, this.#bundle.source);
        const retried = await this.#evaluateIn(contextId, expression);
        if (retried !== MISSING) return retried;
        if (afterInstall === expression) continue;
        // Still not ours after the install: an older agent that cannot be replaced. Use it from now on
        // instead of evaluating the bundle again on every call.
        const kept = await this.#evaluateIn(contextId, afterInstall);
        if (kept === MISSING) continue;
        this.#keptOld.add(contextId);
        return kept;
      } catch (error) {
        if (!isContextGone(error)) throw error;
        this.#forgetContext(contextId);
      }
    }
    throw new BridgeError('INTERNAL', 'the page agent could not be installed', {
      hint: 'The page may be navigating continuously; retry once it settles.',
    });
  }

  async #evaluateIn(contextId: number, expression: string): Promise<unknown> {
    const response = Evaluated.parse(
      await this.#transport.send('Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: true,
        // Agent operations may return promises (stability checks, settling).
        awaitPromise: true,
        silent: true,
      }),
    );
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new BridgeError('INTERNAL', `page agent failed: ${detail}`);
    }
    return response.result.value;
  }

  async #contextId(): Promise<number> {
    this.#bootstrap();
    const frameId = await this.#mainFrameId();
    const known = this.#contexts.get(frameId);
    if (known !== undefined) return known;
    // No event yet (or the page predates the bridge): create the world ourselves.
    const created = IsolatedWorld.parse(
      await this.#transport.send('Page.createIsolatedWorld', { frameId, worldName: AGENT_WORLD }),
    );
    this.#contexts.set(frameId, created.executionContextId);
    return created.executionContextId;
  }

  async #mainFrameId(): Promise<string> {
    if (this.#mainFrame !== undefined) return this.#mainFrame;
    const tree = FrameTree.parse(await this.#transport.send('Page.getFrameTree'));
    this.#mainFrame = tree.frameTree.frame.id;
    return this.#mainFrame;
  }

  /** Fire-and-forget (ADR-0002): never await commands that may only resolve after navigation. */
  #bootstrap(): void {
    if (this.#bootstrapped) return;
    this.#bootstrapped = true;
    this.#transport.post('Runtime.enable');
    this.#transport.post('Page.addScriptToEvaluateOnNewDocument', {
      source: this.#bundle.source,
      worldName: AGENT_WORLD,
      runImmediately: true,
    });
  }

  #onEvent(event: CdpEvent): void {
    if (event.sessionId !== undefined) return;
    if (event.method === 'Runtime.executionContextCreated') {
      const parsed = ContextCreated.safeParse(event.params);
      const frameId = parsed.data?.context.auxData?.frameId;
      if (parsed.success && parsed.data.context.name === AGENT_WORLD && frameId !== undefined) {
        this.#contexts.set(frameId, parsed.data.context.id);
      }
    } else if (event.method === 'Runtime.executionContextDestroyed') {
      const parsed = ContextDestroyed.safeParse(event.params);
      if (parsed.success) this.#forgetContext(parsed.data.executionContextId);
    } else if (event.method === 'Runtime.executionContextsCleared') {
      this.#contexts.clear();
    }
  }

  #forgetContext(contextId: number): void {
    this.#keptOld.delete(contextId);
    for (const [frameId, id] of this.#contexts) if (id === contextId) this.#contexts.delete(frameId);
  }
}

function isContextGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context|Inspected target navigated|target closed/i.test(message);
}

const KNOWN_CODES = new Set<string>(ERROR_CODES);

/** Agent codes are bridge error codes, except `UNSTABLE` (still animating), which is a timeout in waiting. */
function toErrorCode(code: string): ErrorCode {
  if (code === 'UNSTABLE') return 'TIMEOUT';
  return KNOWN_CODES.has(code) ? (code as ErrorCode) : 'INTERNAL';
}
