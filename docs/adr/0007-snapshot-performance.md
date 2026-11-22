# ADR-0007: Snapshot engine — cached entry tree, O(dirty) deltas, interactables re-read each snapshot

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s7-perf` (4,511-node page, Windows, Electron 35/45, two runs each)

## Measurements (p95)
| | target | Electron 35 | Electron 45 |
|---|---|---|---|
| full snapshot | ≤150 ms | 30–41 ms | 43–48 ms |
| delta, 1 change | ≤20 ms | 6–9 ms | 4–11 ms |
| delta, 100 changes | ≤20 ms | 8–14 ms | 6–16 ms |
| delta equals fresh full | equal | yes | yes |
| main event-loop delay added (mutation storm + pushes) | <10 ms | ≈0 | ≈0 |

## Findings
- A first version that re-flattened and set-diffed every line per delta took 36 ms (100 changes) on 45. Deltas must
  reuse clean subtree entries by reference and only materialize text for full output.
- The baseline delta cost (~4–6 ms) is the per-snapshot re-read of ~1,500 interactables (value + rect).
- Full output of this page is ~60k characters (~15k tokens), so repeated-region trimming and the interactable-only
  default are required.
- Windows timer granularity (~15.6 ms) dominates `monitorEventLoopDelay`; measure event-loop delay relative to an
  idle baseline.
