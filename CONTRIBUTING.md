# Contributing

Thanks for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). The short version:

1. `pnpm install`, then `pnpm check` must pass (format, lint, typecheck, dependency boundaries, unit tests
   with coverage floors).
2. Behaviour that needs a real Electron is covered by e2e: `EAB_E2E_ELECTRON=35,45 pnpm test:e2e`
   (both modes; set `EAB_E2E_MODES=integrated` to run one). Add `EAB_E2E_BACKGROUND=1` to keep
   working meanwhile: the test apps' windows open off the desktop without taking focus (a few
   `window.control` focus/show checks still bring one forward for a moment).
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
   `docs:`, `test:`…); `pnpm hooks` installs a commit-msg check.
4. Changes users should know about get a changeset: `pnpm changeset`.

Read [docs/coding-guidelines.md](docs/coding-guidelines.md) first. The rules that matter most:

- **Never break the host app.** Every hook wraps and delegates, preserves semantics, is removable, and
  has a transparency test (the app behaves identically with the bridge off and on).
- **Nothing app-specific.** No app names, selectors or channels in the code.
- **Bounded everything.** Buffers, outputs and captured values have caps and report what they dropped.
- **Ports and adapters.** The engine knows no Electron; only composition roots construct adapters.
- **Never await CDP commands before a page's first navigation** (ADR-0002).

Security issues: see [SECURITY.md](SECURITY.md), not public issues.
