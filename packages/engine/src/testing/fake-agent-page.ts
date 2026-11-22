import { FakeCdpTransport } from './fake-cdp-transport.js';

/** A scripted page agent: method name → implementation returning a value (or throwing `{code}`). */
export type ScriptedAgent = Record<string, (...args: never[]) => unknown>;

/** Thrown by scripted agent methods to make the agent report a failure code. */
export class AgentCode extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

const CALL =
  /^globalThis\.__eab(?: && globalThis\.__eab\.version === "[^"]*")? \? globalThis\.__eab\.(\w+)\((.*)\) : '__eabMissing'$/s;

/**
 * A page whose agent is a plain object of scripted methods, so engine logic (auto-wait, steps,
 * observations, waits) can be tested without a DOM. Records every CDP call, including input.
 */
export class FakeAgentPage extends FakeCdpTransport {
  readonly agent: ScriptedAgent;

  constructor(agent: ScriptedAgent) {
    super();
    this.agent = agent;
    this.handle('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'main' } } }));
    this.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
    this.handle('Page.getLayoutMetrics', () => ({
      cssVisualViewport: { clientWidth: 1000, clientHeight: 800 },
    }));
    for (const method of [
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'DOM.setFileInputFiles',
    ]) {
      this.handle(method, () => ({}));
    }
    this.handle('Runtime.evaluate', (params) => this.#evaluate(params as { expression: string }));
  }

  /** CDP calls of one method, in order. */
  sent(method: string): object[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params ?? {});
  }

  async #evaluate({ expression }: { expression: string }): Promise<unknown> {
    if (expression.includes('__eab.element(')) return { result: { objectId: 'obj-1' } };
    const match = CALL.exec(expression);
    if (!match) return { result: {} };
    const [, method = '', argsText = ''] = match;
    const implementation = this.agent[method];
    if (!implementation) return { result: { value: { ok: false, code: 'INTERNAL', error: `no ${method}` } } };
    try {
      const args = JSON.parse(`[${argsText}]`) as never[];
      const value: unknown = await implementation(...args);
      return { result: { value: { ok: true, value: value ?? null } } };
    } catch (error) {
      if (error instanceof AgentCode) {
        return { result: { value: { ok: false, code: error.code, error: error.message } } };
      }
      throw error;
    }
  }
}
