// @vitest-environment happy-dom
import { AGENT_SOURCE, AGENT_VERSION } from '@electron-agent-bridge/page-agent';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakePage } from '../testing/fake-page.js';
import { PageAgentClient } from './page-agent-client.js';

const bundle = { source: AGENT_SOURCE, version: AGENT_VERSION };

beforeEach(() => {
  document.body.innerHTML = '<h1>Orders</h1><button>Save</button>';
});

describe('PageAgentClient', () => {
  it('bootstraps without awaiting: Runtime.enable and the agent for every new document', async () => {
    const page = new FakePage(bundle);
    await new PageAgentClient(page, bundle).snapshot({});
    const posted = page.calls.filter((call) => call.posted);
    expect(posted.map((call) => call.method)).toEqual([
      'Runtime.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    expect(posted[1]?.params).toEqual({ source: AGENT_SOURCE, worldName: '__eab', runImmediately: true });
  });

  it('creates the world and installs the agent when no context was announced', async () => {
    const page = new FakePage(bundle);
    const result = await new PageAgentClient(page, bundle).snapshot({});
    expect(result.text).toContain('button "Save"');
    expect(page.calls.map((call) => call.method)).toContain('Page.createIsolatedWorld');
    expect(page.installedIn.size).toBe(1);
  });

  it('replaces an agent of another version left in a page that kept running', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    page.announceContext(7);
    page.installedIn.add(7);
    // An older bridge's agent: it answers, but not with this bridge's behaviour.
    Object.defineProperty(globalThis, '__eab', {
      value: { version: 'older', snapshot: () => ({ ok: true, value: { text: 'stale' } }) },
      configurable: true,
    });
    const result = await client.snapshot({});
    expect(result.text).toContain('button "Save"');
    expect((globalThis as unknown as { __eab: { version: string } }).__eab.version).toBe(AGENT_VERSION);
  });

  it('uses the context Chromium announces, without creating a world', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    page.announceContext(7);
    await client.snapshot({});
    expect(page.calls.map((call) => call.method)).not.toContain('Page.createIsolatedWorld');
    expect(page.installedIn).toEqual(new Set([7]));
  });

  it('recovers when its context is destroyed by a navigation', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    page.announceContext(7);
    await client.snapshot({});
    page.deadContexts.add(7);
    const result = await client.snapshot({});
    expect(result.kind).toBe('full');
    expect(page.installedIn.size).toBe(2);
  });

  it('forgets contexts on destroy/clear events and bootstraps again after a re-attach', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    page.announceContext(7);
    page.emit({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 7 } });
    await client.snapshot({});
    expect(page.installedIn.has(7)).toBe(false);
    page.emit({ method: 'Runtime.executionContextsCleared', params: {} });
    page.reattach();
    await client.snapshot({});
    expect(page.calls.filter((call) => call.method === 'Runtime.enable')).toHaveLength(2);
  });

  it('ignores events of other worlds and child sessions', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    page.emit({
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 3, name: '', auxData: { frameId: 'main' } } },
    });
    page.emit({
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 4, name: '__eab' } },
      sessionId: 's1',
    });
    await client.snapshot({});
    expect(page.installedIn.has(3) || page.installedIn.has(4)).toBe(false);
  });

  it('finds elements and turns agent failures into bridge errors', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    const found = await client.find({ role: 'button' }, 5);
    expect(found.matches.map((match) => match.name)).toEqual(['Save']);
    await expect(client.find({ css: '[[' }, 5)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(client.snapshot({ root: { ref: 'e999' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lends element handles and releases them afterwards', async () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    const refs = await client.refs(10);
    const ids = await client.withElements(refs, (objectIds) => Promise.resolve(objectIds));
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(page.calls.at(-1)).toMatchObject({ method: 'Runtime.releaseObjectGroup', posted: true });
  });

  it('gives up with a hint when every context dies (a page navigating continuously)', async () => {
    const page = new FakePage(bundle);
    page.handle('Runtime.evaluate', () => {
      throw new Error('Cannot find context with specified id');
    });
    await expect(new PageAgentClient(page, bundle).snapshot({})).rejects.toMatchObject({
      code: 'INTERNAL',
      hint: expect.stringContaining('navigating continuously') as unknown,
    });
  });

  it('reports exceptions thrown in the page and passes other CDP failures through', async () => {
    const page = new FakePage(bundle);
    page.handle('Runtime.evaluate', () => ({
      result: {},
      exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } },
    }));
    await expect(new PageAgentClient(page, bundle).snapshot({})).rejects.toThrow(/TypeError: boom/);
    const broken = new FakePage(bundle);
    broken.handle('Runtime.evaluate', () => {
      throw new Error('Target crashed');
    });
    await expect(new PageAgentClient(broken, bundle).snapshot({})).rejects.toThrow('Target crashed');
  });

  it('enables the Accessibility domain once per CDP session', () => {
    const page = new FakePage(bundle);
    const client = new PageAgentClient(page, bundle);
    client.ensure('Accessibility.enable');
    client.ensure('Accessibility.enable');
    page.reattach();
    client.ensure('Accessibility.enable');
    expect(page.calls.filter((call) => call.method === 'Accessibility.enable')).toHaveLength(2);
  });
});
