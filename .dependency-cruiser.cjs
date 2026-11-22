/**
 * Package boundary rules (docs/architecture.md). Enforced in CI via `pnpm boundaries`.
 * @type {import('dependency-cruiser').IConfiguration}
 */
const pkg = (name) => `^packages/${name}/`;
// pnpm resolves packages to `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`; match both layouts.
const npm = (names) => [`^node_modules/(${names})/`, `^node_modules/[.]pnpm/(${names})@`];
const nodeBuiltins = { dependencyTypes: ['core'] };

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      comment: 'An import that cannot be resolved usually means an undeclared workspace dependency.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-dependencies',
      comment: 'Every imported package must be declared in the importing package.json.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'core-is-a-leaf',
      comment: 'core may depend on zod only.',
      severity: 'error',
      // Tests are never shipped; they may use test tooling.
      from: { path: pkg('core'), pathNot: '[.]test[.]ts$' },
      to: { path: '^(packages|node_modules)/', pathNot: ['^packages/core/', ...npm('zod')] },
    },
    {
      name: 'core-no-node',
      severity: 'error',
      from: { path: pkg('core') },
      to: nodeBuiltins,
    },
    {
      name: 'page-agent-is-an-island',
      comment: 'page-agent runs in the page; it may only import types from core.',
      severity: 'error',
      from: { path: pkg('page-agent') },
      to: {
        path: '^(packages|node_modules)/',
        pathNot: ['^packages/page-agent/'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'page-agent-no-node',
      severity: 'error',
      from: { path: pkg('page-agent') },
      to: nodeBuiltins,
    },
    {
      name: 'engine-is-transport-agnostic',
      comment: 'engine must not import electron, node builtins, sockets, or outer packages.',
      severity: 'error',
      from: { path: pkg('engine') },
      to: {
        path: [...npm('electron|ws'), pkg('electron'), pkg('client'), pkg('mcp')],
      },
    },
    {
      name: 'engine-no-node',
      severity: 'error',
      from: { path: pkg('engine') },
      to: nodeBuiltins,
    },
    {
      name: 'electron-runtime-stays-in-app',
      comment: 'the in-app runtime must not pull in client/mcp code or sockets libraries.',
      severity: 'error',
      from: { path: pkg('electron') },
      to: { path: [pkg('client'), pkg('mcp'), ...npm('ws')] },
    },
    {
      name: 'client-does-not-import-runtime',
      comment: 'client references @eab/electron/inject by resolved path only, never by import.',
      severity: 'error',
      from: { path: pkg('client') },
      to: { path: [pkg('electron'), pkg('engine'), pkg('page-agent'), pkg('mcp')] },
    },
    {
      name: 'mcp-goes-through-client',
      comment:
        'mcp/cli talk to apps only through the BridgeApi in @eab/client (or @eab/attach, which returns one).',
      severity: 'error',
      from: { path: pkg('mcp') },
      to: { path: [pkg('electron'), pkg('engine'), pkg('page-agent')] },
    },
    {
      name: 'attach-stays-outside-the-app',
      comment: 'attach mode runs the engine in the client process: never the in-app runtime or mcp.',
      severity: 'error',
      from: { path: pkg('attach') },
      to: { path: [pkg('electron'), pkg('mcp'), ...npm('electron|ws')] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build tooling (packages/*/scripts) runs in Node at build time and is not part of any package.
    exclude: { path: ['\\.tsbuild/', '/dist/', '^packages/[^/]+/scripts/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      conditionNames: ['@eab/source', 'import', 'require', 'node', 'default'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.js', '.cjs', '.mjs', '.json'],
    },
  },
};
