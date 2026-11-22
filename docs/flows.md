# Flows

A flow is a test written as YAML (or JSON): steps that drive the app and checks that wait for the
expected effect. Run flows locally or in CI with `eab run`; they use the same actions and waits agents use.

```yaml
name: Place an order
timeoutMs: 5000            # default for every step (10 s if omitted)
steps:
  - name: fill and save the order form
    act:
      - { type: fill, locator: { role: textbox, name: Customer }, value: Ada }
      - { type: click, locator: { role: button, name: Save order } }
  - expect: { text: Order saved }
  - expect: { element: { text: Ada x1 }, state: visible }
  - expect: { noConsoleErrors: true }
  - screenshot: { file: order.png }
```

```sh
eab run flows/ --junit report.xml --artifacts flow-artifacts
```

`eab run` takes flow files (any name) and directories (searched recursively for `*.flow.yaml`,
`*.flow.yml` and `*.flow.json`, in name order), prints
each step with ✓ / ✗ / -, and exits 0 when every flow passed, 1 when one failed (or a file is invalid),
2 when the command line is wrong. `--junit` writes a JUnit report (one suite per flow, one case per
step); `--pid N` runs every flow against that running app.

## The app

```yaml
app: { connect: { pid: 1234 } }     # a running app; default: the newest one (or --pid)
app:
  launch:                            # started for this flow and closed afterwards
    executable: ${env.ELECTRON}      # ${env.NAME} works in any string; a missing variable is an error
    args: [ "${env.APP_DIR}" ]
    allowEval: true                  # needed for `stub`
    # also: cwd, env, strategy, allowPackaged, timeoutMs
```

## Steps

Every step can have `name`, `target` (page id or name; the flow-level `target` is the default),
`timeoutMs` and `continueOnError` (record the failure and go on; the flow still fails).

| Step | Does |
|---|---|
| `act: <action>` or `act: [<action>, …]` | the `act` tool's actions: click, fill, fillForm, type, press, check, uncheck, select, scroll, hover, upload, drag |
| `wait: <condition>` | the `wait_for` conditions: element, text, url, ipc, networkIdle, state |
| `expect: <check>` | a check (below) |
| `stub: { method, response, times }` | answer native dialogs (needs `eval`) |
| `menu: [File, Open…]` or `menu: { id: file.open }` | click an application-menu item (waits for it to exist, up to the step timeout) |
| `window: { action, id, bounds }` | focus, show, hide, minimize, maximize, restore, close, setBounds (default: the step's page's window) |
| `reset: true` | undo automation state (focus emulation, dialog stubs) |
| `screenshot: { file }` | save a screenshot into the artifacts directory |

## Checks

Checks wait up to the step timeout for the condition, so flows need no sleeps.

| Check | Passes when |
|---|---|
| `element: <locator>`, `state: visible` | an element matches (default `visible`; also `attached`, `detached`, `hidden`, `enabled`) |
| `text: …`, `present: false` | the page shows (or no longer shows) the text |
| `url: { contains: … }` | the page URL contains the text |
| `state: { store, path, equals }` | a store value equals the expected one (as `state.read` returns it, redacted and bounded) |
| `ipc: { channel, min }` | at least `min` (default 1) IPC messages on the channel glob since the flow started |
| `noConsoleErrors: true` | no renderer `console.error` or uncaught exception since the flow started (checked at once) |

Locators: with `role`, `name` and `text` match the accessible name; `text` alone matches visible text.

## Failures

The first failed step (unless `continueOnError`) skips the rest. With `--artifacts`, a failed step
leaves `step-N-failed.snapshot.txt`, `step-N-failed.png` and `step-N-failed.logs.txt` (warnings and
errors since the flow started) in `<artifacts>/<flow-name>/`. Invalid files are reported with the
file, line and step path: `order.yaml:7: steps[2].act.locator: …`.

From code: `parseFlow(text)`, `runFlow(flow, { client })`, `runFlowFiles(files, { api })` and
`toJunit(results)` from `@eab/client`.

## Recording flows (1.1)

```sh
eab record --out login.flow.yaml        # use the app, then press Enter (or Ctrl+C)
eab run login.flow.yaml
```

While recording, the bridge captures what users do in every page — clicks, each field's final value,
checkbox, radio and select changes, and command keys (Enter, Escape, Tab, arrows, chords like
`Control+S`) — and what agents run through `act`. Each action gets the most stable locator that finds
exactly that element: role and exact name (with `nth` when the name is shared), then exact text, then
an id, a test id or a CSS path. Input the page receives while an agent's action runs is the agent's
and is not recorded twice. Password fields are never recorded: the flow reads them from
`${env.FLOW_SECRET_1}`, `${env.FLOW_SECRET_2}`…

Agents record with the `session` tool: `action: recordStart`, then `action: recordStop` (optionally
with `out` and `name`) returns the flow. Programmatically: `record.start`, `record.events` and
`record.stop`, then `flowFromRecording(events, { name })` and `stringifyFlow(flow)` from `@eab/client`.
Recording is allowed for observers too. Not recorded: drag and drop, file choosers, typing into
contenteditable editors, and anything outside the app's pages (menus, native dialogs).

## Exporting to Playwright (1.1)

```sh
eab export login.flow.yaml --playwright --out login.spec.ts
```

The flow becomes a Playwright test for Electron (`_electron.launch`) that runs without the bridge:
locators map to `getByRole`/`getByText`/`locator`, checks to web-first assertions (`toBeVisible`,
`toHaveURL`…), menus, dialog stubs and window steps to `app.evaluate`. A flow that connects to a
running app is launched from `EAB_EXECUTABLE` and `EAB_ARGS` (a JSON array). What only the bridge can
do — IPC and store checks, refs, `continueOnError`, stub counts — becomes a comment and a warning.
From code: `toPlaywright(flow)` returns `{ code, warnings }`.
