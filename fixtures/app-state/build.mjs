// Bundle the fixture's renderer (real store libraries + @eab/electron/renderer) into dist/renderer.js.
// Run by `pnpm gen`; dist/ is git-ignored.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(root, 'src', 'renderer.js')],
  outfile: join(root, 'dist', 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  // Sources of workspace packages: dist/ may not be built yet.
  conditions: ['@eab/source'],
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
});
