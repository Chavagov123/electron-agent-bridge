// Bundle src/main.js as a bundler-built Electron app would, in two variants:
// - dist/inlined.cjs: @electron-agent-bridge/electron bundled into the app (only `electron` external);
// - dist/external.cjs: @electron-agent-bridge/electron kept external (the setup docs/bundlers.md recommends).
// Uses the built packages (dist/), as an app installing them from npm would: run after `pnpm build`.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));

for (const [variant, external] of [
  ['inlined', ['electron']],
  ['external', ['electron', '@electron-agent-bridge/electron', '@electron-agent-bridge/electron/*']],
]) {
  await build({
    entryPoints: [join(root, 'src', 'main.js')],
    outfile: join(root, 'dist', `${variant}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external,
    logLevel: 'warning',
  });
}
