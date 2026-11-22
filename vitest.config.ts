import { defineConfig } from 'vitest/config';

// Workspace sources are resolved through the `@eab/source` export condition, so tests never need a build.
// Vite resolves Node-environment tests through its SSR environment, which has its own condition list.
const conditions = ['@eab/source', 'module', 'node', 'import', 'default'];
const resolve = { conditions };
const ssr = { resolve: { conditions } };

/** Coverage floors. Electron adapters that need a real Electron are covered by e2e instead. */
const floor = (percent: number) => ({
  lines: percent,
  statements: percent,
  functions: percent,
  branches: percent,
});

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/testing/**',
        '**/generated/**',
        // The bundle entry only installs the agent; createAgent is tested directly.
        'packages/page-agent/src/agent/entry.ts',
        '**/index.ts',
        'packages/mcp/src/bin/**',
        'packages/electron/src/register.ts',
        // Need a live Electron main process; exercised by e2e/specs.
        'packages/electron/src/targets/**',
        'packages/electron/src/runtime/composition-root.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        'packages/core/src/**': floor(95),
        'packages/engine/src/**': floor(85),
        'packages/page-agent/src/**': floor(85),
        'packages/{electron,client,attach,mcp}/src/**': floor(75),
      },
    },
    projects: [
      {
        resolve,
        ssr,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve,
        ssr,
        test: {
          name: 'e2e',
          include: ['e2e/specs/**/*.e2e.ts'],
          setupFiles: ['e2e/harness/setup.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Each spec file launches its own Electron app; keep files sequential to avoid focus/GPU contention.
          fileParallelism: false,
        },
      },
    ],
  },
});
