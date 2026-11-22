import { describe, expect, it } from 'vitest';

import { AgentPool } from '../page/agent-pool.js';
import { agentWith, bundle } from '../testing/action-fixtures.js';
import { FakeAgentPage } from '../testing/fake-agent-page.js';
import { ComponentReader } from './component-reader.js';

function page(answer: unknown, matches = [{ ref: 'e4', role: 'button', name: 'Add', line: '' }], total = 1) {
  const fake = new FakeAgentPage(agentWith({ find: () => ({ matches, total }) }));
  fake.handle('DOM.describeNode', () => ({ node: { backendNodeId: 9 } }));
  fake.handle('DOM.resolveNode', () => ({ object: { objectId: 'main-9' } }));
  fake.handle('Runtime.callFunctionOn', () => ({ result: { value: answer } }));
  fake.handle('Runtime.releaseObject', () => ({}));
  fake.handle('Runtime.releaseObjectGroup', () => ({}));
  return fake;
}

const target = (transport: FakeAgentPage) => ({
  id: 'wc1',
  kind: 'window' as const,
  title: 'A',
  url: 'u',
  focused: true,
  transport,
});

describe('ComponentReader', () => {
  it('hands the element to the main world and returns its component state, redacted', async () => {
    const fake = page({
      found: true,
      framework: 'react',
      chain: ['Counter', 'App'],
      name: 'Counter',
      value: { props: { label: 'Add', password: 'x' }, hooks: [3] },
      truncated: false,
    });
    const reader = new ComponentReader(new AgentPool(bundle));
    const result = await reader.read(target(fake), {
      locator: { role: 'button', name: 'Add' },
      path: 'hooks',
    });
    expect(result.data).toEqual({
      framework: 'react',
      chain: ['Counter', 'App'],
      name: 'Counter',
      path: 'hooks',
      value: { props: { label: 'Add', password: '[redacted]' }, hooks: [3] },
      truncated: false,
    });
    expect(result.untrusted).toBe(true);
    expect(result.limitations[0]?.code).toBe('redacted');
    expect(fake.sent('DOM.resolveNode')).toEqual([{ backendNodeId: 9 }]);
    const call = fake.sent('Runtime.callFunctionOn')[0] as {
      objectId: string;
      arguments: unknown[];
      functionDeclaration: string;
    };
    expect(call.objectId).toBe('main-9');
    expect(call.arguments).toEqual([{ value: { path: 'hooks' } }]);
    expect(call.functionDeclaration).toMatch(/^function \(request\)/);
    expect(fake.calls.some((entry) => entry.method === 'Runtime.releaseObject' && entry.posted)).toBe(true);
  });

  it('reports what the page says is missing, ambiguity and unexpected answers', async () => {
    const reader = new ComponentReader(new AgentPool(bundle));
    const missing = page({
      found: false,
      error: { code: 'NOT_FOUND', message: 'no React or Vue component', hint: 'h' },
    });
    await expect(reader.read(target(missing), { locator: { ref: 'e4' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: 'h',
    });
    const odd = page({ found: false, error: { code: 'WEIRD', message: 'm' } });
    await expect(reader.read(target(odd), { locator: { ref: 'e4' } })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    const garbage = page('nonsense');
    await expect(reader.read(target(garbage), { locator: { ref: 'e4' } })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    const two = page({}, [{ ref: 'e1', role: 'button', name: 'Add', line: '' }], 2);
    await expect(
      reader.read(target(two), { locator: { role: 'button', name: 'Add' } }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    const none = page({}, [], 0);
    await expect(reader.read(target(none), { locator: { text: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
