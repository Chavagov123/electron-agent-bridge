# @eab/attach

## 1.1.0-rc.0

### Minor Changes

- Attach mode: new package `@eab/attach`. `attach({ port })` drives the renderers of a running app over
  its `--remote-debugging-port`, with the engine in the calling process and no runtime inside the app;
  main-process methods answer `UNSUPPORTED`. MCP: `session action=attach port=…` (needs
  `eab-mcp --allow-eval`). `BridgeClient` now takes any `RpcCaller`.

### Patch Changes

- Fixes found driving a large bundled React app:
  
  - Snapshots no longer fold a page's own content at the top level, where there is no ref to expand it:
    only a list of like items (mostly one role) folds there.
  - Log entries point at the app code that wrote them: frames of console wrappers (a DevTools extension's
    hook, an error reporter's console patch, dependencies) are passed over, ten frames are kept, and
    entries carry a `column` (protocol 1.1) so locations without a stack are source-mapped too.
  - Source maps of large bundles are found: only the end of a script is read for its
    `sourceMappingURL`, maps up to 32 MB are read, and the cache is bounded by size as well as count.
  - Exported Playwright tests find windows by the bridge's target names (slugs of file name or title).
  - Attach mode reports the app's name, version and main process id, and says why no store is found
    when the page loaded before attaching.
- Updated dependencies
- Updated dependencies [c4fa0ec]
- Updated dependencies [0d1055e]
- Updated dependencies [22096cf]
- Updated dependencies [26ba027]
- Updated dependencies [c4fa0ec]
- Updated dependencies [c4fa0ec]
- Updated dependencies [1dda16c]
- Updated dependencies [2ee5a5c]
- Updated dependencies [f77c7a9]
- Updated dependencies [5a0e340]
- Updated dependencies [1c24fab]
- Updated dependencies [b85cb50]
  - @eab/core@1.1.0-rc.0
  - @eab/page-agent@1.1.0-rc.0
  - @eab/engine@1.1.0-rc.0
  - @eab/client@1.1.0-rc.0
