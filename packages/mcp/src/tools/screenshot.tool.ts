import { LocatorSchema } from '@electron-agent-bridge/core';
import { z } from 'zod';

import { renderLimitations } from '../render/text.js';
import { CompactLocator } from './compact.js';
import { definedOf } from './defined.js';
import { defineTool } from './tool.js';

export const screenshotTool = defineTool({
  name: 'screenshot',
  description:
    'Picture of a page, or of one element (locator). Use snapshot to read and act on a page; use this ' +
    'when the visual appearance matters (layout, images, canvas).',
  inputSchema: {
    target: z.string().optional().describe('Page; default: focused window.'),
    locator: LocatorSchema.optional().describe('Only this element (ref, role+name, text or css).'),
    format: z.enum(['png', 'jpeg']).optional().describe('Default png.'),
    quality: z.number().int().min(1).max(100).optional().describe('JPEG quality.'),
  },
  compactSchema: {
    target: z.string().optional(),
    locator: CompactLocator.optional(),
    format: z.enum(['png', 'jpeg']).optional(),
    quality: z.number().optional(),
  },
  async handle(input, { sessions }) {
    const client = await sessions.current();
    const result = await client.call('screenshot.take', definedOf(input));
    const { mimeType, width, height, base64, path } = result.data;
    const text = `Screenshot ${width}×${height} (${mimeType})${path === undefined ? '' : `, saved to ${path}`}.`;
    return {
      text: `${text}${renderLimitations(result.limitations)}`,
      images: base64 === undefined ? [] : [{ data: base64, mimeType }],
    };
  },
});
