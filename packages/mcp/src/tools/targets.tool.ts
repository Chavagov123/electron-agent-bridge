import { renderLimitations, untrusted } from '../render/text.js';
import { defineTool } from './tool.js';

export const targetsTool = defineTool({
  name: 'targets',
  description:
    'List the pages (windows, views, webviews) of the connected app, marking hidden ones. Use a name or id as `target` elsewhere; without one, calls use the main page on screen.',
  inputSchema: {},
  async handle(_input, { sessions }) {
    const client = await sessions.current();
    const result = await client.call('targets.list', {});
    const { targets } = result.data;
    if (targets.length === 0) return `The app has no pages yet.${renderLimitations(result.limitations)}`;
    const lines = targets.map((target) => {
      const detached = target.attached ? '' : ` [detached: ${target.detachedReason ?? 'unknown'}]`;
      const hidden = target.visible === false ? ' [hidden]' : '';
      return `${target.id} ${target.kind}${hidden}${detached}`;
    });
    // Names are usually derived from titles and URLs, which the page chooses: all three travel inside
    // the untrusted block. Ids and kinds come from the runtime.
    const pages = targets.map(
      (target) => `${target.id} name=${target.name} title=${JSON.stringify(target.title)} url=${target.url}`,
    );
    return `${lines.join('\n')}\n${untrusted(pages.join('\n'))}${renderLimitations(result.limitations)}`;
  },
});
