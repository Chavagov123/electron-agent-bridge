import type { Action, Envelope, MethodData } from '@eab/core';

import { ActionEngine } from '../action/action-engine.js';
import { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import type { FakeAgentPage, ScriptedAgent } from './fake-agent-page.js';
import { FakeClock } from './fake-clock.js';

export const bundle = { source: 'install()', version: 'test' };

/** A visible, enabled button-like target at (100, 50). */
export function targetInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'e1',
    role: 'button',
    name: 'Save',
    tag: 'button',
    inputType: undefined,
    x: 100,
    y: 50,
    editable: false,
    draggable: false,
    healed: false,
    ...overrides,
  };
}

/** Defaults every action needs: snapshots, live regions, settling. */
export function agentWith(overrides: ScriptedAgent = {}): ScriptedAgent {
  let cursor = 0;
  const agent: ScriptedAgent = {
    snapshot: (...args: never[]) => {
      const request = args[0] as unknown as { mode?: string };
      cursor++;
      return {
        kind: request.mode === 'delta' ? 'delta' : 'full',
        cursor: `c${cursor}`,
        text: request.mode === 'delta' ? '+ - text "Saved"' : '- button "Save" [e1]',
        lineCount: 1,
        truncated: false,
        collapsed: 0,
        crossOriginFrames: 0,
        url: 'file:///a',
        title: 'A',
      };
    },
    live: () => ({ regions: {}, dialogs: [] }),
    quiet: () => 12,
    actionTarget: () => targetInfo(),
    focus: () => true,
    state: () => ({ value: '' }),
    ...overrides,
  };
  // `settle` is `quiet` then `live`, as the real agent does it (overrides of either apply).
  agent['settle'] = async (...args: never[]) => ({
    ms: await agent['quiet']?.(...args),
    live: await agent['live']?.(),
  });
  return agent;
}

/** Run actions against a scripted page (a fresh pool unless one is given). */
export async function run(
  page: FakeAgentPage,
  actions: Action[],
  extra: Record<string, unknown> = {},
  pool = new AgentPool(bundle),
): Promise<Envelope<MethodData<'action.run'>>> {
  const engine = new ActionEngine({ pool, clock: new FakeClock() });
  const target: TargetDescriptor = {
    id: 'wc1',
    kind: 'window',
    title: 'A',
    url: 'u',
    focused: true,
    transport: page,
  };
  return engine.run(target, { actions, ...extra });
}
