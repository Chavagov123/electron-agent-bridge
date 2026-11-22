# Coding guidelines

These rules apply to every package. Lint, type-check and dependency-cruiser enforce most of them; reviews enforce the rest.

## Architecture
- **Ports and adapters.** Business logic depends on interfaces (ports) defined next to the code that uses them.
  Concrete adapters (Electron, sockets, file system, CDP transports) live at the edges.
- **Composition roots construct; nothing else does.** Only `electron/runtime/composition-root.ts`,
  `client/api/{connect,launch}.ts` and `mcp/server.ts` call `new` on adapters. Everything else receives
  collaborators through its constructor or function parameters.
- **Dependency direction** is fixed (docs/architecture.md) and checked by `pnpm boundaries`. `engine` never imports Electron,
  Node built-ins or socket libraries; `mcp` reaches apps only through `BridgeApi`.
- **SOLID.** One reason to change per module. Extend through new adapters, not flags on existing ones. Small,
  role-specific interfaces. Substitutable implementations (every port has a fake for tests).

## Size and shape
- Modules ≤ 300 lines (lint). Functions should stay around 40 lines; split before adding a comment that says "step 2".
- At most 4 positional parameters (lint); use an options object beyond that.
- No default exports (lint). Named exports only.
- No module-level mutable state, except registries keyed by `Symbol.for('electron-agent-bridge.v1.*')` that must be
  shared across bundle copies.
- Prefer pure functions for serialization, diffing, redaction and budgeting; they are the easiest code to test.

## Errors and results
- Throw `BridgeError` with a stable `ErrorCode` and a hint. Never throw bare strings; never encode errors in messages
  that callers must parse.
- Results that are partial carry `limitations[]`. Never silently truncate.
- Every buffer, snapshot and output is bounded and counts what it dropped.

## Host safety (never break the app)
- Every hook calls the original, preserves `this`, arity, return value and thrown error, and can be removed.
- Every hook installation is wrapped so a failure to observe never costs the app the thing being observed.
- **Never await debugger commands before the first navigation** of a webContents (ADR-0002): post them.
- Observe crashes with `uncaughtExceptionMonitor` and `process.on('warning')`; never add `uncaughtException` or
  `unhandledRejection` listeners (ADR-0009).
- Nothing runs, listens or writes files unless the bridge is explicitly enabled.

## Generality
- No application names, selectors, channel names, routes or store shapes anywhere in package source.
  App-specific behaviour arrives through adapters and configuration.

## TypeScript
- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` are on. Do not weaken them.
- `unknown` at boundaries, validated with Zod schemas from `@eab/core`. No `any` outside narrowly commented adapters.
- Public exports carry TSDoc.

## Tests
- Unit tests sit next to the code as `*.test.ts` and use fakes for ports.
- E2E specs live in `e2e/specs/*.e2e.ts` and drive real Electron fixtures; no fixed sleeps, only condition waits.
- A bug fix starts with a failing test.

## Workflow
- Conventional commits, each one focused change.
- Before a pull request: `pnpm check` and the e2e suite green, a changeset for anything users notice, and
  docs updated with the behaviour they describe.
