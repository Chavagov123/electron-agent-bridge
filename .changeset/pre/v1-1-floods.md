---
'@eab/engine': minor
'@eab/electron': minor
---

Lighter under floods: log entries are sized without serializing them, URLs with nothing to redact are
not parsed, and plain console calls skip the schema walk. Each page's console is recorded at up to
1,000 messages per second (bursts of 2,000); what goes over is counted and reported. Every fixture
can measure the main event-loop delay; the perf spec now covers IPC and console floods.
