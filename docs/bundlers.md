# Bundlers

The bridge works in bundled main processes (electron-vite, Electron Forge with webpack or Vite,
plain webpack, esbuild, Rollup). Two rules:

1. **Import the bridge first** in the main entry, before anything that registers IPC handlers or creates
   windows. Bundlers keep side-effect imports in order, so this is enough:

   ```js
   // src/main/index.ts
   import '@electron-agent-bridge/electron/register';
   import { app, BrowserWindow } from 'electron';
   // …the app
   ```

   Or call `enableAgentBridge({ … })` first thing to pass options. Both do nothing unless
   `EAB_ENABLE=1` is set, so the line can stay in the code.

2. **Inline it or keep it external: both work.** The runtime carries its page agent, state hook and
   renderer preload as embedded strings and writes the preload to its own private directory, so it
   needs no files from `node_modules` at run time. The e2e suite runs a bundled main both ways
   (`e2e/specs/bundled.e2e.ts`).
   - *External* (recommended): the bundle stays small and the bridge can be updated or dropped without a
     rebuild. It then has to be installed where the app runs (a `dependencies` entry, or a dev-only
     setup that is not packaged).
   - *Inlined*: about 1 MB added to the main bundle; nothing to install next to the app.

## electron-vite

```ts
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  // Dependencies, @electron-agent-bridge/electron included, stay external (electron-vite's default with this plugin).
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {},
});
```

`registerState` from `@electron-agent-bridge/electron/renderer` is dependency-free and is bundled into the renderer like
any other module.

## Electron Forge (webpack)

```js
// webpack.main.config.js
module.exports = {
  entry: './src/main.js',
  // Keep the bridge external (or delete this line to inline it).
  externals: { '@electron-agent-bridge/electron': 'commonjs @electron-agent-bridge/electron', '@electron-agent-bridge/electron/register': 'commonjs @electron-agent-bridge/electron/register' },
};
```

With the Forge Vite plugin, list `@electron-agent-bridge/electron` in `build.rollupOptions.external` of the main config,
or leave it out to inline it.

## Plain webpack / esbuild / Rollup

Target Node (`target: 'electron-main'`, `platform: 'node'`), keep `electron` external, and either keep
`@electron-agent-bridge/electron` external or let it be bundled.

## Packaged builds

A packaged app never enables the bridge unless the app passes `allowPackaged: true` (Integrated) or the
launcher passes `--allow-packaged` (Launch); see [security](security.md). To test an unmodified packaged
app, use Launch mode (`eab launch`) instead of shipping the import.
