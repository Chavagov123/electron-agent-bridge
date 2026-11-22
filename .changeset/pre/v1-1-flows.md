---
'@eab/core': minor
'@eab/page-agent': minor
'@eab/engine': minor
'@eab/electron': minor
'@eab/client': minor
'@eab/mcp': minor
---

Flow recorder and Playwright export. `record.start` / `record.events` / `record.stop` capture what
users do in the app's pages (clicks, field values, checkbox/select changes, command keys) and what
agents run with `act`, each with a locator that outlives refs; password values are never recorded.
`eab record --out flow.yaml` and the MCP `session` actions `recordStart`/`recordStop` turn that into a
flow. `eab export <flow> --playwright` (or `toPlaywright(flow)`) writes the flow as a Playwright test
for Electron. `stringifyFlow` and `flowFromRecording` are new in `@eab/client`.
