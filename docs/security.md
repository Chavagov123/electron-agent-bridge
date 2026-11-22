# Security model

electron-agent-bridge gives an automated agent the ability to read and drive a running Electron app.
That is powerful by design, so the bridge is **off unless explicitly enabled** and every capability is
bounded. This document is the threat model; the disclosure policy is in [SECURITY.md](../SECURITY.md).

## Trust boundary

**The trust boundary is the local OS user.** Anything that runs as the same user can already read
the app's memory, files and environment, so the bridge does not try to defend against it. The bridge
defends against:

- other local users (shared machines, CI runners, terminal servers);
- web content inside the app (pages, iframes, `<webview>` guests), which is untrusted input;
- mistakes: enabling the bridge in production, leaking tokens into logs or child processes, agents
  stepping on each other.

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| Session token | Handshake file, runtime memory, `EAB_TOKEN` (Launch mode) | Random 256-bit, owner-only file, timing-safe compare, removed from `process.env` after start |
| Control endpoint | Named pipe (Windows) / Unix socket (POSIX) | Random name, owner-only directory, token required within 5 s, max 8 connections |
| App data seen by the bridge | Snapshots, IPC, logs, network metadata, state, main-eval results | Bounded, redacted by default, never written to the audit log |
| Audit log | `<endpoint dir>/audit-<pid>.jsonl` | Owner-only, metadata only (method, outcome, timing, client name), size-capped |

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Bridge enabled in a shipped app | Double gate: `EAB_ENABLE=1` **and** (unpackaged **or** `allowPackaged` in code); kill switch `EAB_DISABLE=1`; when off, nothing is hooked, listened on or written | P2 ✔ (e2e: gate off ⇒ no dir/file/socket) |
| T2 | Another user connects to the endpoint | POSIX: per-user dir (`$XDG_RUNTIME_DIR` or `<tmp>/eab-bridge-<uid>`), verified owner/0700/no symlink; socket 0600. Windows: per-user temp ACLs, unguessable pipe name. Token required regardless | P2–P3 ✔ |
| T3 | Another user plants a handshake to redirect a client to their socket | Clients only trust handshake files that are owner-only, owned by the current user, not symlinks, in a private directory, and whose pid matches the file name | P2 ✔ (POSIX tests) |
| T4 | Token leaks through the environment to child processes | `EAB_TOKEN` deleted from `process.env` as soon as it is read | P4 ✔ (e2e) |
| T5 | Token written through a pre-placed file or symlink | Handshake written via exclusive create (`wx`) of a fresh temp file, then atomic rename; custom `EAB_HANDSHAKE` directories must be private | P4 ✔ |
| T6 | Brute force / slowloris on the endpoint | Auth deadline 5 s, connection cap, 8 MB line cap, constant-time token compare, hang-up on failed auth | P2 ✔ |
| T7 | Client/runtime version skew causes misbehaviour | Protocol version negotiated at auth; incompatible ⇒ `VERSION_MISMATCH` and hang-up; results validated against the protocol table | P2 ✔ |
| T8 | Two agents fight over the app | One controller at a time; others are observers limited to `observe` | P4 ✔ |
| T9 | Over-privileged sessions | Capability tiers `observe` < `interact` < `eval`; app sets the ceiling (default excludes `eval`); clients may ask for less | P2–P4 ✔ |
| T10 | Prompt injection from page content (titles, text, URLs) | Page-authored text is marked `untrusted` and delimited in MCP output; delimiter look-alikes are defanged | P2 ✔, extended per tool |
| T11 | Secrets captured from the app (passwords, tokens in IPC/state) | Password fields redacted in snapshots; IPC records shapes by default; values only for opted-in channels and always passed through `redact` | P2 ✔ (snapshots), P9 ✔ (IPC: e2e, values only for opted-in channels), P11 ✔ (state and main-eval results redacted, e2e) |
| T12 | The bridge breaks the host app | Host-first debugger etiquette (yield + re-attach); wrap-and-delegate hooks that preserve semantics; failures to observe never propagate | P4 ✔ (debugger), P9 ✔ (IPC transparency e2e: identical behaviour digest with the bridge off and on), P10 ✔ (crash transparency e2e: error dialog, app handler and rejection warning identical; loggers wrapped and delegated) |
| T13 | Audit log leaks data | Metadata only; size-capped; owner-only; kept 7 days after the app exits, then swept | P4 ✔ |
| T14 | Denial of service through big or hostile data (huge DOM, shared-reference blow-up, regex) | All captures bounded (lines, bytes, nodes); linear-time glob matching; byte rings with drop counters | P3 ✔ |
| T15 | Launch mode enables the bridge in a production build | A packaged app is refused unless the launcher passes `allowPackaged` (`--allow-packaged`); only the inject honours `EAB_ALLOW_PACKAGED`, so `EAB_ENABLE=1` alone never enables a packaged app that ships `register`. Launching needs NODE_OPTIONS or `--inspect` access, i.e. code execution in the app already | P8 ✔ (e2e) |
| T16 | Launch leftovers: inherited NODE_OPTIONS/EAB_* in the app's children, an open debug port | The inject removes its `--require` and the launch variables from `process.env` once read; the inspector strategy closes the inspector inside the app right after injecting | P8 ✔ (e2e) |
| T17 | Hardened binaries silently ignore injection, so a launch hangs or misreports | Each strategy has a load probe; fused/flag-blocked binaries fail with `LAUNCH_BLOCKED` naming the likely fuse, and every attempt's process tree is killed | P8 ✔ (e2e, fused Electron copy) |
| T18 | A page forges IPC records through the uplink | The uplink channel is reserved and validated (types, sizes, batch cap); records from pages without context isolation are `trust: 'low'`; the preload file is written to the private endpoint directory (0600) | P9 ✔ |
| T19 | Secrets in logs and request URLs (tokens in query strings, logged credentials) | Network: bodies never read, secret-looking query values and URL passwords redacted, data URLs reduced to their type. Logs hold what the app itself printed: kept in memory only (1 MB ring), never in the audit log, returned as untrusted text; the main console can be excluded (`logs.mainConsole: false`) | P10 ✔ (unit + e2e redaction) |
| T21 | An agent gains code execution in the main process | `main.eval` and `dialog.stub` need `eval`; the app sets the ceiling (default `observe` + `interact`); Launch grants it only through the launcher option `allowEval` (honoured by the inject only); MCP `launch` may pass it, or app arguments that open a debugger (`--inspect*`, `--remote-debugging-*`, `--js-flags`), only when the operator started the server with `--allow-eval`; eval tools are not even listed without it; expressions are not audited. Note: MCP `launch` starts the program the agent names, so an MCP host should grant that tool only as far as it would let the agent run programs | P11 ✔ (capability matrix e2e) |
| T22 | Automation leaves the app changed (stubbed dialogs, focus emulation) after the agent is gone | Dialog stubs and focus emulation are undone on `session.reset`, when the controlling client disconnects, and when the bridge stops | P11 ✔ (e2e) |
| T23 | A page tampers with the state registry or the devtools shim to mislead the agent | State is page-derived data: returned as untrusted and redacted; the hook runs before page scripts and only in app top-level frames (never `<webview>` or iframes); the shim is opt-in and never replaces a real extension | P11 ✔ |
| T24 | A runaway `main.eval` freezes the app | Code without `await` runs entirely under a `vm` timeout (default 5 s, max 60 s); a returned promise is awaited within the same limit; results are bounded. Code after an `await` runs on the main event loop and cannot be interrupted (known limitation) | P11 ✔ (e2e: endless loop interrupted, app responsive) |
| T20 | A page floods the logs or network rings to hide its traces or exhaust memory | Byte rings with drop counters reported to readers; text, stacks and URLs clipped; at most 1,000 unfinished requests followed (overflow counted) | P10 ✔ |

## Known limitations

- **Same-user processes are trusted.** Anything running as the same user can read the handshake file
  and connect. This is inherent to local automation tools.
- **Windows named pipes** use Node's default security descriptor; protection relies on the random
  pipe name and the token rather than a custom ACL.
- **`contextIsolation: false` apps**: page scripts share the renderer's privileges; data reported from
  such renderers is marked low-trust (P9).
- **Shared `webContents.debugger` object.** While the bridge holds a page's debugger, the host app's
  `isAttached()` reports `false` and its `detach()` is a no-op (from the app's point of view it is not
  attached), and its `attach()` makes the bridge step aside. But Electron delivers debugger `message`
  events to every listener on that object, so an app that listens for CDP events *without* being
  attached will also see the bridge's traffic.
- **`eval` capability** gives the agent arbitrary code execution in the main process when the app
  grants it. It is never granted by default. Timeouts interrupt synchronous code only between
  JavaScript operations; a blocking native call (a sync dialog that was not stubbed) cannot be interrupted.
- **Redaction is name-based.** Secret-looking keys and query parameters are redacted; a secret stored
  under an innocent name (or inside log text) is not recognised.

## Capabilities

| Capability | Methods |
|---|---|
| `observe` | targets, snapshot, find, screenshot, wait_for, logs, network, ipc, state read, app info |
| `interact` | act, state dispatch, window control, menu click |
| `eval` | main-process evaluation, dialog stubs |

The app's ceiling caps every session; a client may ask for less; observers (a second client while one
controls the app) get `observe` only.

## Reporting

See [SECURITY.md](../SECURITY.md).
