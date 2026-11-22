// Bundle the fixture's renderer (real React and Vue) into dist/renderer.js. Run by `pnpm gen`; dist/ is
// git-ignored. Development builds keep component names, as apps under test usually run.
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
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  define: {
    'process.env.NODE_ENV': '"development"',
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  logLevel: 'warning',
});
