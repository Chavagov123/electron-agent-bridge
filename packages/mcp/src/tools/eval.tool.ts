import { z } from 'zod';

import { renderLimitations, untrusted } from '../render/text.js';
import { defineTool } from './tool.js';

/** Main-process evaluation. Listed only when the app granted the `eval` capability. */
export const evalTool = defineTool({
  name: 'eval',
  description:
    'Evaluate a JavaScript expression in the app’s main process (Node + Electron APIs) and return the ' +
    'result. Available only because the app enabled eval for this session; prefer the other tools.',
  inputSchema: {
    expression: z.string().min(1).max(10_000).describe('An expression; await is allowed.'),
    timeoutMs: z.number().int().min(0).max(60_000).optional(),
  },
  requires: 'eval',
  requiresFeature: 'mainControl',
  async handle(input, { sessions }) {
    const client = await sessions.current();
    const result = await client.call('main.eval', {
      expression: input.expression,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const { type, value, truncated } = result.data;
    const shown = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
    const cut = truncated ? '\n(value cut to fit)' : '';
    // Values can carry page or file content: untrusted like everything app-derived.
    return `Result (${type}):\n${untrusted(shown)}${cut}${renderLimitations(result.limitations)}`;
  },
});

/** Native dialog stubs (needs `eval`: they change how the app behaves). */
export const dialogsTool = defineTool({
  name: 'dialogs',
  description:
    'Queue answers for the app’s native dialogs (open/save file pickers, message boxes) so the next ' +
    'ones return immediately instead of blocking. Restored when the session resets or disconnects.',
  inputSchema: {
    method: z.enum(['showOpenDialog', 'showSaveDialog', 'showMessageBox']),
    response: z
      .record(z.string(), z.unknown())
      .describe(
        'What the dialog returns, e.g. {"canceled":false,"filePaths":["/tmp/a.txt"]} or {"response":0}.',
      ),
    times: z.number().int().min(1).max(100).optional().describe('How many dialogs to answer; default 1.'),
  },
  requires: 'eval',
  requiresFeature: 'mainControl',
  async handle(input, { sessions }) {
    const client = await sessions.current();
    const result = await client.call('dialog.stub', {
      method: input.method,
      response: input.response,
      ...(input.times === undefined ? {} : { times: input.times }),
    });
    return `${result.data.queued} ${input.method} answer(s) queued.${renderLimitations(result.limitations)}`;
  },
});
