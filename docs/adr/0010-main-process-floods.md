# ADR-0010: Floods — no utilityProcess offload; cheaper per-event work and a console rate cap

- Status: accepted
- Date: 2026-11-18
- Evidence: `e2e/specs/perf.e2e.ts` (floods), Electron 45 on Windows; a no-op-listener spike

## Context
The v1.1 roadmap listed "utilityProcess offload" of the bridge's work, to be done only if measurements asked
for it. The flood spec drives 3 × 5,000 IPC messages and 3 × 8,000 console lines with everything
recording and a reader paging, and compares the app's main event-loop delay with the bridge off.

## Measurements (p99 of the main event loop, ms; one long stall dominates)
| | bridge off | bridge on (v1.1 start) | after per-event cuts | after the console cap |
|---|---|---|---|---|
| IPC flood | 61–115 | 205 | 102–144 | 112 |
| console flood | 133–164 | 611–672 | 444–611 | 378 |

A spike with only a no-op `debugger.on('message')` listener and `Runtime` enabled adds ~170 ms to the
console flood (235 vs 64): Electron delivering 24,000 CDP events into the main process costs that much
by itself.

## Decision
- **No utilityProcess offload.** With the in-process debugger every CDP event arrives in main
  whatever we do with it; forwarding each to a utility process would add a structured clone per event
  to save about as much. The floor cannot be moved off main this way.
- **Cut the per-event cost instead** (done): log entries are sized from their string lengths instead
  of serializing each (the log book went from 119 to 31 ms per 24,000 entries), URLs without a query
  or credentials skip parsing, plain console calls skip the schema walk, and the replay key is short.
- **Cap the console rate per page**: 1,000 messages per second with bursts of 2,000 (a replay of the
  stored messages fits). Messages over the cap are counted, not processed; the next recorded message
  is preceded by a `Console flood: N message(s) … were not recorded` entry, and `logs.query` reports
  the count as a `dropped` limitation. Exceptions are never capped.

## Consequences
- A page that floods its console loses messages beyond the cap, and says so.
- The flood spec gates on the bridge's added delay with a generous ceiling (single stalls are noisy)
  and prints the numbers; the remaining cost is mostly Electron's event delivery.
- Snapshot payloads stay parsed in main: snapshots are already computed in the page and the main loop
  p99 during them is ~15 ms (perf spec), so a raw pass-through would not be measurable.
