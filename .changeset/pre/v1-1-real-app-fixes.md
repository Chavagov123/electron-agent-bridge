---
'@eab/core': minor
'@eab/engine': minor
'@eab/electron': patch
'@eab/page-agent': patch
'@eab/client': patch
'@eab/attach': patch
---

Fixes found driving a large bundled React app:

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
