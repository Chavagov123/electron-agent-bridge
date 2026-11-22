// Runs in every e2e worker before the specs.
//
// `EAB_E2E_BACKGROUND=1` keeps the test apps' windows off the desktop (fixture-kit). The fixtures read
// `FIXTURE_BACKGROUND`: Launch mode, `eab launch` and the MCP server drop inherited `EAB_*` variables
// on purpose (bridge leftovers), so the switch travels under a name every launch path passes on.
if (process.env['EAB_E2E_BACKGROUND'] === '1') process.env['FIXTURE_BACKGROUND'] = '1';
