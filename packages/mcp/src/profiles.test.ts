import { afterEach, describe, expect, it } from 'vitest';

import { SPILL_CHARS, TOOLS } from './server.js';
import {
  api,
  callText,
  calls,
  closeClient,
  connectedClient,
  fakeClient,
  spilledFiles,
} from './testing/mcp-harness.js';

afterEach(closeClient);

/** Budget for the compact tool list (JSON of tools/list): about 3k tokens for every v1 tool. */
const COMPACT_BUDGET_CHARS = 12_000;

async function toolListChars(profile: 'compact' | 'full', capabilities: string[] = ['observe']) {
  const client = await connectedClient(
    { ...api, connect: () => Promise.resolve(withCapabilities(capabilities)) },
    { profile },
  );
  await callText(client, 'session', { action: 'connect' });
  const { tools } = await client.listTools();
  await closeClient();
  return { chars: JSON.stringify(tools).length, names: tools.map((tool) => tool.name) };
}

function withCapabilities(capabilities: string[], overrides: Record<string, unknown> = {}) {
  const client = fakeClient(overrides);
  Object.assign(client.session, { capabilities });
  return client;
}

describe('tool profiles', () => {
  it('keeps the compact tool list within budget, even with eval tools listed', async () => {
    const compact = await toolListChars('compact', ['observe', 'interact', 'eval']);
    const full = await toolListChars('full', ['observe', 'interact', 'eval']);
    expect(compact.names).toHaveLength(14);
    expect(compact.chars).toBeLessThanOrEqual(COMPACT_BUDGET_CHARS);
    expect(full.chars).toBeGreaterThan(compact.chars);
  });

  it('validates compact input against the full schema and names every problem', async () => {
    const client = await connectedClient(undefined, { profile: 'compact' });
    await callText(client, 'session', { action: 'connect' });
    const bad = await callText(client, 'act', {
      actions: [
        { type: 'fill', locator: { ref: 'e1' } },
        { type: 'select', locator: { role: 'combobox' } },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(
      /^Error \[INVALID_PARAMS\]: invalid input: actions\.0\.value: .*; actions\.1\.values: /,
    );
    expect(bad.text).toContain('EAB_TOOL_PROFILE=full');
  });

  it('passes every field of a compact call through to the bridge', async () => {
    const client = await connectedClient(
      {
        ...api,
        connect: () =>
          Promise.resolve(
            fakeClient({
              'action.run': {
                data: {
                  steps: [{ type: 'drag', ok: true, timings: { actionMs: 1, settleMs: 1 } }],
                  observations: { dialogs: [], toasts: [], consoleErrors: [], failedRequests: [], ipc: [] },
                },
                limitations: [],
              },
            }),
          ),
      },
      { profile: 'compact' },
    );
    await callText(client, 'session', { action: 'connect' });
    calls.length = 0;
    const step = { type: 'drag', from: { role: 'listitem', name: 'Card', exact: true }, to: { ref: 'e9' } };
    expect((await callText(client, 'act', { actions: [step] })).isError).toBe(false);
    expect(calls[0]?.params).toEqual({ actions: [step] });
  });
});

describe('validation', () => {
  it('reports invalid input the same way in the full profile', async () => {
    const client = await connectedClient(undefined, { profile: 'full' });
    await callText(client, 'session', { action: 'connect' });
    const bad = await callText(client, 'act', { actions: [{ type: 'tap' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Error \[INVALID_PARAMS\]: invalid input: actions\.0\.type: /);
  });

  it('advertises the same fields in both profiles', () => {
    for (const tool of TOOLS) {
      const compact = Object.keys(tool.compactSchema ?? tool.inputSchema).sort();
      expect(compact, tool.name).toEqual(Object.keys(tool.inputSchema).sort());
    }
  });
});

describe('eval-gated tools', () => {
  it('cannot be called before the app grants eval', async () => {
    const client = await connectedClient();
    await callText(client, 'session', { action: 'connect' });
    const result = await callText(client, 'eval', { expression: '1' });
    expect(result.text).toMatch(/^Error \[NOT_FOUND\]: unknown tool "eval"\nHint: List the tools again/);
  });

  it('appear only while the session has the eval capability', async () => {
    expect((await toolListChars('compact', ['observe'])).names).not.toContain('eval');
    const granted = (await toolListChars('compact', ['observe', 'interact', 'eval'])).names;
    expect(granted.slice(-2)).toEqual(['dialogs', 'eval']);
  });
});

describe('spill', () => {
  it('writes oversized output to a file and keeps the head inline', async () => {
    const huge = '- text "x"\n'.repeat(SPILL_CHARS / 10);
    const client = await connectedClient({
      ...api,
      connect: () =>
        Promise.resolve(
          fakeClient({
            'snapshot.take': {
              data: { target: 'wc1', url: 'u', title: 't', kind: 'full', text: huge, lineCount: 9 },
              limitations: [],
            },
          }),
        ),
    });
    await callText(client, 'session', { action: 'connect' });
    const { text } = await callText(client, 'snapshot');
    expect(text.length).toBeLessThan(5_000);
    const path = /all of it is in (\S+)$/.exec(text)?.[1] ?? '';
    expect(spilledFiles.get(path)).toContain(huge);
    expect(text).toContain('- spilled: the output was');
  });
});
