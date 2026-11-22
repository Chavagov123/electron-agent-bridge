---
'@electron-agent-bridge/engine': patch
'@electron-agent-bridge/page-agent': patch
---

More fixes found driving a large bundled React app:

- An Electron `<webview>` shows in its host page's snapshot as `webview "…" [eN] separate target (see
  targets)`, no longer as a cross-origin iframe left out of the snapshot.
- A combobox that is a `<button>` (Radix and shadcn selects) shows its choice as its value.
- Recording: a click that opens an overlay (a select's menu, which lands the click on the page and
  hides the page behind it) is recorded on the control that was pressed, with the locator it had
  before the overlay opened; a click on the page itself is not recorded; a `generic` clickable is
  recorded by its text, which other tools (Playwright) can find.
- An agent left in a page by an older bridge is replaced by the current one (Attach mode to an app
  that kept running); agents that cannot be replaced keep working as before.
- A page whose title is still its file name (`Index.html`) is named after the file, not that title.
- Hints: NOT_FOUND mentions that a dialog hides the page behind it; a delta that falls back to a full
  snapshot because `maxLines` changed says so.
