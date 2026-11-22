import {
  BridgeError,
  ok,
  type Envelope,
  type MethodData,
  type MethodInput,
  type TargetInfo,
} from '@electron-agent-bridge/core';

import type { ActionEngine } from '../action/action-engine.js';
import type { AgentSnapshotter } from '../snapshot/agent-snapshotter.js';
import type { NamedTarget, TargetRegistry } from '../targets/target-registry.js';
import type { Screenshotter } from '../page/screenshotter.js';
import type { ComponentReader } from '../state/component-reader.js';
import type { StateReader } from '../state/state-reader.js';
import type { Waiter } from '../wait/waiter.js';

export interface EngineDeps {
  readonly targets: TargetRegistry;
  readonly snapshotter: AgentSnapshotter;
  readonly actions: ActionEngine;
  readonly waiter: Waiter;
  readonly screenshots: Screenshotter;
  readonly state?: StateReader;
  /** React/Vue component state (protocol 1.1); absent: `state.component` is unsupported. */
  readonly components?: ComponentReader;
}

/** Matches returned by `dom.find` when the caller does not say. */
const DEFAULT_FIND_LIMIT = 20;

/** Transport-agnostic operations the runtime exposes over the control channel. */
export class EngineFacade {
  readonly #deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  listTargets(): Envelope<MethodData<'targets.list'>> {
    return ok({ targets: this.#deps.targets.list().map(toTargetInfo) });
  }

  snapshot(params: MethodInput<'snapshot.take'>): Promise<Envelope<MethodData<'snapshot.take'>>> {
    const { target: selector, ...options } = params;
    return this.#deps.snapshotter.take(this.#page(selector), options);
  }

  find(params: MethodInput<'dom.find'>): Promise<Envelope<MethodData<'dom.find'>>> {
    const target = this.#page(params.target);
    return this.#deps.snapshotter.find(target, params.locator, params.limit ?? DEFAULT_FIND_LIMIT);
  }

  act(params: MethodInput<'action.run'>): Promise<Envelope<MethodData<'action.run'>>> {
    const { target: selector, ...run } = params;
    return this.#deps.actions.run(this.#page(selector), run);
  }

  screenshot(params: MethodInput<'screenshot.take'>): Promise<Envelope<MethodData<'screenshot.take'>>> {
    const { target: selector, ...shot } = params;
    return this.#deps.screenshots.take(this.#page(selector), shot);
  }

  readState(params: MethodInput<'state.read'>): Promise<Envelope<MethodData<'state.read'>>> {
    const { target: selector, ...read } = params;
    return this.#stateReader().read(this.#page(selector), read);
  }

  dispatchState(params: MethodInput<'state.dispatch'>): Promise<Envelope<MethodData<'state.dispatch'>>> {
    const { target: selector, ...dispatch } = params;
    return this.#stateReader().dispatch(this.#page(selector), dispatch);
  }

  readComponent(params: MethodInput<'state.component'>): Promise<Envelope<MethodData<'state.component'>>> {
    const { target: selector, ...read } = params;
    if (!this.#deps.components) throw new BridgeError('UNSUPPORTED', 'this runtime does not read components');
    return this.#deps.components.read(this.#page(selector), read);
  }

  /** A target with a page: workers have logs and network only. */
  #page(selector: string | undefined): NamedTarget {
    const target = this.#deps.targets.resolve(selector);
    if (target.kind === 'worker' || target.kind === 'serviceWorker') {
      throw new BridgeError('UNSUPPORTED', `"${target.name}" is a ${target.kind}: it has no page`, {
        hint: 'Read its logs and network; pick a window or view for snapshots and actions.',
      });
    }
    return target;
  }

  #stateReader(): StateReader {
    if (!this.#deps.state) throw new BridgeError('UNSUPPORTED', 'this runtime does not read state');
    return this.#deps.state;
  }

  wait(params: MethodInput<'wait.for'>): Promise<Envelope<MethodData<'wait.for'>>> {
    const { target: selector, ...wait } = params;
    return this.#deps.waiter.waitFor(this.#page(selector), wait);
  }
}

function toTargetInfo(target: NamedTarget): TargetInfo {
  const info: TargetInfo = {
    id: target.id,
    name: target.name,
    kind: target.kind,
    title: target.title,
    url: target.url,
    attached: target.transport.attached,
    ...(target.visible === undefined ? {} : { visible: target.visible }),
  };
  const reason = target.transport.detachedReason;
  return reason === undefined ? info : { ...info, detachedReason: reason };
}
