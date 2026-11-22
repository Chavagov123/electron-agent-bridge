import { RECORD_BINDING as AGENT_BINDING } from '@eab/page-agent';
import { describe, expect, it } from 'vitest';

import { ActionEngine } from '../action/action-engine.js';
import { AgentPool } from '../page/agent-pool.js';
import { agentWith, bundle, targetInfo } from '../testing/action-fixtures.js';
import { FakeAgentPage } from '../testing/fake-agent-page.js';
import { FakeClock } from '../testing/fake-clock.js';
import { InputRecorder, queryRecorded } from './input-recorder.js';

const RECORD_BINDING = '__eabRecord';

function binding(page: FakeAgentPage, payload: unknown): void {
  page.emit({
    method: 'Runtime.bindingCalled',
    params: {
      name: RECORD_BINDING,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      executionContextId: 1,
    },
  });
}

const click = (name: string) => ({
  action: { type: 'click', locator: { role: 'button', name, exact: true } },
  url: 'file:///a.html',
});

function setup() {
  const page = new FakeAgentPage(
    agentWith({
      recordStart: () => true,
      recordStop: () => true,
      locatorFor: (...args: never[]) => ({ role: 'button', name: `stable-${String(args[0])}`, exact: true }),
    }),
  );
  page.handle('Runtime.addBinding', () => ({}));
  page.handle('Runtime.removeBinding', () => ({}));
  page.handle('Runtime.enable', () => ({}));
  page.handle('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: '1' }));
  const clock = new FakeClock();
  const pool = new AgentPool(bundle);
  const recorder = new InputRecorder({ pool, clock });
  const watching = recorder.watch('wc1', page);
  return { page, clock, pool, recorder, watching };
}

describe('InputRecorder', () => {
  it('uses the page agent’s binding name', () => {
    expect(AGENT_BINDING).toBe(RECORD_BINDING);
  });

  it('arms the binding in the agent world while recording, and records what users do', async () => {
    const { page, recorder } = setup();
    binding(page, click('Ignored'));
    expect(await recorder.start()).toBe(1);
    expect(page.sent('Runtime.addBinding')).toEqual([
      { name: RECORD_BINDING, executionContextName: '__eab' },
    ]);
    expect(page.sent('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
    binding(page, click('Save'));
    binding(page, {
      ...click('Pw'),
      action: { type: 'fill', locator: { css: '#pw' }, value: '' },
      secret: true,
    });
    binding(page, 'not json');
    binding(page, { action: { type: 'teleport' }, url: 'x' });
    expect(recorder.refusedIn({ since: 0, nextSeq: 100 })).toBe(2);
    // A cursor past the end (an earlier recorder's) is read from the start: the refusals count.
    expect(recorder.refusedIn({ since: 100, nextSeq: 200 })).toBe(2);
    page.emit({ method: 'Runtime.bindingCalled', params: { name: 'other', payload: '{}' } });
    page.emit({
      method: 'Runtime.bindingCalled',
      params: { name: RECORD_BINDING, payload: '{}' },
      sessionId: 'child',
    });
    const events = recorder.query();
    expect(
      events.items.map(({ seq, target, source, action, secret }) => ({
        seq,
        target,
        source,
        action,
        secret,
      })),
    ).toEqual([
      { seq: 1, target: 'wc1', source: 'user', action: click('Save').action, secret: undefined },
      {
        seq: 2,
        target: 'wc1',
        source: 'user',
        action: { type: 'fill', locator: { css: '#pw' }, value: '' },
        secret: true,
      },
    ]);
    expect(events.recording).toBe(true);
    await recorder.stop();
    expect(page.sent('Runtime.removeBinding')).toEqual([{ name: RECORD_BINDING }]);
    binding(page, click('After'));
    expect(recorder.query({ since: 2 }).items).toEqual([]);
    expect(recorder.query().recording).toBe(false);
  });

  it('arms pages created while recording and again after a re-attach', async () => {
    const { page, recorder } = setup();
    await recorder.start();
    const later = new FakeAgentPage(agentWith());
    later.handle('Runtime.addBinding', () => ({}));
    recorder.watch('wc2', later);
    expect(later.sent('Runtime.addBinding')).toHaveLength(1);
    page.detach('host-debugger');
    page.reattach();
    expect(page.sent('Runtime.addBinding')).toHaveLength(2);
  });

  it('drops page input during an agent’s run and records the run with stable locators instead', async () => {
    const { page, pool, recorder, clock } = setup();
    await recorder.start();
    const engine = new ActionEngine({ pool, clock, recorder });
    const target = {
      id: 'wc1',
      kind: 'window' as const,
      title: 'A',
      url: 'u',
      focused: true,
      transport: page,
    };
    page.agent['actionTarget'] = () => {
      binding(page, click('Caused by the agent'));
      return targetInfo({ ref: 'e7' });
    };
    await engine.run(target, {
      actions: [
        { type: 'click', locator: { ref: 'e7' } },
        { type: 'press', key: 'Enter' },
      ],
    });
    expect(recorder.query().items.map(({ source, action }) => ({ source, action }))).toEqual([
      {
        source: 'agent',
        action: { type: 'click', locator: { role: 'button', name: 'stable-e7', exact: true } },
      },
      { source: 'agent', action: { type: 'press', key: 'Enter' } },
    ]);
    binding(page, click('Mine'));
    expect(recorder.query().items.at(-1)?.source).toBe('user');
  });

  it('falls back to role and name, or text for a generic clickable, when the page cannot say', async () => {
    const { page, pool, recorder, clock } = setup();
    await recorder.start();
    const engine = new ActionEngine({ pool, clock, recorder });
    const target = {
      id: 'wc1',
      kind: 'window' as const,
      title: 'A',
      url: 'u',
      focused: true,
      transport: page,
    };
    page.agent['locatorFor'] = () => {
      throw new Error('older agent');
    };
    page.agent['actionTarget'] = (...args: never[]) =>
      JSON.stringify(args[0]).includes('e8')
        ? targetInfo({ ref: 'e8', role: 'generic', name: 'Reload', tag: 'div' })
        : targetInfo({ ref: 'e7' });
    await engine.run(target, {
      actions: [
        { type: 'click', locator: { ref: 'e7' } },
        { type: 'click', locator: { ref: 'e8' } },
      ],
    });
    expect(recorder.query().items.map(({ action }) => action)).toEqual([
      { type: 'click', locator: { role: 'button', name: 'Save', exact: true } },
      { type: 'click', locator: { text: 'Reload', exact: true } },
    ]);
  });

  it('names pages in record.events and reports evicted events', async () => {
    const { page, clock } = setup();
    const recorder = new InputRecorder({ pool: new AgentPool(bundle), clock, capacityBytes: 400 });
    recorder.watch('wc1', page);
    await recorder.start();
    for (let index = 0; index < 10; index++) binding(page, click(`B${index}`));
    const result = queryRecorded(recorder, { list: () => [{ id: 'wc1', name: 'main' }] }, {});
    expect(result.data.items.every((event) => event.target === 'main')).toBe(true);
    expect(result.limitations[0]?.code).toBe('dropped');
  });
});
