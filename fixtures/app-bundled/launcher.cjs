'use strict';
// Runs the bundle the test built (dist/inlined.cjs or dist/external.cjs); nothing else is loaded first.
require(`./dist/${process.env.FIXTURE_VARIANT || 'inlined'}.cjs`);
