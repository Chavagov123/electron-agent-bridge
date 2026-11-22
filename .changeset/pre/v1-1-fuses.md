---
'@eab/client': minor
'@eab/mcp': minor
---

Launch mode reads the fuses written in the Electron binary before starting it and skips strategies
they block, failing at once with the exact fuses when none can work. `eab doctor <executable>` reports
the fuses, asar packaging and which launch strategies can work. New `readFuses` and
`blockedStrategies` in `@eab/client`.
