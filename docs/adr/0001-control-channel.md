# ADR-0001: Control channel = NDJSON JSON-RPC over named pipe / Unix socket + token

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s11-pipe` (Windows, Electron 35.7.5 and 45.0.0)

## Context
Clients (MCP server, CLI, programmatic API) must reach the in-app runtime. NFR1 originally said "loopback port".
Pipes and Unix sockets are not reachable from web pages (no DNS-rebinding / CORS attack class) and need no
dependency in the app's main process.

## Decision
NDJSON JSON-RPC 2.0 over a Windows named pipe (`\\.\pipe\eab-<pid>-<random>`) or a Unix domain socket (short name,
`$XDG_RUNTIME_DIR`, else `os.tmpdir()`), with a per-session 256-bit token compared in constant time in the first
frame. Loopback TCP stays as a flagged fallback. Trust boundary: the same OS user.

## Measurements (10k round trips, 2 KB payload, client in plain Node)
| Electron | p50 | p95 | p99 | wrong token |
|---|---|---|---|---|
| 35 | 0.10 ms | 0.18 ms | 0.31 ms | rejected |
| 45 | 0.07 ms | 0.14 ms | 0.27 ms | rejected |

## Consequences
- Far below the 2 ms budget; the channel is never the bottleneck.
- Pipe paths are built in code, never through shell strings (backslash mangling seen during the spike).
- macOS/Linux Unix-socket behaviour is still to be confirmed in CI.
