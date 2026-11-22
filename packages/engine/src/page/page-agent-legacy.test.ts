// @vitest-environment happy-dom
import { AGENT_SOURCE, AGENT_VERSION } from '@eab/page-agent';
import { expect, it } from 'vitest';

import { FakePage } from '../testing/fake-page.js';
import { PageAgentClient } from './page-agent-client.js';

// Its own file: the agent defined here can never be removed from this test environment again.
it('keeps using an older agent that cannot be replaced, as before replacing was possible', async () => {
  document.body.innerHTML = '<button>Save</button>';
  const bundle = { source: AGENT_SOURCE, version: AGENT_VERSION };
  const page = new FakePage(bundle);
  page.announceContext(7);
  page.installedIn.add(7);
  Object.defineProperty(globalThis, '__eab', {
    value: { version: 'older', snapshot: () => ({ ok: true, value: { text: 'from the older agent' } }) },
    configurable: false,
  });
  const installs: number[] = [];
  const evaluate = page.send.bind(page);
  page.send = (method: string, params?: object) => {
    if (method === 'Runtime.evaluate' && (params as { expression?: string }).expression === bundle.source) {
      installs.push(1);
    }
    return evaluate(method, params);
  };
  const client = new PageAgentClient(page, bundle);
  expect((await client.snapshot({})).text).toBe('from the older agent');
  // Tried once; later calls use the older agent without evaluating the bundle again.
  expect((await client.snapshot({})).text).toBe('from the older agent');
  expect(installs).toHaveLength(1);
});
