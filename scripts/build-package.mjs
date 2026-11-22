// Build one workspace package with esbuild. Run from the package directory:
//   node ../../scripts/build-package.mjs [--self-contained] [--esm-only] [--bin <entry>]... <entry>...
//
// - Default: dependencies stay external (resolved from node_modules at run time).
// - --self-contained: bundle everything except peer dependencies (the in-app runtime ships no runtime deps).
// - --bin <entry>: an executable ESM entry with a shebang (repeatable).
// - --cjs <entry>: an entry built as CommonJS only, e.g. a `--require` preload (repeatable).
// Workspace imports resolve through the `@electron-agent-bridge/source` condition, so builds never depend on other dists.
// An entry that imports another entry of the same build loads that entry's output at run time instead of
// bundling a second copy of it (e.g. `register` → `./index.js`).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
};
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
};

const selfContained = flag('--self-contained');
const esmOnly = flag('--esm-only');
const bins = [];
for (let bin = option('--bin'); bin !== undefined; bin = option('--bin')) bins.push(bin);
const cjsEntries = [];
for (let entry = option('--cjs'); entry !== undefined; entry = option('--cjs')) cjsEntries.push(entry);
const entries = args;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const peers = Object.keys(pkg.peerDependencies ?? {});
const external = selfContained ? peers : [...peers, ...Object.keys(pkg.dependencies ?? {})];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  conditions: ['@electron-agent-bridge/source'],
  external,
  logLevel: 'warning',
  outdir: 'dist',
  outbase: 'src',
};

/** Imports of one entry by another resolve to the other's output (`extension`: `.js` or `.cjs`). */
function shareEntries(group, extension) {
  const files = new Set(group.map((entry) => resolve(entry)));
  const output = (file) => relative(resolve('src'), file).replace(/\.ts$/, extension);
  return {
    name: 'share-entries',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?\// }, (args) => {
        const target = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
        if (!files.has(args.importer) || !files.has(target) || target === args.importer) return undefined;
        const path = relative(dirname(output(args.importer)), output(target))
          .split(sep)
          .join('/');
        return { path: path.startsWith('.') ? path : `./${path}`, external: true };
      });
    },
  };
}

rmSync('dist', { recursive: true, force: true });
const builds = [];
if (entries.length > 0) {
  const esm = { entryPoints: entries, format: 'esm', outExtension: { '.js': '.js' } };
  builds.push(build({ ...common, ...esm, plugins: [shareEntries(entries, '.js')] }));
  if (!esmOnly) {
    const cjs = { entryPoints: entries, format: 'cjs', outExtension: { '.js': '.cjs' } };
    builds.push(build({ ...common, ...cjs, plugins: [shareEntries(entries, '.cjs')] }));
  }
}
if (cjsEntries.length > 0) {
  builds.push(build({ ...common, entryPoints: cjsEntries, format: 'cjs', outExtension: { '.js': '.cjs' } }));
}
if (bins.length > 0) {
  builds.push(build({ ...common, entryPoints: bins, format: 'esm', banner: { js: '#!/usr/bin/env node' } }));
}
await Promise.all(builds);
copyDeclarations();

/**
 * Declarations come from `tsc -b` (the root `build` script runs it first) into `.tsbuild`; ship them
 * next to the bundles so `exports[*].types` resolves for consumers outside the workspace.
 * Test files and test helpers are not part of the public surface.
 */
function copyDeclarations() {
  if (!existsSync('.tsbuild')) {
    throw new Error(`${pkg.name}: .tsbuild is missing; run \`tsc -b\` (pnpm run typecheck) before building`);
  }
  cpSync('.tsbuild', 'dist', {
    recursive: true,
    filter: (source) =>
      statSync(source).isDirectory()
        ? !/[\\/]testing$/.test(source)
        : source.endsWith('.d.ts') && !source.endsWith('.test.d.ts'),
  });
  if (!esmOnly) writeCommonJsDeclarations('dist');
}

/**
 * `.d.cts` twins of the declarations for `require` consumers (types of the `.cjs` bundles): the same
 * content with relative imports pointing at `.cjs` instead of `.js`. Without them, TypeScript treats a
 * CommonJS import of the package as ESM ("masquerading as ESM").
 */
function writeCommonJsDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      writeCommonJsDeclarations(path);
    } else if (entry.name.endsWith('.d.ts')) {
      const source = readFileSync(path, 'utf8').replace(/(['"])(\.{1,2}\/[^'"]+)\.js\1/g, '$1$2.cjs$1');
      writeFileSync(`${path.slice(0, -'.d.ts'.length)}.d.cts`, source);
    }
  }
}
