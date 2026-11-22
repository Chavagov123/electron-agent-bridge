import { WaitConditionSchema } from '@electron-agent-bridge/core';
import { z } from 'zod';

import { renderLimitations, untrusted } from '../render/text.js';
import { CompactCondition } from './compact.js';
import { defineTool } from './tool.js';

export const waitForTool = defineTool({
  name: 'wait_for',
  description:
    'Wait until something is true on a page: an element is visible/hidden/enabled/attached/detached, a text ' +
    'appears or disappears, the URL contains a string, or the network is idle. On timeout, says what was ' +
    'last observed.',
  inputSchema: {
    target: z.string().optional().describe('Target name or id; default: focused window.'),
    condition: WaitConditionSchema,
    timeoutMs: z.number().int().min(0).max(300_000).optional().describe('Default 10000.'),
  },
  compactSchema: {
    target: z.string().optional(),
    condition: CompactCondition,
    timeoutMs: z.number().optional(),
  },
  async handle(input, { sessions }) {
    const client = await sessions.current();
    const result = await client.call('wait.for', {
      condition: input.condition,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const observed = result.data.observed === undefined ? '' : `\n${untrusted(result.data.observed)}`;
    return `Condition met after ${Math.round(result.data.elapsedMs)} ms.${observed}${renderLimitations(result.limitations)}`;
  },
});
