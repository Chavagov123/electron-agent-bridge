---
'@electron-agent-bridge/core': minor
'@electron-agent-bridge/engine': minor
'@electron-agent-bridge/electron': minor
---

Workers, service workers and cross-site iframes: the runtime auto-attaches to their sessions and records
their console output and requests (ids like `wc3:w1`). Workers and service workers are listed by
`targets` as kinds `worker` and `serviceWorker`; page tools refuse them with `UNSUPPORTED`.
