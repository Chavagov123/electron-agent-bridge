import type { AgentBundle } from '../page/page-agent-client.js';
import { FakeCdpTransport } from './fake-cdp-transport.js';

/**
 * A {@link FakeCdpTransport} that behaves like a page with the real agent bundle: `Runtime.evaluate`
 * runs expressions against the test DOM (happy-dom), with the agent installed per execution context
 * only after the client injects it. Element handles and accessibility names are simulated.
 */
export class FakePage extends FakeCdpTransport {
  readonly installedIn = new Set<number>();
  /** Contexts that report "Cannot find context" (destroyed by a navigation). */
  readonly deadContexts = new Set<number>();
  /** Accessible names Chromium would report, by element text content. */
  readonly axNamesByText = new Map<string, string>();
  #nextContext = 100;
  readonly #objects = new Map<string, Element>();

  constructor(readonly bundle: AgentBundle) {
    super();
    this.handle('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'main' } } }));
    this.handle('Page.createIsolatedWorld', () => ({ executionContextId: this.#nextContext++ }));
    this.handle('Runtime.evaluate', (params) => this.#evaluate(params as EvaluateParams));
    this.handle('Accessibility.getPartialAXTree', (params) => this.#axTree(params as { objectId: string }));
  }

  /** Announce an agent-world context, as Chromium does after `Runtime.enable` / on new documents. */
  announceContext(id: number, frameId = 'main'): void {
    this.emit({
      method: 'Runtime.executionContextCreated',
      params: { context: { id, name: '__eab', auxData: { frameId } } },
    });
  }

  #evaluate({ expression, contextId, returnByValue }: EvaluateParams): unknown {
    if (this.deadContexts.has(contextId)) throw new Error('Cannot find context with specified id');
    if (expression === this.bundle.source) {
      this.installedIn.add(contextId);
      // Install for real (idempotent): the generated bundle defines globalThis.__eab.
      (0, eval)(expression);
      return { result: {} };
    }
    if (!this.installedIn.has(contextId) && expression.startsWith('globalThis.__eab ')) {
      // Not installed in this context yet: the client's guard answers "missing".
      return { result: { value: expression.endsWith(": '__eabMissing'") ? '__eabMissing' : null } };
    }
    const value: unknown = (0, eval)(expression);
    if (returnByValue === true)
      return { result: { value: JSON.parse(JSON.stringify(value ?? null)) as unknown } };
    if (!(value instanceof Element)) return { result: {} };
    const objectId = `obj-${this.#objects.size + 1}`;
    this.#objects.set(objectId, value);
    return { result: { objectId } };
  }

  #axTree({ objectId }: { objectId: string }): unknown {
    const text = this.#objects.get(objectId)?.textContent.trim() ?? '';
    const name = this.axNamesByText.get(text);
    return { nodes: [{ ignored: false, ...(name === undefined ? {} : { name: { value: name } }) }] };
  }
}

interface EvaluateParams {
  readonly expression: string;
  readonly contextId: number;
  readonly returnByValue?: boolean;
}
