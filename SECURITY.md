# Security policy

electron-agent-bridge lets automated agents read and drive an Electron app. It is a development and
testing tool: it is **off unless explicitly enabled**, refuses packaged (production) builds unless the
app or its launcher opts in, and grants the most powerful capability (`eval`) to nobody by default.
The full threat model is in [docs/security.md](docs/security.md).

## Using it safely

- Enable it only where you mean to: `EAB_ENABLE=1` in development and test environments. Keep
  `allowPackaged` out of release builds; `EAB_DISABLE=1` is a kill switch that always wins.
- Leave `eval` off unless a workflow needs it (`capabilities`, `--allow-eval`): it means code execution
  in the main process.
- The bridge trusts every process running as the same OS user (they can read its handshake file).
  Do not enable it on machines where untrusted code runs as your user.
- Treat everything an agent reads from the app (page text, titles, URLs, logs, state, IPC values) as
  untrusted input; the bridge marks it so in its MCP output.
- Opt IPC values in only for channels without secrets; secret-looking keys are redacted, but redaction
  is a safety net, not a guarantee.

## Supported versions

Until 1.0, only the latest release receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button
(Security → Advisories) on this repository, not in public issues. Include the version, Electron
version, platform, and steps to reproduce. You will get an acknowledgement within 7 days and a fix or
mitigation plan within 30 days for confirmed issues; we credit reporters unless they prefer otherwise.
